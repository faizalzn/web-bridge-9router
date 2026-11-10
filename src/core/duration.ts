const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * Parses a session retention such as "7d", "12h", "30m" or "forever".
 * Returns milliseconds, or null for "keep forever".
 */
export function parseRetention(value: unknown): number | null {
  const v = String(value ?? 'forever').trim().toLowerCase();
  if (v === '' || v === 'forever' || v === 'never' || v === '0') return null;
  const m = /^(\d+)\s*([mhd])$/.exec(v);
  if (!m) throw new Error(`Invalid retention "${value}". Use forever, 1d, 3d, 7d, 30d (or e.g. 12h)`);
  const ms = Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
  if (ms <= 0) throw new Error(`Invalid retention "${value}"`);
  return ms;
}

export function timeAgo(iso: string | number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
