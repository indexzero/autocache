// Regenerate the help snapshot fixtures (test/fixtures/help/*.txt) from the
// live command tree. Run DELIBERATELY when the CLI surface changes:
//
//   node test/regen-help-fixtures.js
//
// then review the fixture diff like any contract change — the snapshots exist
// so the surface cannot drift by accident.
//
// The surface is nested: six flat verbs (manifest · rewrite · ledger · check ·
// search · audit) plus the three tier GROUPS — `cache` (add · fill · crawl ·
// verify), `remaster` (build · verify), and `bucket` (push · verify). paparam's help is
// variadic — root.help('remaster') yields the group's help, root.help('remaster',
// 'build') yields the nested leaf's — so the `<group> <verb>` fixtures are named
// `<group>-<verb>.txt`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCLI } from '../src/cli.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'help');
fs.mkdirSync(dir, { recursive: true });

const root = createCLI();
fs.writeFileSync(path.join(dir, 'root.txt'), root.help());

// Flat verbs + the three groups (each group's own help lists its subcommands).
const flat = ['manifest', 'rewrite', 'ledger', 'check', 'search', 'audit', 'cache', 'remaster', 'bucket'];
for (const name of flat) {
  fs.writeFileSync(path.join(dir, `${name}.txt`), root.help(name));
}

// Each group's subcommands (nested help), fixtures named `<group>-<verb>.txt`.
const groups = {
  cache: ['add', 'fill', 'crawl', 'verify'],
  remaster: ['build', 'verify'],
  bucket: ['push', 'verify']
};
let verbCount = 0;
for (const [group, verbs] of Object.entries(groups)) {
  for (const verb of verbs) {
    fs.writeFileSync(path.join(dir, `${group}-${verb}.txt`), root.help(group, verb));
    verbCount += 1;
  }
}

const count = 1 + flat.length + verbCount;
console.log(`wrote ${count} fixtures to ${dir}`);
