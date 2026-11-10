import { readFileSync } from 'node:fs';

// Works from both src/ (dev) and dist/ (built): package.json is one level up.
export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
