// How to log in to each web provider, how to tell that the login really works and how to keep it alive.
// In Sprint 6 these move into downloadable manifests so they can be updated without a release.

export interface VerifySpec {
  url: string;
  /** Regex source: the session counts as logged in when the (decoded) response body matches. */
  loggedIn: string;
  headers?: Record<string, string>;
  /**
   * Fetch `url` from inside the provider's own page in the account's browser profile instead of over plain HTTP
   * (for sites behind Cloudflare). Such a login can only be checked when it is held in a browser profile.
   */
  inPage?: boolean;
}

export interface AuthSpec {
  id: string;
  name: string;
  /** Page opened for the user to log in. */
  loginUrl: string;
  /** Page used to verify and refresh an existing session in a browser. */
  homeUrl: string;
  /** Cookie/localStorage domains that belong to this provider (suffix match). */
  domains: string[];
  /** Logged in when all of these cookies exist. A trailing "*" matches a prefix (chunked cookies). */
  cookies?: string[];
  /** Logged in when all of these localStorage keys exist on `origin`. */
  localStorage?: { origin: string; keys: string[] };
  /**
   * Real login check over plain HTTP. Cookie presence alone is not enough: providers rotate
   * and invalidate cookies server-side. Without it, a session can only be reported as "unverified".
   */
  verify?: VerifySpec;
  /** Background rotation that keeps copied cookies alive while the gateway runs. */
  keepAlive?: { kind: 'google-rotate' };
}

export const AUTH_SPECS: Record<string, AuthSpec> = {
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    loginUrl: 'https://gemini.google.com/app',
    homeUrl: 'https://gemini.google.com/app',
    domains: ['google.com'],
    cookies: ['__Secure-1PSID'],
    // The page only embeds the SNlM0e request token for logged-in users.
    verify: { url: 'https://gemini.google.com/app', loggedIn: '"SNlM0e":"[^"]+"' },
    keepAlive: { kind: 'google-rotate' },
  },
  claude: {
    id: 'claude',
    name: 'Claude.ai',
    loginUrl: 'https://claude.ai/login',
    homeUrl: 'https://claude.ai/new',
    domains: ['claude.ai'],
    cookies: ['sessionKey'],
    // The page's own API lists the account's organizations only for a logged-in user.
    verify: { url: 'https://claude.ai/api/organizations', loggedIn: '"uuid"\\s*:\\s*"[0-9a-f-]{36}"', inPage: true },
  },
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    loginUrl: 'https://chatgpt.com/auth/login',
    homeUrl: 'https://chatgpt.com/',
    domains: ['chatgpt.com', 'openai.com'],
    cookies: ['__Secure-next-auth.session-token*'],
    // verify: added together with the ChatGPT adapter (Sprint 5)
  },
};

export function getAuthSpec(id: string): AuthSpec {
  const spec = AUTH_SPECS[id];
  if (!spec) throw new Error(`Unknown provider "${id}". Available: ${Object.keys(AUTH_SPECS).join(', ')}`);
  return spec;
}

export function domainMatches(cookieDomain: string, spec: AuthSpec): boolean {
  const d = cookieDomain.replace(/^\./, '').toLowerCase();
  return spec.domains.some((s) => d === s || d.endsWith(`.${s}`));
}

export function originMatches(origin: string, spec: AuthSpec): boolean {
  try { return domainMatches(new URL(origin).hostname, spec); } catch { return false; }
}

export function cookieNameMatches(pattern: string, name: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}
