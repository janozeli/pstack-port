#!/usr/bin/env node
// Mutation test of the port's own tests. Each mutation is one realistic fault in the compiler, the rewrite
// engine, the generator or the source. The runner applies it in a disposable clone of HEAD, regenerates the
// packages as a real commit would, and records whether `npm test` fails.
//
//   node scripts/mutation/run.mjs [--workers N] [--out results.jsonl] [id ...]
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutations } from './mutations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args.splice(args.indexOf(name), 2)[1] : fallback);
const workers = Number(option('--workers', Math.min(4, availableParallelism())));
const out = option('--out');
const selected = mutations.filter(m => args.length === 0 || args.includes(m.id));
const unknown = args.filter(id => !mutations.some(m => m.id === id));
if (unknown.length > 0) throw new Error(`Unknown mutation: ${unknown.join(' ')}`);

const run = (cwd, cmd, argv) => new Promise(done => {
  const child = spawn(cmd, argv, { cwd });
  let output = '';
  child.stdout.on('data', data => (output += data));
  child.stderr.on('data', data => (output += data));
  child.on('close', code => done({ code, output }));
});

const scratch = mkdtempSync(join(tmpdir(), 'pstack-mutants-'));
const queue = [...selected];
const rows = [];
const started = Date.now();

async function worker(n) {
  const clone = join(scratch, `clone${n}`);
  await run(scratch, 'git', ['clone', '-q', '--local', root, clone]);
  cpSync(join(root, 'node_modules'), join(clone, 'node_modules'), { recursive: true });
  const read = file => readFileSync(join(clone, file), 'utf8');
  for (let m; (m = queue.shift());) {
    await run(clone, 'git', ['reset', '-q', '--hard', 'HEAD']);
    await run(clone, 'git', ['clean', '-fdq']);
    for (const [file, find, replace] of m.edits ?? []) {
      const mutated = read(file).replace(find, replace);
      if (mutated === read(file)) throw new Error(`${m.id}: the mutation no longer applies to ${file}; update scripts/mutation/mutations.mjs`);
      writeFileSync(join(clone, file), mutated);
    }
    for (const [file, text] of m.write ?? []) {
      mkdirSync(dirname(join(clone, file)), { recursive: true });
      writeFileSync(join(clone, file), text);
    }
    for (const [file, text] of m.append ?? []) appendFileSync(join(clone, file), text);
    const row = { id: m.id, area: m.area, desc: m.desc };
    if (m.regen !== false) row.generator = (await run(clone, 'node', ['scripts/generate-pstack-harness-trees.mjs'])).code === 0 ? 'ok' : 'throws';
    // A real commit stages its files, and the inventory test reads the index.
    await run(clone, 'git', ['add', '-A']);
    row.packageFilesChanged = (await run(clone, 'git', ['diff', '--cached', '--name-only', '--', 'harness'])).output.split('\n').filter(Boolean).length;
    row.npmTest = (await run(clone, 'npm', ['test'])).code === 0 ? 'pass' : 'fail';
    row.expected = m.equivalent ? 'equivalent' : m.survives ? 'survives' : 'killed';
    rows.push(row);
    console.log(`${m.id.padEnd(4)} npm test ${row.npmTest}  package files changed ${String(row.packageFilesChanged).padStart(3)}  ${m.desc}`);
  }
}

try {
  await Promise.all(Array.from({ length: Math.min(workers, selected.length) }, (_, n) => worker(n)));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

rows.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
if (out) writeFileSync(out, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
const real = rows.filter(row => row.expected !== 'equivalent');
const killed = real.filter(row => row.npmTest === 'fail');
const unexpectedSurvivors = rows.filter(row => row.npmTest === 'pass' && row.expected === 'killed');
const unexpectedKills = rows.filter(row => row.npmTest === 'fail' && row.expected !== 'killed');
console.log(`\nscore: ${killed.length}/${real.length} killed by npm test, ${rows.length - real.length} equivalent, ${Math.round((Date.now() - started) / 1000)} s with ${workers} workers`);
for (const row of rows.filter(r => r.npmTest === 'pass')) {
  const m = mutations.find(x => x.id === row.id);
  console.log(`  ${row.id} ${m.equivalent ? 'equivalent' : 'survives'}: ${m.equivalent ?? m.survives ?? 'NO RECORDED REASON'}`);
}
for (const row of unexpectedSurvivors) console.log(`::error::${row.id} survived npm test: ${row.desc}`);
for (const row of unexpectedKills) console.log(`::error::${row.id} is recorded as ${row.expected} but npm test now fails; update scripts/mutation/mutations.mjs`);
process.exit(unexpectedSurvivors.length + unexpectedKills.length > 0 ? 1 : 0);
