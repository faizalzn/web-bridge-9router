import type { Config } from '../core/config.ts';
import { BridgeError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import type { Provider, ProviderDeps, ProviderFactory } from './base.ts';
import { ClaudeProvider } from './claude/index.ts';
import { EchoProvider } from './echo/index.ts';
import { GeminiProvider } from './gemini/index.ts';

// New adapters register here (chatgpt, ... in later sprints).
const FACTORIES: Record<string, ProviderFactory> = {
  echo: () => new EchoProvider(),
  gemini: (cfg, deps) => new GeminiProvider(cfg, deps),
  claude: (cfg, deps) => new ClaudeProvider(cfg, deps),
};

export interface PublicModel { id: string; provider: Provider; localId: string; account?: string; name?: string }

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  add(provider: Provider): void { this.providers.set(provider.id, provider); }
  list(): Provider[] { return [...this.providers.values()]; }

  /** Every model id the gateway accepts: "gemini/pro", plus "gemini@work/pro" for extra accounts. */
  models(): PublicModel[] {
    return this.list().flatMap((p) => {
      const accounts = (p.accounts?.() ?? []).filter((a) => a !== 'default');
      const prefixes: { prefix: string; account?: string }[] = [
        { prefix: p.id },
        ...accounts.map((a) => ({ prefix: `${p.id}@${a}`, account: a })),
      ];
      return prefixes.flatMap(({ prefix, account }) =>
        p.listModels().filter((m) => !m.unavailable).map((m) => ({ id: `${prefix}/${m.id}`, provider: p, localId: m.id, account, name: m.name })));
    });
  }

  /** Accepts "provider/model", "provider@account/model", or a bare provider id (its first model). */
  resolve(model: string): { provider: Provider; localId: string; account?: string } {
    // Some clients do not allow "/" in model names: accept "claude-sonnet" for "claude/sonnet".
    if (!model.includes('/') && !this.providers.has(model.split('@')[0]!)) {
      for (const p of this.list()) {
        if (!model.startsWith(`${p.id}-`)) continue;
        const local = model.slice(p.id.length + 1);
        if (p.listModels().some((m) => m.id === local)) return { provider: p, localId: local };
      }
    }
    const slash = model.indexOf('/');
    const head = slash === -1 ? model : model.slice(0, slash);
    const [providerId = '', account] = head.split('@');
    const provider = this.providers.get(providerId);
    if (!provider) {
      const known = this.models().map((m) => m.id).join(', ') || '(none)';
      throw new BridgeError('not_found', `Unknown model "${model}". Available: ${known}`);
    }
    const localId = slash === -1 ? provider.listModels()[0]?.id : model.slice(slash + 1);
    if (!localId || !provider.listModels().some((m) => m.id === localId)) {
      const own = provider.listModels().map((m) => `${head}/${m.id}`).join(', ');
      throw new BridgeError('not_found', `Provider "${providerId}" has no model "${localId ?? ''}". Available: ${own}`);
    }
    if (account && !(provider.accounts?.() ?? []).includes(account)) {
      throw new BridgeError('not_found', `No saved login "${account}" for ${providerId}. Run: bridge login ${providerId} --account ${account}`);
    }
    return { provider, localId, account };
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.list().map((p) => p.close?.()));
  }
}

export function createRegistry(config: Config, deps: ProviderDeps): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const [id, pc] of Object.entries(config.providers)) {
    if (!pc.enabled) continue;
    const factory = FACTORIES[id];
    if (!factory) { logger.warn(`Unknown provider "${id}" in config, skipping`); continue; }
    registry.add(factory(pc, deps));
  }
  return registry;
}
