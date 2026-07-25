/**
 * Verify a built site has every local file the app loads.
 *
 * A missing ES module does not fail loudly in a browser: the import 404s, the
 * module graph never executes, and the page renders with every control dead.
 * That is indistinguishable from "the app is broken" and easy to ship, so the
 * deploy checks for it instead of trusting a hand-maintained file list.
 *
 *     node tools/check_site.mjs _site
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const site = process.argv[2] ?? '_site';
const problems = [];
const needed = new Set();

function noteMissing(file, why) {
  if (!existsSync(join(site, file))) problems.push(`${file} — ${why}`);
}

// The service worker's SHELL is the app's own statement of what it needs.
const swPath = join(site, 'sw.js');
if (!existsSync(swPath)) {
  problems.push('sw.js — not in the built site');
} else {
  const block = readFileSync(swPath, 'utf8').match(/const SHELL = \[([\s\S]*?)\];/);
  if (!block) {
    problems.push('sw.js — could not parse the SHELL list');
  } else {
    for (const [, file] of block[1].matchAll(/'\.\/([^']+)'/g)) needed.add(file);
  }
}

// Then follow the imports of whatever scripts did ship, since a module can
// pull in a file the service worker never lists.
for (const file of [...needed]) {
  if (!file.endsWith('.js')) continue;
  const path = join(site, file);
  if (!existsSync(path)) continue;
  for (const [, dep] of readFileSync(path, 'utf8').matchAll(/from '\.\/([^']+)'/g)) {
    needed.add(dep);
  }
}

// And anything index.html references directly.
const indexPath = join(site, 'index.html');
if (existsSync(indexPath)) {
  const html = readFileSync(indexPath, 'utf8');
  for (const [, ref] of html.matchAll(/(?:src|href)="(?!https?:|data:|#)([^"]+)"/g)) {
    needed.add(ref.replace(/^\.\//, ''));
  }
} else {
  problems.push('index.html — not in the built site');
}

for (const file of needed) noteMissing(file, 'referenced but not deployed');

if (problems.length) {
  console.error(`Incomplete site in ${site}/:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`${site}/ complete — ${needed.size} referenced files all present`);
