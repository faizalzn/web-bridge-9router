const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;
export const isLogLevel = (v: unknown): v is LogLevel => typeof v === 'string' && v in LEVELS;

let current: LogLevel = 'info';
export function setLogLevel(level: LogLevel): void { current = level; }

/** Local time with its UTC offset, e.g. 2026-11-09 13:53:23.988 +07:00 (an ISO string in UTC is hard to compare with the clock on the wall). */
function stamp(d: Date): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, '0');
  const east = -d.getTimezoneOffset(); // minutes east of UTC
  const abs = Math.abs(east);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    + '.' + p(d.getMilliseconds(), 3) + ' ' + (east >= 0 ? '+' : '-') + p(Math.floor(abs / 60)) + ':' + p(abs % 60);
}

function log(level: LogLevel, msg: string, extra?: unknown): void {
  if (LEVELS[level] < LEVELS[current]) return;
  const line = `${stamp(new Date())} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const out = level === 'warn' || level === 'error' ? console.error : console.log;
  if (extra === undefined) out(line); else out(line, extra);
}

export const logger = {
  debug: (m: string, e?: unknown) => log('debug', m, e),
  info: (m: string, e?: unknown) => log('info', m, e),
  warn: (m: string, e?: unknown) => log('warn', m, e),
  error: (m: string, e?: unknown) => log('error', m, e),
};
