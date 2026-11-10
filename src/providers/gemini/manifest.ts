import bundled from './manifest.json' with { type: 'json' };

// Everything that is likely to change when Google changes the web app lives in the manifest
// (endpoints, token keys, model ids, error codes), not in code. Sprint 6 downloads newer manifests.

export interface GeminiModel {
  id: string;
  name: string;
  /**
   * Set when the model cannot be used through the gateway: requests fail at once with this reason (HTTP 503, so
   * 9router can fall back) and the model is left out of /v1/models.
   */
  unavailable?: string;
  /** Gemini's own id of the model: sent in the request header and used as `data-mode-id` in the model picker. */
  modelId: string;
  /**
   * Position of the model in the web app's own list (6 = Flash-Lite, 1 = Flash, 3 = Pro, 8 = Argon). The chat request
   * header carries it at index 14 next to `modelId` at index 4. Verified against the server: with the right mode every
   * model answers as itself, while a fixed 6 made every question come back from Flash-Lite whatever `modelId` said.
   */
  mode: number;
}

/** CSS selectors for DOM mode. Language independent on purpose: the UI language follows the Google account. */
export interface GeminiDomSelectors {
  textbox: string;
  modelPicker: string;
  /** Item of one model in the open picker; `{id}` is replaced with the model id. */
  modelItem: string;
  /** The picker item of the model that is currently selected. */
  modelChecked: string;
  /** RPCs the page makes after a model change; the prompt must not be sent before they finish. */
  modelSwitchRpcs: string[];
  response: string;
  responseText: string;
  /** Parts of a reply that are not the answer (cards, attachments). */
  ignore: string;
  /** Attribute that is "true" on the reply while it is still being written. */
  busyAttr: string;
}

export interface GeminiManifest {
  version: number;
  bootstrap: { url: string; atKey: string; blKey: string; sidKey: string; ttlSeconds: number };
  stream: { url: string; hl: string; lang: string };
  batchexecute: { url: string; deleteChatRpc: string };
  headers: { model: string; flags: string; flagsValue: string; capabilities: number[] };
  errors: { usageLimit: number[]; blocked: number[]; badModel: number[]; temporary: number[]; failed?: number[] };
  models: GeminiModel[];
  dom: GeminiDomSelectors;
}

export const BUNDLED_MANIFEST: GeminiManifest = bundled as GeminiManifest;
