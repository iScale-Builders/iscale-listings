/**
 * AI Provider Abstraction
 *
 * Routes chat completion and vision requests to the user's own AI subscription
 * (ChatGPT plan via the Codex SDK, through the local iScale helper) or an OpenAI API key.
 */

export type AIProvider = 'openai' | 'codex';
export type LocalReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'persistent';

export interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  openaiModel?: string;
  /** Base URL of the local iScale helper (provider === 'codex'). */
  codexUrl?: string;
  /** Engine the local helper runs (currently only 'codex'). */
  localEngine?: string;
  /** Optional model for that CLI ('' = the CLI's own default). */
  localModel?: string;
  /** Request-local Codex budget; never persisted to owner settings. */
  localReasoningEffort?: LocalReasoningEffort;
  /** Injected AI transport. When present, its chat/vision functions REPLACE the
   *  network provider dispatch — used to run the whole pipeline offline (tests/CI)
   *  or to plug a custom backend, without changing any step function (they all
   *  route AI calls through chatCompletion/visionCompletion). */
  transport?: AITransport;
}

/** A swappable AI transport. Either function, when supplied on AIConfig.transport,
 *  overrides the provider's real network call for that modality. */
export interface AITransport {
  chat?: (config: AIConfig, prompt: string, options: ChatOptions) => Promise<string>;
  vision?: (config: AIConfig, imageBase64: string, prompt: string, options: ChatOptions) => Promise<string>;
}

interface ChatMessage {
  role: 'user' | 'system' | 'assistant';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

export interface ChatOptions {
  localReasoningEffort?: LocalReasoningEffort;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * fetch() with a hard timeout. An unresponsive AI endpoint would otherwise leave
 * the whole pipeline (and the Keywords-tab spinner) hanging forever with no
 * error. Aborts after `ms` and surfaces a clear timeout message.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms = 60000
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`Request timed out after ${Math.round(ms / 1000)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ─── OpenAI ───

async function openaiChat(
  apiKey: string,
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  const { model = 'gpt-4o', maxTokens = 1000, temperature } = options;

  const body: Record<string, unknown> = {
    model,
    messages,
    // `max_tokens` is the legacy parameter — newer OpenAI models (o-series and
    // onward) reject it in favor of `max_completion_tokens`, which all current
    // chat-completions models accept.
    max_completion_tokens: maxTokens,
  };
  if (temperature !== undefined) body.temperature = temperature;

  const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content || '';
}

function getOpenAIModel(config: AIConfig, fallback?: string): string {
  return config.openaiModel || fallback || 'gpt-4o-mini';
}

// ─── Codex subscription (local bridge) ───
//
// Codex is a local CLI signed in with ChatGPT — no API key. The browser POSTs to
// listing-core-runtime/subscription-ai-bridge.mjs, which runs `codex exec` with
// API keys stripped from the child env. Never silently fall back to a paid API.

const DEFAULT_CODEX_BRIDGE = 'http://127.0.0.1:18799';

function codexBase(config: AIConfig): string {
  return (config.codexUrl || DEFAULT_CODEX_BRIDGE).replace(/\/+$/, '');
}

// POST to the local iScale helper (/generate + /vision). `label`/`bin` only shape the error messages so
// an unreachable bridge tells the user which one to start.
async function bridgePost(label: string, bin: string, url: string, body: unknown): Promise<string> {
  let resp: Response;
  try {
    // Local bridge can wedge if the agent CLI stalls; cap the wait generously
    // (vision/agent calls are slow) so the tab can't spin forever.
    resp = await fetchWithTimeout(url, {
      method: 'POST',
      // The custom X-Iscale-Bridge header is required by the bridge: it forces a
      // CORS preflight for cross-origin callers (so an arbitrary website can't
      // reach the localhost bridge with a simple request) and is rejected if absent.
      headers: { 'Content-Type': 'application/json', 'X-Iscale-Bridge': '1' },
      body: JSON.stringify(body),
    }, 300000);
  } catch (e) {
    throw new Error(
      `${label} bridge unreachable at ${url}. Start the local bridge (node ${bin}). ${
        e instanceof Error ? e.message : ''
      }`.trim()
    );
  }
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`${label} bridge error (${resp.status}): ${err}`);
  }
  const data = (await resp.json()) as { text?: unknown };
  if (typeof data?.text !== 'string') {
    throw new Error(`${label} bridge returned no text payload`);
  }
  return data.text;
}

// The helper picks the engine from shared settings when none is sent.
function helperEngine(config: AIConfig): Record<string, string> {
  return {
    ...(config.localEngine ? { engine: config.localEngine } : {}),
    ...(config.localModel ? { model: config.localModel } : {}),
  };
}

function codexText(config: AIConfig, prompt: string, options: ChatOptions): Promise<string> {
  return bridgePost('iScale helper', 'cli/iscale.mjs helper', `${codexBase(config)}/generate`, {
    prompt,
    ...helperEngine(config),
    ...((options.localReasoningEffort ?? config.localReasoningEffort) ? { reasoningEffort: options.localReasoningEffort ?? config.localReasoningEffort } : {}),
  });
}

function codexVision(config: AIConfig, imageBase64: string, prompt: string, options: ChatOptions): Promise<string> {
  return bridgePost('iScale helper', 'cli/iscale.mjs helper', `${codexBase(config)}/vision`, {
    imageBase64,
    prompt,
    ...helperEngine(config),
    ...((options.localReasoningEffort ?? config.localReasoningEffort) ? { reasoningEffort: options.localReasoningEffort ?? config.localReasoningEffort } : {}),
  });
}

/**
 * Pull the JSON payload out of a raw model response. Models often wrap JSON in
 * markdown fences or add trailing prose; a bare greedy `\{[\s\S]*\}` grabs from
 * the first `{` to the LAST `}` in the whole response, so trailing text with a
 * brace breaks the parse. Prefer a fenced ```json block when present, then fall
 * back to the greedy match. Returns the JSON string or null.
 */
export function extractAiJson(raw: string, kind: 'object' | 'array' = 'object'): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : raw;
  const match = source.match(kind === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/);
  return match ? match[0] : null;
}

// ─── Public API ───

/**
 * Send a text chat completion request to the configured provider.
 */
export async function chatCompletion(
  config: AIConfig,
  prompt: string,
  options: ChatOptions = {}
): Promise<string> {
  if (config.transport?.chat) {
    return config.transport.chat(config, prompt, options);
  }
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

  if (config.provider === 'codex') {
    return codexText(config, prompt, options);
  }
  const openaiOpts = { ...options, model: getOpenAIModel(config, options.model) };
  return openaiChat(config.apiKey, messages, openaiOpts);
}

/**
 * Send a vision (image + text) request to the configured provider.
 */
export async function visionCompletion(
  config: AIConfig,
  imageBase64: string,
  prompt: string,
  options: ChatOptions = {}
): Promise<string> {
  if (config.transport?.vision) {
    return config.transport.vision(config, imageBase64, prompt, options);
  }
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageBase64 } },
        { type: 'text', text: prompt },
      ],
    },
  ];

  if (config.provider === 'codex') {
    return codexVision(config, imageBase64, prompt, options);
  }
  const openaiOpts = { ...options, model: getOpenAIModel(config, options.model) };
  return openaiChat(config.apiKey, messages, openaiOpts);
}
