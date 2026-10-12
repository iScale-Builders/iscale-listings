// Register a private API key in the user's own database without printing it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKeyPath } from '../cli/lib/api-key.mjs';
import pg from 'pg';

export async function registerLocalApiKey({ env = process.env, Client = pg.Client } = {}) {
  const connectionString = env.DATABASE_URL || env.TM_DB_URL;
  if (!connectionString) throw new Error('Set DATABASE_URL or TM_DB_URL privately first');
  const file = apiKeyPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, 'sp_live_' + crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  const key = fs.readFileSync(file, 'utf8').trim();
  if (!/^sp_live_[a-f0-9]{64}$/.test(key)) throw new Error('Existing machine key is not supported by this generator; it was not changed');
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    await client.query('INSERT INTO api_keys (key_hash,key_prefix,name,tier,rate_limit,is_active) VALUES ($1,$2,$3,$4,$5,true) ON CONFLICT (key_hash) DO NOTHING', [hash, key.slice(0, 8), 'Local personal key', 'pro', 300]);
    const registered = await client.query('SELECT is_active FROM api_keys WHERE key_hash=$1', [hash]);
    if (registered.rows?.[0]?.is_active !== true) throw new Error('Existing key is inactive; it was not reactivated');
  } finally { await client.end(); }
  return { registered: true, keyFile: file, keyPrinted: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  registerLocalApiKey().then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('Key registration failed. Check your private environment/database schema. Existing machine key retained; no secret printed.');
    process.exitCode = 1;
  });
}
