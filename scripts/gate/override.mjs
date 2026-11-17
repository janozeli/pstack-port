#!/usr/bin/env node
// The owner's override. It merges one pull request that the gate fails by design, such as a change to the gate.
// It lifts only the `gate` check, merges the exact commit it inspected, and puts the check back.
//
//   node scripts/gate/override.mjs <pull request number> --reason "<why the owner accepts it>"
//   node scripts/gate/override.mjs --restore        put the required checks back after an interrupted run
//
// Run it only when the owner's own message names the pull request and asks for the override.
import { spawnSync } from 'node:child_process';

const REPO = 'janozeli/pstack-port';
const BRANCH = 'main';
const ACTIONS = 15368;
// The checks that main requires. `--restore` writes this list.
const REQUIRED = ['gate', 'validate', 'statechart', 'bun-tools (pstack/skills/poteto-mode/scripts)', 'bun-tools (orchestrate/skills/orchestrate/scripts)',
  'native-install (codex, @openai/codex@0.165.0)', 'native-install (claude, @anthropic-ai/claude-code@2.1.312)'];

function gh(args, input) {
  const result = spawnSync('gh', args, { encoding: 'utf8', input });
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}
const checksPath = `repos/${REPO}/branches/${BRANCH}/protection/required_status_checks`;
const setRequired = contexts => gh(['api', '-X', 'PATCH', checksPath, '--input', '-'],
  JSON.stringify({ strict: true, checks: contexts.map(context => ({ context, app_id: ACTIONS })) }));
const required = () => JSON.parse(gh(['api', checksPath])).checks.map(check => check.context).sort();
function restore() {
  setRequired(REQUIRED);
  const now = required();
  if (JSON.stringify(now) !== JSON.stringify([...REQUIRED].sort())) throw new Error(`The required checks are ${now.join(', ')} after the restore. Fix branch protection by hand.`);
  console.log(`main requires: ${now.join(', ')}`);
}

const args = process.argv.slice(2);
if (args[0] === '--restore') {
  restore();
  process.exit(0);
}
const number = Number(args[0]);
const reason = args[args.indexOf('--reason') + 1];
if (!Number.isInteger(number) || !args.includes('--reason') || !reason?.trim()) {
  console.error('Usage: node scripts/gate/override.mjs <pull request number> --reason "<why the owner accepts it>"');
  process.exit(2);
}

const pr = JSON.parse(gh(['pr', 'view', String(number), '--repo', REPO, '--json', 'state,baseRefName,headRefOid,statusCheckRollup,url']));
if (pr.state !== 'OPEN' || pr.baseRefName !== BRANCH) throw new Error(`Pull request ${number} is not open against ${BRANCH}.`);
// Every other required check still binds. The override lifts the gate and nothing else.
const conclusion = name => pr.statusCheckRollup.filter(check => check.name === name).map(check => check.conclusion);
const notGreen = REQUIRED.filter(name => name !== 'gate' && !(conclusion(name).length > 0 && conclusion(name).every(c => c === 'SUCCESS')));
if (notGreen.length > 0) throw new Error(`These required checks are not green on ${pr.headRefOid.slice(0, 7)}: ${notGreen.join(', ')}. The override does not cover them.`);

let merged = false;
try {
  setRequired(REQUIRED.filter(name => name !== 'gate'));
  gh(['pr', 'merge', String(number), '--repo', REPO, '--merge', '--match-head-commit', pr.headRefOid]);
  merged = true;
} finally {
  restore();
}
if (merged) {
  gh(['pr', 'comment', String(number), '--repo', REPO, '--body-file', '-'],
    `Merged by the owner's override at ${pr.headRefOid.slice(0, 7)}. The \`gate\` check was lifted for this merge and is required again.\n\nReason: ${reason.trim()}`);
  console.log(`Merged ${pr.url} at ${pr.headRefOid.slice(0, 7)}.`);
}
