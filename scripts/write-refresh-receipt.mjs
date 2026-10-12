// Only sanitized counts/statuses: no listing contents, keys or connection URLs.
import fs from 'node:fs';
import path from 'node:path';
import { iscaleHome } from '../cli/lib/settings-store.mjs';
const [us, eu, health, scan] = process.argv.slice(2);
const completed = us === '0' && ['0', 'skipped'].includes(eu) && health === '0' && ['0', '2'].includes(scan);
const root = iscaleHome(); fs.mkdirSync(root, { recursive: true });
const receipt = { schema: 'iscale.refresh-and-scan/1', checkedAt: new Date().toISOString(), status: completed ? 'completed' : 'failed', coverageComplete: completed, incomplete: !completed, usExit: us, euExit: eu, healthExit: health, scanExit: scan, trigger: 'not verified', descriptionIncluded: true };
const file = path.join(root, 'refresh-and-scan-last.json');
const temporary = file + '.' + process.pid + '.tmp';
fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2)); fs.renameSync(temporary, file);
