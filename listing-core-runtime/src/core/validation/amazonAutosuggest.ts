// Amazon autosuggest fetcher shared by the extension side panel and the CLI.
// Both can call completion.amazon.com directly (the extension via its host
// permission, Node with no CORS at all), so there is one behavioural contract.

import type { AutosuggestFetcher } from '../types';

const AUTOSUGGEST_PARAMS: Record<string, string> = {
  limit: '10',
  'suggestion-type': 'KEYWORD',
  'page-type': 'Search',
  alias: 'aps',
  'site-variant': 'desktop',
  version: '3',
  event: 'onkeypress',
  wc: '',
  lop: 'en_US',
  'avg-ks-time': '100',
  fb: '1',
  'session-id': '',
  'request-id': '',
  mid: 'ATVPDKIKX0DER',
  'plain-mid': '1',
  'client-info': 'amazon-search-ui',
};

export const amazonAutosuggest: AutosuggestFetcher = async (prefix: string) => {
  const url = new URL('https://completion.amazon.com/api/2017/suggestions');
  for (const [k, v] of Object.entries(AUTOSUGGEST_PARAMS)) url.searchParams.set(k, v);
  url.searchParams.set('prefix', prefix);
  url.searchParams.set('last-prefix', prefix);
  // Hard timeout: validation fires one request per candidate, so a single hung
  // completion request would otherwise stall the whole validate stage.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`autosuggest ${res.status}`);
  const json = (await res.json()) as { suggestions?: Array<{ value?: string }> };
  return (json.suggestions ?? []).map((s) => s.value?.trim()).filter((v): v is string => !!v);
};
