#!/usr/bin/env node
// Mutation test of the port's own tests. Each mutation is one realistic fault in the compiler, the rewrite
// engine, the generator or the source. The runner applies it in a disposable clone of HEAD, regenerates the
// packages as a real commit would, and records whether the tests fail.
//
//   node scripts/mutation/run.mjs [--workers N] [--out results.jsonl] [id ...]
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The gate runs this command, not the `test` script, so package.json cannot narrow what counts as the tests.
export const TEST_COMMAND = ['node', ['--test', 'scripts/test/*.test.mjs']];

const run = (cwd, cmd, argv) => new Promise(done => {
  const child = spawn(cmd, argv, { cwd });
  let output = '';
  child.stdout.on('data', data => (output += data));
  child.stderr.on('data', data => (output += data));
  child.on('close', code => done({ code, output }));
});

export class StaleMutation extends Error {}

// Returns one row per mutation: { id, desc, tests: 'pass' | 'fail', packageFilesChanged, expected }.
export async function runMutations({ root, mutations, workers = Math.min(4, availableParallelism()), log = console.log }) {
  const scratch = mkdtempSync(join(tmpdir(), 'pstack-mutants-'));
  const queue = [...mutations];
  const rows = [];
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
        if (mutated === read(file)) throw new StaleMutation(`Mutation ${m.id} no longer applies: ${file} does not contain the text it edits. If you changed that code on purpose, rewrite the \`edits\` of ${m.id} in scripts/mutation/mutations.mjs so that it plants the same fault (${m.desc}) in the new code. If you did not, your change broke that code: fix the code.`);
        writeFileSync(join(clone, file), mutated);
      }
      for (const [file, text] of m.write ?? []) {
        mkdirSync(dirname(join(clone, file)), { recursive: true });
        writeFileSync(join(clone, file), text);
      }
      for (const [file, text] of m.append ?? []) appendFileSync(join(clone, file), text);
      if (m.regen !== false) await run(clone, 'node', ['scripts/generate-pstack-harness-trees.mjs']);
      // A real commit stages its files, and the inventory test reads the index.
      await run(clone, 'git', ['add', '-A']);
      const packageFilesChanged = (await run(clone, 'git', ['diff', '--cached', '--name-only', '--', 'harness'])).output.split('\n').filter(Boolean).length;
      const tests = (await run(clone, ...TEST_COMMAND)).code === 0 ? 'pass' : 'fail';
      rows.push({ id: m.id, area: m.area, desc: m.desc, tests, packageFilesChanged, expected: m.equivalent ? 'equivalent' : m.survives ? 'survives' : 'killed' });
      log(`${m.id.padEnd(4)} tests ${tests}  package files changed ${String(packageFilesChanged).padStart(3)}  ${m.desc}`);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(workers, mutations.length) }, (_, n) => worker(n)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

// One message per problem, each with the cause and the action that fixes it.
export function verdict(rows, mutations) {
  const reason = id => { const m = mutations.find(x => x.id === id); return m.equivalent ?? m.survives; };
  const real = rows.filter(row => row.expected !== 'equivalent');
  const problems = [
    ...rows.filter(row => row.tests === 'pass' && row.expected === 'killed').map(row =>
      `Mutation ${row.id} survived: no test fails when ${row.desc}. Add or restore a test that fails on this fault. Do not mark it \`survives\` or \`equivalent\` and do not delete it: the gate compares the list with the base branch.`),
    ...rows.filter(row => row.tests === 'fail' && row.expected !== 'killed').map(row =>
      `Mutation ${row.id} is recorded as ${row.expected} but the tests now fail on it. Remove its \`${row.expected}\` field in scripts/mutation/mutations.mjs.`),
  ];
  return {
    problems,
    summary: `score: ${real.filter(row => row.tests === 'fail').length}/${real.length} killed, ${rows.length - real.length} equivalent`,
    accepted: rows.filter(row => row.tests === 'pass' && row.expected !== 'killed').map(row => `${row.id} ${row.expected}: ${reason(row.id)}`),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { mutations } = await import('./mutations.mjs');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const args = process.argv.slice(2);
  const option = (name, fallback) => (args.includes(name) ? args.splice(args.indexOf(name), 2)[1] : fallback);
  const workers = Number(option('--workers', Math.min(4, availableParallelism())));
  const out = option('--out');
  const unknown = args.filter(id => !mutations.some(m => m.id === id));
  if (unknown.length > 0) throw new Error(`Unknown mutation: ${unknown.join(' ')}`);
  const started = Date.now();
  let rows;
  try {
    rows = await runMutations({ root, mutations: mutations.filter(m => args.length === 0 || args.includes(m.id)), workers });
  } catch (error) {
    if (!(error instanceof StaleMutation)) throw error;
    console.log(`::error::${error.message}`);
    process.exit(1);
  }
  if (out) writeFileSync(out, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const { problems, summary, accepted } = verdict(rows, mutations);
  console.log(`\n${summary}, ${Math.round((Date.now() - started) / 1000)} s with ${workers} workers`);
  for (const line of accepted) console.log(`  ${line}`);
  for (const problem of problems) console.log(`::error::${problem}`);
  process.exit(problems.length > 0 ? 1 : 0);
}
