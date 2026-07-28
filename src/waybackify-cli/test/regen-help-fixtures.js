// Regenerate the help snapshot fixtures (test/fixtures/help/*.txt) from the
// live command tree. Run DELIBERATELY when the CLI surface changes:
//
//   node test/regen-help-fixtures.js
//
// then review the fixture diff like any contract change — the snapshots exist
// so the surface cannot drift by accident.
//
// The surface is nested: five flat verbs plus the `cache` GROUP and its five
// subcommands. paparam's help is variadic — root.help('cache') yields the
// group's help, root.help('cache', 'add') yields the nested leaf's — so the
// `cache <verb>` fixtures are named `cache-<verb>.txt`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCLI } from '../src/cli.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'help');
fs.mkdirSync(dir, { recursive: true });

const root = createCLI();
fs.writeFileSync(path.join(dir, 'root.txt'), root.help());

// Flat verbs + the cache group (its own help lists the subcommands).
const flat = ['manifest', 'rewrite', 'ledger', 'check', 'search', 'cache'];
for (const name of flat) {
  fs.writeFileSync(path.join(dir, `${name}.txt`), root.help(name));
}

// The cache group's subcommands (nested help).
const cacheVerbs = ['add', 'fill', 'verify', 'remaster', 'sync'];
for (const verb of cacheVerbs) {
  fs.writeFileSync(path.join(dir, `cache-${verb}.txt`), root.help('cache', verb));
}

const count = 1 + flat.length + cacheVerbs.length;
console.log(`wrote ${count} fixtures to ${dir}`);
