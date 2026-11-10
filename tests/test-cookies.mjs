import assert from 'node:assert/strict';

const base = new URL('../dist/', import.meta.url).href;
const { parseSetCookie, mergeSetCookies } = await import(base + 'auth/cookies.js');
const { parseRetention } = await import(base + 'core/duration.js');

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const url = 'https://accounts.google.com/RotateCookies';

// attributes
const a = parseSetCookie('__Secure-1PSIDTS=abc=def; Domain=.google.com; Path=/; Expires=Wed, 09 Nov 2027 12:00:00 GMT; Secure; HttpOnly; SameSite=None', url, NOW);
assert.equal(a.cookie.name, '__Secure-1PSIDTS');
assert.equal(a.cookie.value, 'abc=def', 'value keeps "=" characters');
assert.equal(a.cookie.domain, '.google.com');
assert.equal(a.cookie.secure && a.cookie.httpOnly, true);
assert.equal(a.cookie.sameSite, 'None');
assert.equal(a.remove, false);
assert.ok(a.cookie.expires > NOW / 1000);

// host-only cookie, default path from request URL
const h = parseSetCookie('X=1; Secure', 'https://gemini.google.com/_/a/b', NOW);
assert.equal(h.cookie.domain, 'gemini.google.com');
assert.equal(h.cookie.path, '/_/a');

// Max-Age precedence and deletion
assert.equal(parseSetCookie('X=1; Max-Age=60; Expires=Wed, 01 Jan 2020 00:00:00 GMT', url, NOW).remove, false);
assert.equal(parseSetCookie('X=; Max-Age=0', url, NOW).remove, true);
assert.equal(parseSetCookie('X=; Expires=Thu, 01 Jan 1970 00:00:00 GMT', url, NOW).remove, true);
assert.equal(parseSetCookie('garbage', url, NOW), null);

// merge: update, add, remove, keep dot-style of the existing cookie
const jar = [
  { name: 'SID', value: 'old', domain: '.google.com', path: '/', expires: 2e9, httpOnly: true, secure: true, sameSite: 'Lax' },
  { name: 'GONE', value: 'x', domain: '.google.com', path: '/', expires: 2e9, httpOnly: false, secure: true, sameSite: 'Lax' },
];
const r = mergeSetCookies(jar, [
  'SID=new; Domain=google.com; Path=/; Max-Age=3600; Secure',
  'GONE=; Domain=.google.com; Path=/; Max-Age=0',
  'FRESH=1; Domain=.google.com; Path=/; Secure',
], url, NOW);
assert.deepEqual(r.changed.sort(), ['-GONE', 'FRESH', 'SID']);
assert.equal(r.cookies.length, 2);
assert.equal(r.cookies.find((c) => c.name === 'SID').value, 'new');
assert.equal(r.cookies.find((c) => c.name === 'SID').domain, '.google.com');
assert.equal(jar[0].value, 'old', 'input is not mutated');

// same value again = no change reported
assert.deepEqual(mergeSetCookies(r.cookies, ['FRESH=1; Domain=.google.com; Path=/; Secure'], url, NOW).changed, []);

// retention
assert.equal(parseRetention(undefined), null);
assert.equal(parseRetention('forever'), null);
assert.equal(parseRetention('7d'), 7 * 86_400_000);
assert.equal(parseRetention('12h'), 12 * 3_600_000);
assert.throws(() => parseRetention('week'));
assert.throws(() => parseRetention('-1d'));

console.log('all cookie/retention tests passed');
