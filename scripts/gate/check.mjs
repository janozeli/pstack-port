#!/usr/bin/env node
// The merge gate for the port. The `Gate` workflow runs this file from the default branch against a checkout
// of the pull request, so the pull request cannot edit the gate that judges it.
//
//   node scripts/gate/check.mjs <checkout> [--base REF] [--workers N]
//
// In CI the checkout is the pull request merged into the base branch, so the base is HEAD^1.
// Locally, pass the base branch: node scripts/gate/check.mjs . --base origin/main
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mutations as baseMutations } from '../mutation/mutations.mjs';
import { runMutations, StaleMutation, TEST_COMMAND, verdict } from '../mutation/run.mjs';

const pr = resolve(process.argv[2] ?? '.');
const option = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const workers = option('--workers') && Number(option('--workers'));
const base = option('--base') ?? 'HEAD^1';

const GATE_FILES = /^(?:\.github\/|scripts\/gate\/|scripts\/mutation\/run\.mjs$)/;
const PORT_INPUTS = /^(?:scripts\/standalone\/|scripts\/generate-|scripts\/test\/|scripts\/mutation\/|pstack\/|harness\/pstack\/|cursor-team-kit\/skills\/(?:control-cli|control-ui|deslop)\/|package(?:-lock)?\.json$)/;

const sh = (cmd, argv, cwd = pr) => spawnSync(cmd, argv, { cwd, encoding: 'utf8', maxBuffer: 256 << 20 });
// One annotation per problem: the cause, then the action that fixes it.
const problems = [];
const problem = (title, text) => {
  problems.push(title);
  console.log(`::error title=${title}::${text.replace(/\n/g, '%0A')}`);
};
function finish() {
  if (problems.length === 0) console.log('\nGATE PASSED');
  else console.log(`\nGATE FAILED: ${problems.join('; ')}. Each ::error:: line above gives the cause and the fix.`);
  process.exit(problems.length === 0 ? 0 : 1);
}

const changed = sh('git', ['diff', '--name-only', `${base}...HEAD`]).stdout.split('\n').filter(Boolean);
console.log(`${changed.length} files changed against the base branch`);

const gateFiles = changed.filter(file => GATE_FILES.test(file));
if (gateFiles.length > 0) problem('The pull request changes the gate',
  `${gateFiles.join(', ')} define the merge gate. The gate runs from main, so it cannot judge its own replacement, and no change in this pull request can make this check pass. Move every other change to a separate pull request. Then stop and tell the repository owner that this one needs the owner to merge it.`);

if (!changed.some(file => PORT_INPUTS.test(file))) {
  console.log('No port input changed: the tests and the mutation run are skipped.');
  finish();
}

// The pull request's list is data here. It is read in a child process, so its code cannot end this one.
const reader = `import(${JSON.stringify(pathToFileURL(resolve(pr, 'scripts/mutation/mutations.mjs')).href)}).then(m => process.stdout.write(JSON.stringify(m.mutations, (key, value) => value instanceof RegExp ? { regexp: value.source, flags: value.flags } : value)))`;
const read = sh('node', ['--input-type=module', '-e', reader]);
let prMutations = [];
try {
  prMutations = JSON.parse(read.stdout, (key, value) => (value && typeof value.regexp === 'string' ? new RegExp(value.regexp, value.flags) : value));
} catch {
  problem('The mutation list cannot be read', `scripts/mutation/mutations.mjs must export \`mutations\` as an array. ${read.stderr.trim().split('\n').at(-1) ?? ''}`);
}
const accepted = list => new Map(list.filter(m => m.survives || m.equivalent).map(m => [m.id, m]));
const removed = baseMutations.filter(m => !prMutations.some(x => x.id === m.id)).map(m => m.id);
const newlyAccepted = [...accepted(prMutations).keys()].filter(id => !accepted(baseMutations).has(id));
if (prMutations.length > 0 && removed.length > 0) problem('Mutations were removed',
  `${removed.join(', ')} are in the base branch and not in this pull request. A fault that the tests caught must stay caught. Restore them in scripts/mutation/mutations.mjs. If the code that one edits is gone for good, removing it is the owner's decision: restore it here, say so in the pull request, and stop.`);
if (newlyAccepted.length > 0) problem('New accepted survivors',
  `${newlyAccepted.join(', ')} are marked \`survives\` or \`equivalent\` in this pull request and not in the base branch. A pull request cannot accept its own surviving fault. Remove the mark and add or restore the test that fails on the fault.`);

// A base mutation that still applies runs as the base branch wrote it. Only one whose target changed uses the pull request's edits.
const applies = m => (m.edits ?? []).every(([file, find, replace]) => {
  const text = sh('git', ['show', `HEAD:${file}`]).stdout;
  return text.replace(find, replace) !== text;
});
const stale = baseMutations.filter(m => prMutations.some(x => x.id === m.id) && !applies(m)).map(m => m.id);
// Rewritten means the pull request changed the entry. A fault planted by a defect only stops applying.
const same = (a, b) => JSON.stringify([a.edits, a.write, a.append], (key, value) => (value instanceof RegExp ? String(value) : value)) === JSON.stringify([b.edits, b.write, b.append], (key, value) => (value instanceof RegExp ? String(value) : value));
const rewritten = stale.filter(id => !same(baseMutations.find(m => m.id === id), prMutations.find(m => m.id === id)));

// Packages that change while the source does not mean the port's own behavior changed. With rewritten
// expectations on top, the pull request has redefined what is correct instead of fixing the code.
const SOURCE = /^(?:pstack\/|cursor-team-kit\/skills\/(?:control-cli|control-ui|deslop)\/)/;
const packages = changed.filter(file => file.startsWith('harness/pstack/'));
const deletedTestLines = sh('git', ['diff', '--numstat', `${base}...HEAD`, '--', 'scripts/test']).stdout.split('\n').filter(Boolean)
  .map(line => line.split('\t')).filter(([, deleted]) => Number(deleted) > 0).map(([, deleted, file]) => `${file} (${deleted} lines)`);
if (packages.length > 0 && !changed.some(file => SOURCE.test(file)) && (deletedTestLines.length > 0 || rewritten.length > 0)) problem('The pull request redefines what the port promises',
  `${packages.length} generated package files change although no source file under pstack/ changed, and existing expectations were rewritten or removed${deletedTestLines.length > 0 ? ` in ${deletedTestLines.join(', ')}` : ''}${rewritten.length > 0 ? `, with mutations ${rewritten.join(', ')} rewritten` : ''}. If the package change is not the purpose of this pull request, it is a defect: restore the compiler or generator behavior and the original expectations, so that harness/pstack/ returns to the base branch's content. If the change is the purpose, it is the owner's decision: say so in the pull request and stop.`);

const step = (title, cmd, argv, action) => {
  console.log(`\n== ${title}`);
  const result = sh(cmd, argv);
  if (result.status === 0) return true;
  const output = `${result.stdout}\n${result.stderr}`.trim();
  console.log(output.split('\n').slice(-200).join('\n'));
  problem(`${title} failed`, action(output));
  return false;
};
// TAP puts each failure's message in an `error:` field under its `not ok` line.
const failedTests = output => [...output.matchAll(/^not ok \d+ - (.*)\n(?:(?!^(?:not )?ok ).*\n)*?\s+error: (?:\|-\n\s+)?(.*)$/gm)].map(m => `${m[1]}: ${m[2]}`.slice(0, 700));

if (process.env.CI) step('Install', 'npm', ['ci'], () => 'npm ci failed. package-lock.json and package.json must agree.');
const testsPass = step('Tests', ...TEST_COMMAND, output =>
  `${failedTests(output).join('\n') || 'A test failed: see the log above.'}\nFix the code, not the test. Change an expected value only when the pull request means to change what the packages contain, and say so in its description.`);
step('Generated packages', 'node', ['scripts/generate-pstack-harness-trees.mjs', '--check'], () =>
  'harness/pstack/ is not what the generator produces from this commit. Run `node scripts/generate-pstack-harness-trees.mjs` and commit the result. Never edit harness/pstack/ by hand.');
step('Source documents', 'node', ['scripts/check-pstack-docs.mjs'], output => `check-pstack-docs reports: ${output.split('\n').slice(0, 5).join(' / ')}`);
step('Plugin manifests', 'node', ['scripts/validate-plugins.mjs'], output => `validate-plugins reports: ${output.split('\n').filter(line => /FAIL|error/i.test(line)).slice(0, 5).join(' / ')}`);

// The mutation run is the slow step, so it waits until everything cheaper passes.
if (problems.length === 0 && testsPass && prMutations.length > 0) {
  console.log('\n== Mutation run');
  const list = prMutations.map(m => {
    const base = baseMutations.find(x => x.id === m.id);
    if (!base || stale.includes(m.id)) {
      if (base && rewritten.includes(m.id)) console.log(`::warning title=Mutation ${m.id} was rewritten::Its target changed in this pull request, so the pull request's edits run. Check that it still plants the same fault: ${base.desc}`);
      return m;
    }
    return { ...base, survives: m.survives, equivalent: m.equivalent };
  });
  try {
    const rows = await runMutations({ root: pr, mutations: list, workers });
    const result = verdict(rows, list);
    console.log(`\n${result.summary}`);
    for (const line of result.accepted) console.log(`  ${line}`);
    for (const text of result.problems) problem(text.split(':')[0], text);
  } catch (error) {
    if (!(error instanceof StaleMutation)) throw error;
    problem('A mutation no longer applies', error.message);
  }
}
finish();
