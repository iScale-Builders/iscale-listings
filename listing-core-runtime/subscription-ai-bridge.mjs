// Compatibility entry point. The Codex subscription bridge is now the iScale
// local helper (cli/lib/helper-server.mjs): same port (18799) and the same
// /health, /generate, /vision contract, plus optional shared settings; Codex now
// runs through OpenAI's official Codex SDK. Prefer `iscale helper`.
//
//   node listing-core-runtime/subscription-ai-bridge.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHelper } from '../cli/lib/helper-server.mjs';

export { environmentWithoutApiKeys } from '../cli/lib/engines.mjs';

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) void startHelper();
