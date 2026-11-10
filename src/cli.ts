#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { importSession, interactiveLogin, logout } from './auth/login.ts';
import { SessionService } from './auth/session-service.ts';
import { browserLoginCheck } from './browser/held-check.ts';
import { browserCandidates, heldProfileDir } from './browser/launcher.ts';
import { findBrowsers, readProfileOwner } from './browser/detect.ts';
import { BrowserManager } from './browser/manager.ts';
import {
  DEFAULT_ACCOUNT, hasLoginCookies, sessionExpiry, sessionState, SessionStore, validateAccountName,
} from './auth/session-store.ts';
import { AUTH_SPECS, getAuthSpec, type AuthSpec } from './auth/specs.ts';
import { DEFAULT_CONFIG_FILE, loadConfig, type Config } from './core/config.ts';
import { parseRetention, timeAgo } from './core/duration.ts';
import { acquireGatewayLock, runningGatewayPid } from './core/lock.ts';
import { logger, setLogLevel } from './core/logger.ts';
import { createRegistry } from './providers/registry.ts';
import { startServer } from './server/http.ts';
import { VERSION } from './version.ts';

const HELP = `web-bridge-9router v${VERSION}

Usage: bridge <command> [options]

  "bridge" not recognized? Run "npm link" once in the project folder,
  or use "node dist/cli.js <command>" instead (e.g. node dist/cli.js login gemini).

Commands:
  init               Create config.yaml with a random API key
  start              Start the gateway server
  status             Show status of a running gateway
  models             List available model ids
  login [provider]   Log in through your browser (lists providers when omitted)
  logout <provider>  Remove a provider session
  sessions           List saved sessions
  check <provider>   Ask the provider whether the saved login still works and refresh its cookies
  browsers           List the browsers found on this computer and which one the gateway uses
  update             Update provider manifests     (coming in Sprint 6)
  gui <install|uninstall|enable>                   (coming in Sprint 7)
  version            Print version

Options:
  -c, --config <path>   Config file (default: ./config.yaml, env BRIDGE_CONFIG)
  -p, --port <port>     Override server port
      --host <host>     Override server host
  -a, --account <name>  login/logout/check: which account (default: "default"); use to add more accounts
  -f, --force           init: overwrite config.yaml; login: log in again even if a valid session exists
      --keep <time>     login: delete the saved session after this time: 1d, 3d, 7d, 30d or forever
                        (default: session.retention in config.yaml, which defaults to forever)
      --import <file>   login: import exported cookies (Cookie-Editor JSON) instead of opening a browser
      --user-agent <ua> login --import: User-Agent of the browser the cookies came from
  -h, --help            Show this help
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', short: 'c' },
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    force: { type: 'boolean', short: 'f' },
    account: { type: 'string', short: 'a' },
    keep: { type: 'string' },
    import: { type: 'string' },
    'user-agent': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

function load(): Config {
  const config = loadConfig(opts.config);
  if (opts.port) config.server.port = Number(opts.port);
  if (opts.host) config.server.host = opts.host;
  setLogLevel(config.logLevel);
  return config;
}

async function cmdInit(): Promise<void> {
  const target = resolve(opts.config ?? DEFAULT_CONFIG_FILE);
  if (existsSync(target) && !opts.force) throw new Error(`${target} already exists (use --force to overwrite)`);
  const template = readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8');
  const key = `wb-${randomBytes(24).toString('base64url')}`;
  writeFileSync(target, template.replace(/api_key:.*$/m, `api_key: "${key}"`));
  console.log(`Created ${target}\nAPI key: ${key}\nUse this key as the provider API key in 9router.`);
}

async function cmdStart(): Promise<void> {
  const config = load();
  acquireGatewayLock(config.dataDir);
  const sessions = new SessionService(new SessionStore(config.dataDir), config.session);
  // One browser for the whole gateway: a held login's profile can only be opened by one browser at a time.
  const browser = new BrowserManager(config);
  sessions.setBrowserCheck(browserLoginCheck(browser));
  const registry = createRegistry(config, { config, sessions, browser });
  const server = await startServer(config, registry, sessions);
  const stopKeepAlive = sessions.startKeepAlive();
  const base = `http://${config.server.host}:${config.server.port}`;

  logger.info(`web-bridge-9router v${VERSION} listening on ${base}`);
  logger.info(config.path ? `Config: ${config.path}` : 'Config: built-in defaults (run "bridge init" to create config.yaml)');
  if (!config.server.apiKey) logger.warn('No api_key set: API authentication is disabled');
  logger.info(`OpenAI-compatible:    ${base}/v1`);
  logger.info(`Anthropic-compatible: ${base}`);
  logger.info(`Models: ${registry.models().map((m) => m.id).join(', ') || '(none enabled)'}`);
  const saved = sessions.states().map((s) => `${s.provider}${s.account === DEFAULT_ACCOUNT ? '' : `@${s.account}`}`);
  logger.info(`Saved logins: ${saved.join(', ') || '(none)'}`);
  logger.info(config.session.keepAlive
    ? `Session keep-alive: every ${Math.round(config.session.keepAliveInterval / 60)} min`
    : 'Session keep-alive: off (logins may go stale)');

  const shutdown = () => {
    logger.info('Shutting down...');
    stopKeepAlive();
    server.close();
    setTimeout(() => process.exit(0), 8000).unref();
    void registry.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdStatus(): Promise<void> {
  const config = load();
  const url = `http://${config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host}:${config.server.port}/health`;
  let data: any;
  try {
    data = await (await fetch(url, { signal: AbortSignal.timeout(3000) })).json();
  } catch {
    throw new Error(`Gateway is not running at ${url}`);
  }
  console.log(`Gateway v${data.version} running at ${url.replace('/health', '')}\n`);
  for (const p of data.providers) {
    const state = p.loggedIn ? 'logged in' : 'logged out';
    console.log(`  ${p.id.padEnd(12)} ${state.padEnd(11)} mode ${p.mode ?? '-'}  ${p.detail ?? ''}`);
  }
}

function requireProvider(): AuthSpec {
  const id = positionals[1];
  if (!id) throw new Error(`Missing provider. Available: ${Object.keys(AUTH_SPECS).join(', ')}`);
  return getAuthSpec(id);
}

const fmtDate = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : 'browser session');
const account = () => validateAccountName(opts.account ?? DEFAULT_ACCOUNT);
const accountFlag = (a: string) => (a === DEFAULT_ACCOUNT ? '' : ` --account ${a}`);

async function cmdLogin(): Promise<void> {
  if (!positionals[1]) {
    console.log('Usage: bridge login <provider> [--account <name>] [--force]\n\nProviders:');
    for (const s of Object.values(AUTH_SPECS)) console.log(`  ${s.id.padEnd(10)} ${s.name}`);
    return;
  }
  const spec = requireProvider();
  const acc = account();
  const config = load();
  const store = new SessionStore(config.dataDir);
  const service = new SessionService(store, config.session);
  const retention = opts.keep !== undefined ? parseRetention(opts.keep) : config.session.retention;
  const keepUntil = retention === null ? null : Date.now() + retention;

  const existing = service.get(spec.id, acc);
  // A session the provider already rejected must never block a new login.
  if (existing && sessionState(spec, existing) !== 'dead' && hasLoginCookies(spec, existing) && !opts.force && !opts.import) {
    const others = store.list(spec.id).filter((s) => s.account !== acc).map((s) => s.account);
    console.log(`Already logged in to ${spec.name} as account "${acc}" (logged in ${timeAgo(existing.createdAt ?? existing.savedAt)}).`);
    console.log(`  Verify it with the provider:  bridge check ${spec.id}${accountFlag(acc)}`);
    console.log(`  Log in again / switch user:  bridge login ${spec.id}${accountFlag(acc)} --force`);
    console.log(`  Add another account:         bridge login ${spec.id} --account <name>`);
    if (others.length) console.log(`  Other saved accounts: ${others.join(', ')}`);
    return;
  }

  const holding = config.session.holdInBrowser && !opts.import;
  const gateway = runningGatewayPid(config.dataDir);
  if (holding && gateway) {
    throw new Error(`A gateway (process ${gateway}) is running and may have this account's browser profile open. `
      + 'Stop it first (Ctrl+C in its terminal), log in, then start it again.');
  }

  const session = opts.import
    ? importSession(spec, acc, opts.import, opts['user-agent'] ?? '', store, keepUntil)
    : await interactiveLogin(spec, acc, config, store, keepUntil);

  console.log(opts.import
    ? `\n✔ Imported ${spec.name} session (saved encrypted).`
    : `\n✔ Logged in to ${spec.name}. Session saved (encrypted) and the browser was closed.`);
  console.log(`  Cookies: ${session.cookies.length}, kept: ${keepUntil ? `until ${new Date(keepUntil).toLocaleString()}` : 'forever'}`);
  if (opts.import && !session.userAgent) {
    console.log('  Tip: pass --user-agent "<your browser UA>" so requests match the browser the cookies came from.');
  }

  // Prove that the provider really accepts the session instead of trusting that cookies exist.
  if (session.held) console.log(`  The login stays in the gateway's own browser profile: ${heldProfileDir(config.dataDir, spec.id, acc)}`);
  if (spec.verify) {
    const browser = new BrowserManager(config);
    service.setBrowserCheck(browserLoginCheck(browser));
    if (session.held) console.log('  Checking the login in that profile (takes a few seconds)...');
    const r = await service.refresh(spec, acc, { rotate: false, verify: true }).finally(() => browser.close());
    console.log(r.ok === true ? `  ✔ Verified with ${spec.name}: the login works.`
      : r.ok === false ? `  ✘ ${spec.name} does not accept this session yet. Try again, or use --import. (${r.detail})`
      : `  ? Could not verify right now (${r.detail}). Run "bridge check ${spec.id}${accountFlag(acc)}" later.`);
    if (r.ok === false) process.exitCode = 1;
  } else {
    console.log(`  Note: a login check for ${spec.name} arrives with its adapter, so this session is not verified yet.`);
  }
  if (spec.keepAlive) console.log('  Keep "bridge start" running: it refreshes the cookies in the background so the login does not go stale.');
}

async function cmdLogout(): Promise<void> {
  const spec = requireProvider();
  const acc = account();
  const config = load();
  const removed = await logout(spec, acc, config, new SessionStore(config.dataDir));
  console.log(removed
    ? `Logged out of ${spec.name} (account "${acc}").`
    : `No saved session for ${spec.name} account "${acc}"; login-browser cookies were cleared anyway.`);
}

function cmdSessions(): void {
  const config = load();
  const service = new SessionService(new SessionStore(config.dataDir), config.session);
  const rows = service.states();
  if (!rows.length) { console.log('No sessions yet. Run "bridge login <provider>".'); return; }
  const label = { ok: 'works', dead: 'EXPIRED', unverified: 'unverified', 'no-cookies': 'logged out' } as const;
  console.log('  PROVIDER   ACCOUNT        STATUS                    LOGGED IN      KEPT UNTIL');
  for (const r of rows) {
    const checked = r.lastCheck ? ` (${timeAgo(r.lastCheck.checkedAt)})` : '';
    console.log(
      `  ${r.provider.padEnd(10)} ${r.account.padEnd(14)} ${(label[r.state] + checked).padEnd(25)} `
      + `${(r.createdAt ? timeAgo(r.createdAt) : '-').padEnd(14)} ${r.keepUntil ? new Date(r.keepUntil).toLocaleString() : 'forever'}`,
    );
  }
  if (rows.some((r) => r.state === 'dead')) console.log('\n  EXPIRED = the provider rejected the session. Run: bridge login <provider> --force');
  if (rows.some((r) => r.state === 'unverified')) console.log('\n  unverified = not checked yet. Run: bridge check <provider>');
}

async function cmdCheck(): Promise<void> {
  const spec = requireProvider();
  const acc = account();
  const config = load();
  const service = new SessionService(new SessionStore(config.dataDir), config.session);
  const session = service.get(spec.id, acc);
  if (!session) throw new Error(`No session for ${spec.id} (account "${acc}"). Run "bridge login ${spec.id}${accountFlag(acc)}" first.`);

  const gateway = runningGatewayPid(config.dataDir);
  if (gateway) {
    // The running gateway already refreshes and checks this login. A second process doing the same
    // would overwrite its cookies and make Google reject the session.
    console.log(`A gateway (process ${gateway}) is running and keeps this login fresh, so it is not touched from here.`);
    console.log('Its last real check is shown by "bridge sessions".');
    return;
  }

  if (!spec.verify) {
    console.log(`? ${spec.name}: login cookies are ${hasLoginCookies(spec, session) ? 'present' : 'missing'}, `
      + 'but the provider cannot be asked yet (its adapter is not available), so this is NOT a real check.');
    console.log(`  Cookies valid until: ${fmtDate(sessionExpiry(spec, session))} (as far as the cookie itself says)`);
    return;
  }

  console.log(`Asking ${spec.name} whether account "${acc}" is still logged in${session.held ? ' (in its browser profile)' : ''}...`);
  const browser = new BrowserManager(config);
  service.setBrowserCheck(browserLoginCheck(browser));
  const r = await service.refresh(spec, acc, { rotate: true, verify: true }).finally(() => browser.close());
  if (r.ok === true) console.log(`✔ Logged in: ${spec.name} accepts this session (${r.ms}ms). ${r.detail}`);
  else if (r.ok === false) console.log(`✘ Not logged in: ${spec.name} rejected this session. Run "bridge login ${spec.id}${accountFlag(acc)} --force". ${r.detail}`);
  else console.log(`? Could not tell: ${r.detail}`);
  if (r.ok !== true) process.exitCode = 1;
}

function cmdModels(): void {
  const config = load();
  const sessions = new SessionService(new SessionStore(config.dataDir), config.session);
  for (const m of createRegistry(config, { config, sessions }).models()) console.log(`${m.id.padEnd(28)} ${m.name ?? ''}`);
}

function cmdBrowsers(): void {
  const config = load();
  const found = findBrowsers();
  const chosen = browserCandidates(config.browser, found);
  const setting = config.browser.executablePath ? `executable_path: ${config.browser.executablePath}` : `channel: ${config.browser.channel}`;
  console.log(`Browsers found on this computer (${process.platform}):`);
  if (!found.length) console.log('  (none in the usual places)');
  for (const b of found) {
    const used = chosen[0]?.executablePath === b.path;
    console.log(`  ${used ? '*' : ' '} ${b.name.padEnd(16)} ${b.path}`);
  }
  console.log(chosen.length
    ? `\nThe gateway uses: ${chosen[0]!.name}${chosen[0]!.channel ? ' (located by Playwright)' : ''}  [browser.${setting}]`
    : `\nNo usable browser for browser.${setting}. Install one of: Microsoft Edge, Google Chrome, Chromium, Brave, Vivaldi, or set browser.executable_path.`);

  const dir = join(config.dataDir, 'profiles');
  const profiles = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  if (profiles.length) {
    console.log('\nLogin profiles (a profile only works with the browser that made it):');
    for (const p of profiles) {
      const owner = readProfileOwner(join(dir, p));
      console.log(`  ${p.padEnd(24)} ${owner ? owner.name : 'not recorded yet (recorded on its next use)'}`);
    }
  }
  console.log('\nSupported: Chromium-based browsers (Edge, Chrome, Chromium, Brave, Vivaldi). Firefox and Safari are not:'
    + '\nPlaywright can only drive its own builds of them, not the ones installed on the computer.');
}

async function main(): Promise<void> {
  const cmd = opts.help ? 'help' : (positionals[0] ?? 'help');
  switch (cmd) {
    case 'init': return cmdInit();
    case 'start': return cmdStart();
    case 'status': return cmdStatus();
    case 'models': return cmdModels();
    case 'version': console.log(VERSION); return;
    case 'help': console.log(HELP); return;
    case 'login': return cmdLogin();
    case 'logout': return cmdLogout();
    case 'sessions': return cmdSessions();
    case 'check': return cmdCheck();
    case 'browsers': return cmdBrowsers();
    case 'update': case 'gui':
      console.log(`"${cmd}" is not available yet. See the roadmap in README.md.`);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
