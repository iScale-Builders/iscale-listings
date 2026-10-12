import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiHealth, setupHealth, setupStatus, markScheduled, recordAcceptance, setWorkflow, recordListingScreen, setDatabase, saveProfile } from '../../cli/lib/setup.mjs';
import { registerLocalApiKey } from '../../scripts/create-local-api-key.mjs';
let home: string; let env: any;
const health = () => ({ status: 'ok', version: 'v1', database: 'connected', data_stale: false, jurisdictions: ['US', 'EUIPO'].map(jurisdiction => ({ jurisdiction, status: 'completed', local_database: true, live_mark_count: 10, data_stale: false, last_synced_at: new Date().toISOString() })) });
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'iscale-readiness-')); env = { ISCALE_HOME: home }; });
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(home, { recursive: true, force: true }); });
function mock(status: number, body: any) { const fetch = vi.fn(async (_url: string, _options?: any) => ({ status, json: async () => body })); vi.stubGlobal('fetch', fetch); return fetch; }
describe('setup observed readiness', () => {
  it.each(['unreachable', '401', 'stale-no-key', 'stale-key'])('cold %s next handoff uses existing guided steps', async mode => {
    saveProfile({name:'Fixture',email:'fixture@example.invalid',country:'US',subscriberType:'natural person'}, env);
    setDatabase('postgres', env);
    fs.writeFileSync(path.join(home,'.env.local'), 'DATABASE_URL=fixture\nTM_DB_URL=fixture\n' + (mode === 'stale-key' ? 'USPTO_API_KEY=fixture\n' : ''));
    if(mode === 'unreachable') vi.stubGlobal('fetch', vi.fn(async()=>{throw new Error('fixture offline');}));
    else mock(mode === '401' ? 401 : 503, {error:{code: mode === '401' ? 'UNAUTHORIZED' : 'SYNC_STALE'}});
    const result = await setupStatus({apiBase:'http://localhost:3191',env,root:home});
    expect(result.next?.id).toBe('api');
    expect(result.next?.todo).toContain(mode === 'unreachable' ? 'local-walkthrough' : mode === '401' ? 'api-auth' : mode === 'stale-key' ? 'uspto-import' : 'guide uspto (');
  });

  it.each(['local', 'postgres', 'supabase'])('routes %s to its reachable scheduler', async choice => {
    setDatabase(choice, env); mock(200, health());
    const s = await setupStatus({ apiBase: 'http://localhost:3191', env, root: home });
    const todo = s.steps.find(x => x.id === 'schedule')?.todo;
    expect(todo).toContain(choice === 'supabase' ? 'GitHub Actions' : 'Task Scheduler / LaunchAgent');
  });
  it.each([401, 404, 500])('HTTP %s is not API-ready', async status => {
    mock(status, health()); const result = await setupHealth({ apiBase: 'http://localhost:3191', env });
    expect(result.ready).toBe(false); expect(result.apiReady).toBe(false);
  });
  it.each([
    { status: 503, body: { error: { code: 'SYNC_STALE' } }, guide: 'uspto (' },
    { status: 401, body: { error: { code: 'UNAUTHORIZED' } }, guide: 'api-auth' },
    { status: 404, body: {}, guide: 'API base URL' },
  ])('routes HTTP $status to its actual setup remedy without marking ready', async fixture => {
    mock(fixture.status, fixture.body); const s = await setupStatus({ apiBase: 'http://localhost:3191', env, root: home });
    const api = s.steps.find(x => x.id === 'api'); expect(api?.done).toBe(false); expect(api?.todo).toContain(fixture.guide);
  });
  it('malformed HTTP 200 is not a health contract', async () => { mock(200, {}); expect((await setupHealth({ apiBase: 'http://localhost:3191', env })).ready).toBe(false); });
  it('sends the machine key securely and requires actual positive/fresh registry data', async () => {
    fs.writeFileSync(path.join(home, 'trademark-api-key'), 'local-fixture-key'); const fetch = mock(200, health());
    const result = await setupHealth({ apiBase: 'http://localhost:3191', env }); expect(result.ready).toBe(true);
    expect(fetch.mock.calls[0][1].headers['X-API-Key']).toBe('local-fixture-key'); expect(JSON.stringify(result)).not.toContain('local-fixture-key');
  });
  it.each(['missing', 'stale', 'zero', 'future', 'not-completed'])('%s coverage stays unverified', async variant => {
    const body = health();
    if (variant === 'missing') body.jurisdictions.pop();
    if (variant === 'stale') body.jurisdictions[1].data_stale = true;
    if (variant === 'zero') body.jurisdictions[1].live_mark_count = 0;
    if (variant === 'future') body.jurisdictions[1].last_synced_at = new Date(Date.now() + 3600000).toISOString();
    if (variant === 'not-completed') body.jurisdictions[1].status = 'failed';
    mock(200, body); expect((await setupHealth({ apiBase: 'http://localhost:3191', env })).ready).toBe(false);
  });
  it('reported scheduling does not become verified, and CLI does not probe/block on a helper', async () => {
    markScheduled(env); const fetch = mock(200, health()); const s = await setupStatus({ apiBase: 'http://localhost:3191', env, root: home });
    expect(s.steps.find(x => x.id === 'schedule')?.done).toBe(false); expect(s.steps.find(x => x.id === 'schedule')?.required).toBe(false);
    expect(s.steps.find(x => x.id === 'helper')?.applicable).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
    expect(s.next?.id).not.toBe('schedule');
  });
  it('manual reviews progress separately and changed evidence invalidates the recorded review', async () => {
    mock(200, health()); const file = path.join(home, 'natural-run.json'); fs.writeFileSync(file, '{}');
    recordAcceptance('schedule', file, env); const s = await setupStatus({ apiBase: 'http://localhost:3191', env, root: home });
    expect(s.acceptance.find(x => x.id === 'schedule')?.reviewRecorded).toBe(true); expect(s.acceptance[0].classification).toContain('not independently verified');
    fs.writeFileSync(file, '{"changed":true}'); const after = await setupStatus({ apiBase: 'http://localhost:3191', env, root: home });
    expect(after.acceptance.find(x => x.id === 'schedule')?.reviewRecorded).toBe(false);
  });
  it('an OpenAI extension workflow checks key-bridge bootstrap without requiring an AI subscription', async () => {
    setWorkflow('extension-api', env); const fetch = mock(200, health()); const s = await setupStatus({ apiBase: 'http://localhost:3191', env, root: home });
    expect(s.steps.find(x => x.id === 'helper')?.applicable).toBe(true); expect(s.acceptance.some(x => x.id === 'extension')).toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('OpenAI key bridge can become optional after a reported browser delivery review, without pretending the helper is healthy', async () => {
    setWorkflow('extension-api', env); const file = path.join(home, 'browser-proof.md'); fs.writeFileSync(file, 'reviewed own private request'); recordAcceptance('extension', file, env);
    mock(200, health()); const s = await setupStatus({ apiBase: 'http://localhost:3191', env, root: home });
    const helper = s.steps.find(x => x.id === 'helper'); expect(helper?.done).toBe(false); expect(helper?.required).toBe(false); expect(helper?.evidence).toContain('reported');
  });
  it('screen receipts contain scope/status counts but no content or secret', () => {
    recordListingScreen({ status: 'risk', classes: ['025'], jurisdictions: ['US'], actionable: [{}], text: 'private listing', key: 'do not retain' }, env);
    const serialized = fs.readFileSync(path.join(home, 'listing-screen-last.json'), 'utf8'); expect(serialized).not.toContain('private listing'); expect(serialized).not.toContain('do not retain');
  });
});
describe('local API key registration', () => {
  it('writes/reuses a private key and registers only its hash using parameterized SQL', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ is_active: true }] })); const Client = class { async connect() {} async end() {} query = query; };
    const result = await registerLocalApiKey({ env: { ...env, DATABASE_URL: 'postgresql://localhost/isolated' }, Client: Client as any });
    const key = fs.readFileSync(path.join(home, 'trademark-api-key'), 'utf8');
    expect(key).toMatch(/^sp_live_[a-f0-9]{64}$/); expect(JSON.stringify(result)).not.toContain(key); expect(JSON.stringify(query.mock.calls)).not.toContain(key);
    await registerLocalApiKey({ env: { ...env, DATABASE_URL: 'postgresql://localhost/isolated' }, Client: Client as any });
    expect(fs.readFileSync(path.join(home, 'trademark-api-key'), 'utf8')).toBe(key); expect(query.mock.calls[0][1]?.[0]).toMatch(/^[a-f0-9]{64}$/);
  });
});
