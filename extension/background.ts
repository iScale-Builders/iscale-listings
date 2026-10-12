// iScaleListings — background service worker.
//
// Owns: (1) the API calls (so content scripts don't hit MV3 cross-origin/CORS
// limits), (2) opening Chrome's NATIVE side panel on the toolbar-icon click,
// and (3) the right-click "Check trademark" context menu.

// Base URL of the trademark API deployment. Configured in the side panel
// (stored under kw_tm_api_base — same key kw-state.ts persists); empty means
// a local dev deployment.
import { forgetTrademarkApiKey, loadTrademarkApiKey } from './shared';

const DEFAULT_API_BASE = 'http://localhost:3000';
const MENU_ID = 'iscale-tm-check-selection';

function getApiBase(): Promise<string> {
  return new Promise((resolve) => {
    try {
      chrome.storage?.local?.get(['kw_tm_api_base'], (r: Record<string, unknown>) => {
        const raw = typeof r?.['kw_tm_api_base'] === 'string' ? (r['kw_tm_api_base'] as string) : '';
        const base = raw.trim().replace(/\/+$/, '') || DEFAULT_API_BASE;
        resolve(`${base}/api/v1`);
      });
    } catch {
      resolve(`${DEFAULT_API_BASE}/api/v1`);
    }
  });
}

interface CheckMsg {
  type: 'check';
  text: string;
  classes: string[];
  jurisdictions?: string[];
}

// The optional trademark API key is a secret — read it from local storage (never
// the account-synced area). A value found only in sync (set by an older install)
// is migrated: copied into local and removed from sync so it stops roaming.
function getApiKey(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      chrome.storage?.local?.get(['iscale_tm_api_key'], (local: Record<string, unknown>) => {
        const fromLocal = (local?.['iscale_tm_api_key'] as string) ?? null;
        if (fromLocal) return resolve(fromLocal);
        try {
          chrome.storage?.sync?.get(['iscale_tm_api_key'], (sync: Record<string, unknown>) => {
            const fromSync = (sync?.['iscale_tm_api_key'] as string) ?? null;
            if (fromSync) {
              try {
                chrome.storage?.local?.set({ iscale_tm_api_key: fromSync });
                chrome.storage?.sync?.remove(['iscale_tm_api_key']);
              } catch {
                /* best-effort migration */
              }
            }
            if (fromSync) return resolve(fromSync);
            // Nothing stored: ask the local helper for this machine's key.
            void loadTrademarkApiKey().then(resolve);
          });
        } catch {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

async function runCheck(text: string, classes: string[], jurisdictions?: string[]) {
  try {
    const [apiKey, apiBase] = await Promise.all([getApiKey(), getApiBase()]);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // The backend reads `x-api-key` only (lib/auth/middleware.ts) — the old
    // `Authorization: Bearer` header was silently ignored, so a configured key
    // never actually authenticated. Same scheme the bundled core uses.
    if (apiKey) headers['X-API-Key'] = apiKey;
    // Hard timeout so a wedged request can't leave the page agent (and its
    // on-page toast / panel spinner) waiting on a Promise that never settles.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let resp: Response;
    try {
      resp = await fetch(`${apiBase}/check`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text, classes, ...(jurisdictions ? { jurisdictions } : {}) }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (resp.ok) return { ok: true, data: await resp.json() };
    if (resp.status === 401 && apiKey) forgetTrademarkApiKey(); // rotated key: refetch next time
    let parsed: { error?: { message?: string; retry_after?: number } } | null = null;
    try {
      parsed = await resp.json();
    } catch {
      /* non-JSON error body */
    }
    return {
      ok: false,
      status: resp.status,
      error: parsed?.error?.message ?? resp.statusText ?? 'Request failed',
      retryAfter: parsed?.error?.retry_after,
    };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { ok: false, error: 'Trademark check timed out — try again.' };
    }
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
  }
}

// Content scripts ask the background to run the check (avoids content-script CORS).
chrome.runtime.onMessage.addListener(
  (msg: CheckMsg, sender: { tab?: { id?: number }; id?: string }, sendResponse: (r: unknown) => void) => {
    // Only accept 'check' from our own injected content scripts (they have a tab
    // and our extension id). Drops messages from other extensions / spoofers that
    // would otherwise drive authenticated, quota-burning trademark-API calls.
    if (msg?.type === 'check' && sender?.tab?.id != null && sender.id === chrome.runtime.id) {
      runCheck(msg.text, msg.classes, msg.jurisdictions).then(sendResponse);
      return true; // keep the message channel open for the async response
    }
    return undefined;
  }
);

// Toolbar icon -> open Chrome's native side panel. setPanelBehavior tells Chrome
// to open the panel itself on the action click, which preserves the user-gesture
// chain MV3 requires for sidePanel.open(). (Calling it at the top level runs on
// every service-worker wake; it's idempotent.)
function enablePanelOnClick(): void {
  chrome.sidePanel
    ?.setPanelBehavior?.({ openPanelOnActionClick: true })
    .catch((err: unknown) => console.warn('[bg] setPanelBehavior failed:', err));
}
enablePanelOnClick();

chrome.runtime.onInstalled.addListener(() => {
  enablePanelOnClick();
  // removeAll() first: onInstalled also fires on extension update/reload, when the
  // menu from the previous load still exists — calling create() then throws
  // "Cannot create item with duplicate id". Clearing first makes it idempotent.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Check "%s" for trademarks',
      contexts: ['selection'],
    });
  });
});

// Right-click a selection -> open the panel (the menu click is a user gesture, so
// sidePanel.open is allowed here) and tell the page agent to check that text.
chrome.contextMenus.onClicked.addListener(
  (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => {
    if (info.menuItemId === MENU_ID && tab?.id != null && info.selectionText) {
      try {
        if (tab.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId });
      } catch {
        /* open is best-effort */
      }
      chrome.tabs
        .sendMessage(tab.id, { type: 'cmd', action: 'check-selection', text: info.selectionText })
        .catch(() => {});
    }
  }
);

// ---------------------------------------------------------------------------
// Self-update. An unpacked extension serves its files from disk, so when a new
// build lands in the extension folder, its manifest.json on disk carries the
// new version while this worker still runs the old one. Reload into the new
// build, but only while no panel is open, so a running job is never cut off.
// No more manual reloads on chrome://extensions after a ship.
// ---------------------------------------------------------------------------
const UPDATE_ALARM = 'iscale-self-update';

// Every open panel holds a port; while any is connected, never reload (a reload
// would wipe the panel). getContexts below is a second guard.
const openPanels = new Set<chrome.runtime.Port>();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'iscale-panel') return;
  openPanels.add(port);
  port.onDisconnect.addListener(() => openPanels.delete(port));
});

async function checkForNewBuild(): Promise<void> {
  try {
    const r = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    if (!r.ok) return;
    const disk = ((await r.json()) as { version?: string })?.version;
    if (!disk || disk === chrome.runtime.getManifest().version) return;
    if (openPanels.size > 0) return; // a panel is open: try again on the next tick
    const open = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.SIDE_PANEL, chrome.runtime.ContextType.TAB],
    });
    if (open.length > 0) return; // try again on the next tick
    chrome.runtime.reload();
  } catch {
    /* a build still being written, or nothing new: try again on the next tick */
  }
}

chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === UPDATE_ALARM) void checkForNewBuild();
});
void checkForNewBuild();
