import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envStatus, letters, loadAccess, missingProfileFields, recordAccess, saveProfile, writeLetters } from '@/cli/lib/setup.mjs';

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'iscale-setup-'));
  env = { ISCALE_HOME: home } as unknown as NodeJS.ProcessEnv;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('guided setup', () => {
  it('asks only for what is still missing from the profile', () => {
    saveProfile({ name: 'Jane', email: 'j@example.com' }, env);
    const { profile } = saveProfile({ country: 'US' }, env);
    expect(missingProfileFields(profile).map((m: { field: string }) => m.field)).toEqual(['subscriberType']);
  });

  it('sets a follow-up date when a request is waiting on the office', () => {
    const r = recordAccess('euipo', 'requested', 'sent docs', env, new Date('2026-10-01T12:00:00Z'));
    expect(r.followUpDue).toBe('2026-10-08');
    expect(recordAccess('euipo', 'approved', undefined, env).followUpDue).toBeNull();
    expect(loadAccess(env).sources.euipo.notes).toHaveLength(1);
    expect(() => recordAccess('jpo', 'requested', undefined, env)).toThrow();
  });

  it('writes the company version of the EUIPO email with the right attachments', () => {
    const [l] = letters('euipo', { name: 'Jane', email: 'j@example.com', country: 'US', subscriberType: 'legal person', legalEntity: 'Jane Prints LLC' });
    expect(l.body).toContain('Entity: Jane Prints LLC');
    expect(l.attachments.join(' ')).toMatch(/Company-register/);
    const [file] = writeLetters([l], path.join(home, 'letters'));
    expect(fs.readFileSync(file, 'utf8')).toContain('To: docs.apiplatform@euipo.europa.eu');
  });

  it('never invents a USPTO support address', () => {
    const [l] = letters('uspto', {});
    expect(l.to).toMatch(/copy it from https:\/\/data\.uspto\.gov/);
  });

  it('reads which settings are filled in without exposing values, ignoring placeholders', () => {
    fs.writeFileSync(path.join(home, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\nSUPABASE_SERVICE_ROLE_KEY=<supabase-service-role-key>\n');
    const s = envStatus(home);
    expect(s.database).toEqual(expect.arrayContaining(['SUPABASE_SERVICE_ROLE_KEY', 'TM_DB_URL']));
    expect(s.database).not.toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(JSON.stringify(s)).not.toContain('54321');
  });
});
