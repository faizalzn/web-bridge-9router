import type { Cookie } from 'playwright-core';

// Minimal Set-Cookie handling so cookies rotated by the provider over plain HTTP
// (e.g. Google's __Secure-1PSIDTS) end up in the saved session.

const stripDot = (d: string) => d.replace(/^\./, '').toLowerCase();

function defaultPath(pathname: string): string {
  const i = pathname.lastIndexOf('/');
  return !pathname.startsWith('/') || i <= 0 ? '/' : pathname.slice(0, i);
}

export function parseSetCookie(
  line: string,
  requestUrl: string,
  nowMs = Date.now(),
): { cookie: Cookie; remove: boolean } | null {
  const parts = line.split(';').map((p) => p.trim());
  const first = parts.shift() ?? '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;

  const url = new URL(requestUrl);
  let domain = url.hostname.toLowerCase();
  let hostOnly = true;
  let path = defaultPath(url.pathname);
  let expires = -1;
  let maxAge: number | null = null;
  let secure = false;
  let httpOnly = false;
  let sameSite: Cookie['sameSite'] = 'Lax';

  for (const attr of parts) {
    const i = attr.indexOf('=');
    const key = (i === -1 ? attr : attr.slice(0, i)).toLowerCase();
    const val = i === -1 ? '' : attr.slice(i + 1).trim();
    switch (key) {
      case 'domain': if (val) { domain = stripDot(val); hostOnly = false; } break;
      case 'path': if (val.startsWith('/')) path = val; break;
      case 'expires': { const t = Date.parse(val); if (!Number.isNaN(t)) expires = t / 1000; break; }
      case 'max-age': { const n = Number(val); if (Number.isFinite(n)) maxAge = n; break; }
      case 'secure': secure = true; break;
      case 'httponly': httpOnly = true; break;
      case 'samesite': {
        const s = val.toLowerCase();
        sameSite = s === 'strict' ? 'Strict' : s === 'none' ? 'None' : 'Lax';
        break;
      }
    }
  }

  if (maxAge !== null) expires = maxAge <= 0 ? 0 : nowMs / 1000 + maxAge;
  const remove = expires !== -1 && expires <= nowMs / 1000;
  return {
    remove,
    cookie: {
      name: first.slice(0, eq).trim(),
      value: first.slice(eq + 1).trim(),
      domain: hostOnly ? domain : `.${domain}`,
      path,
      expires: remove ? -1 : expires,
      httpOnly,
      secure,
      sameSite,
    },
  };
}

/** Applies Set-Cookie lines to a cookie list. `changed` lists names that were added, updated ("-name" = removed). */
export function mergeSetCookies(
  cookies: Cookie[],
  setCookie: string[],
  requestUrl: string,
  nowMs = Date.now(),
): { cookies: Cookie[]; changed: string[] } {
  const out = [...cookies];
  const changed: string[] = [];
  for (const line of setCookie) {
    const parsed = parseSetCookie(line, requestUrl, nowMs);
    if (!parsed) continue;
    const { cookie, remove } = parsed;
    const idx = out.findIndex(
      (c) => c.name === cookie.name && stripDot(c.domain) === stripDot(cookie.domain) && c.path === cookie.path,
    );
    if (remove) {
      if (idx !== -1) { out.splice(idx, 1); changed.push(`-${cookie.name}`); }
    } else if (idx !== -1) {
      const old = out[idx]!;
      if (old.value !== cookie.value || old.expires !== cookie.expires) changed.push(cookie.name);
      out[idx] = { ...old, ...cookie, domain: old.domain };
    } else {
      out.push(cookie);
      changed.push(cookie.name);
    }
  }
  return { cookies: out, changed };
}
