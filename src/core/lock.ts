import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

// Two gateways sharing one data folder would both rotate the same account's cookies and overwrite
// each other's saved copy; Google then rejects the session. One gateway per data folder.

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Process id of the gateway currently running on this data folder, or null. */
export function runningGatewayPid(dataDir: string): number | null {
  try {
    const pid = Number(readFileSync(join(dataDir, 'gateway.lock'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Takes the lock of a data folder, or throws when another gateway holds it. Returns the release function. */
export function acquireGatewayLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'gateway.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      const release = () => { if (!released) { released = true; try { rmSync(path); } catch { /* already gone */ } } };
      process.once('exit', release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && isAlive(holder)) {
        throw new Error(
          `Another gateway (process ${holder}) is already using ${dataDir}. Two gateways on the same logins would make Google reject them. `
          + 'Stop the other one first, or give this one its own data_dir.',
        );
      }
      rmSync(path, { force: true }); // left behind by a crashed gateway
    }
  }
  throw new Error(`Could not take the lock ${path}`);
}
