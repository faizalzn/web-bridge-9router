import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { parseRetention } from './duration.ts';
import { isLogLevel, type LogLevel } from './logger.ts';

export interface ProviderConfig { enabled: boolean; [key: string]: unknown }

export type BrowserChannel = 'auto' | 'msedge' | 'chrome' | 'chromium' | 'brave' | 'vivaldi';
export type BlockableResource = 'image' | 'font' | 'media' | 'stylesheet';

export interface BrowserConfig {
  channel: BrowserChannel;
  /** Custom browser executable; overrides `channel` when set. */
  executablePath: string;
  /** Seconds an idle headless browser stays open before it is closed. */
  idleTimeout: number;
  /** Resource types that are never downloaded inside the headless browser. */
  blockResources: BlockableResource[];
  /** Run the browser that holds a login without a window (true) or as an off-screen window (false). */
  heldHeadless: boolean;
}

export interface SessionConfig {
  /** Rotate cookies in the background while the gateway runs, so logins do not go stale. */
  keepAlive: boolean;
  /** Seconds between keep-alive passes. */
  keepAliveInterval: number;
  /** Milliseconds a session is kept after login, or null for forever. */
  retention: number | null;
  /** New logins stay in the gateway's own browser profile, which then serves requests and keep-alive. */
  holdInBrowser: boolean;
}

export interface Config {
  server: { host: string; port: number; apiKey: string };
  session: SessionConfig;
  logLevel: LogLevel;
  /** Absolute directory for sessions, encryption key and browser profile. */
  dataDir: string;
  browser: BrowserConfig;
  providers: Record<string, ProviderConfig>;
  /** Absolute path of the loaded file, or null when running on defaults. */
  path: string | null;
}

export const DEFAULT_CONFIG_FILE = 'config.yaml';

export function loadConfig(explicitPath?: string): Config {
  const path = resolve(explicitPath ?? process.env.BRIDGE_CONFIG ?? DEFAULT_CONFIG_FILE);
  let raw: any = {};
  let loadedFrom: string | null = null;

  if (existsSync(path)) {
    try {
      raw = parse(readFileSync(path, 'utf8')) ?? {};
    } catch (err) {
      throw new Error(`Invalid YAML in ${path}: ${(err as Error).message}`);
    }
    loadedFrom = path;
  } else if (explicitPath) {
    throw new Error(`Config file not found: ${path}`);
  }

  const port = Number(process.env.BRIDGE_PORT ?? raw.server?.port ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid server.port: ${port}`);

  const logLevel = raw.log_level ?? 'info';
  if (!isLogLevel(logLevel)) throw new Error(`Invalid log_level: ${logLevel}`);

  const providers: Record<string, ProviderConfig> = {};
  for (const [id, value] of Object.entries<any>(raw.providers ?? { echo: { enabled: true } })) {
    providers[id] = { ...(value ?? {}), enabled: value?.enabled !== false };
  }

  const channel = raw.browser?.channel ?? 'auto';
  if (!['auto', 'msedge', 'chrome', 'chromium', 'brave', 'vivaldi'].includes(channel)) {
    throw new Error(`Invalid browser.channel: ${channel} (auto | msedge | chrome | chromium | brave | vivaldi)`);
  }
  const idleTimeout = Number(raw.browser?.idle_timeout ?? 300);
  if (!Number.isFinite(idleTimeout) || idleTimeout < 10) throw new Error('browser.idle_timeout must be >= 10 seconds');
  const blockResources = raw.browser?.block_resources ?? ['image', 'font', 'media'];
  for (const r of blockResources) {
    if (!['image', 'font', 'media', 'stylesheet'].includes(r)) throw new Error(`Invalid browser.block_resources entry: ${r}`);
  }

  const keepAliveInterval = Number(process.env.BRIDGE_KEEP_ALIVE_INTERVAL ?? raw.session?.keep_alive_interval ?? 540);
  if (!Number.isFinite(keepAliveInterval) || keepAliveInterval < 30) throw new Error('session.keep_alive_interval must be >= 30 seconds');

  // Relative data_dir is resolved next to the config file, so running from another folder still works.
  const baseDir = loadedFrom ? dirname(loadedFrom) : process.cwd();

  return {
    dataDir: resolve(baseDir, String(process.env.BRIDGE_DATA_DIR ?? raw.data_dir ?? 'data')),
    browser: {
      channel,
      executablePath: String(raw.browser?.executable_path ?? ''),
      idleTimeout,
      blockResources,
      heldHeadless: raw.browser?.held_headless !== false,
    },
    session: {
      keepAlive: raw.session?.keep_alive !== false,
      keepAliveInterval,
      retention: parseRetention(raw.session?.retention),
      holdInBrowser: raw.session?.hold_in_browser !== false,
    },
    server: {
      host: String(process.env.BRIDGE_HOST ?? raw.server?.host ?? '127.0.0.1'),
      port,
      apiKey: String(process.env.BRIDGE_API_KEY ?? raw.server?.api_key ?? ''),
    },
    logLevel,
    providers,
    path: loadedFrom,
  };
}
