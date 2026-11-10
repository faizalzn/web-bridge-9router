import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Sessions are encrypted with AES-256-GCM using a random key stored in <data_dir>/.key.
// This keeps session files unreadable on their own (e.g. if copied or synced by mistake);
// anyone with access to both the key and the files can still decrypt them.

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

export function loadKey(dataDir: string): Buffer {
  const path = join(dataDir, '.key');
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`Corrupted encryption key: ${path}`);
    return key;
  }
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, key.toString('base64'), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* not supported on every filesystem */ }
  return key;
}

export function encrypt(key: Buffer, data: unknown): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function decrypt<T>(key: Buffer, blob: Buffer): T {
  if (blob[0] !== VERSION) throw new Error('Unsupported session file version');
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const text = Buffer.concat([decipher.update(blob.subarray(1 + IV_LEN + TAG_LEN)), decipher.final()]).toString('utf8');
  return JSON.parse(text) as T;
}
