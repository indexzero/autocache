// Regenerate the help snapshot fixtures (test/fixtures/help/*.txt) from the
// live command tree. Run DELIBERATELY when the CLI surface changes:
//
//   node test/regen-help-fixtures.js
//
// then review the fixture diff like any contract change — the snapshots exist
// so the surface cannot drift by accident.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCLI } from '../src/cli.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'help');
fs.mkdirSync(dir, { recursive: true });

const root = createCLI();
fs.writeFileSync(path.join(dir, 'root.txt'), root.help());
for (const name of ['check', 'search', 'manifest', 'cache']) {
  fs.writeFileSync(path.join(dir, `${name}.txt`), root.help(name));
}
console.log(`wrote 5 fixtures to ${dir}`);
