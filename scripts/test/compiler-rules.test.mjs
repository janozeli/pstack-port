import assert from 'node:assert/strict';
import test from 'node:test';
import { compileMarkdown } from '../standalone/compile.mjs';
import { EFFORTS, NATIVE_MODELS } from './port-evidence.mjs';

// Inputs the shipped documents may not contain today, so a rule keeps its test when upstream text stops exercising it.
const cases = [
  ['a slash command only where it stands alone',
    'Run /reflect now. Read skills/reflect and docs/reflect. Open https://example.test/reflect or a:/reflect, not https://reflect.example. Keep /reflect-notes and /reflect/x.',
    'Run $pstack:reflect now. Read skills/reflect and docs/reflect. Open https://example.test/reflect or a:/reflect, not https://reflect.example. Keep /reflect-notes and /reflect/x.',
    'Run /pstack:reflect now. Read skills/reflect and docs/reflect. Open https://example.test/reflect or a:/reflect, not https://reflect.example. Keep /reflect-notes and /reflect/x.'],
  ['Cursor dispatch fields',
    'Pass `readonly: true` and `readonly: false`. Use `run_in_background: true`, `environment: "cloud"` and `environment: "local"`. readonly strips MCPs.',
    'Pass a read-only brief and a post-run git status check and tools sufficient for the task. Use the host-supported background dispatch route, the host-supported isolation route and local execution. tool restrictions can remove required integrations.'],
  ['host skill, plugin and manifest directories',
    'Copy .cursor/skills/x, ~/.cursor/skills/y, ~/.cursor/plugins/z and .cursor-plugin/plugin.json.',
    'Copy .agents/skills/x, ~/.agents/skills/y, $CODEX_HOME/plugins/z and .codex-plugin/plugin.json.',
    'Copy .claude/skills/x, $CLAUDE_CONFIG_DIR/skills/y, $CLAUDE_CONFIG_DIR/plugins/z and .claude-plugin/plugin.json.'],
  ['host names and adapter documents',
    'Cursor also exposes hooks. See docs/harness/codex.md and docs/harness/claude-code.md.',
    'the host exposes hooks. See docs/runtime.md and docs/runtime.md.'],
  ['Cursor agent kinds',
    'Starting any agent, whether a Task subagent or a Project worker, reads worker.md.',
    'Starting any agent, whether a delegate or an isolated worker, reads worker.md.'],
  ['the built-in babysit skill',
    'PR status → the **Babysit** playbook, not Cursor\'s built-in babysit skill. Landing a green stack.',
    'PR status → the **Babysit** playbook bundled with this package. Landing a green stack.'],
  ['session history location',
    'Read the `agent-transcripts/` directory the system prompt names, then the `agent-transcripts/` directory.',
    'Read the verified session-history location described in docs/runtime.md, then the verified session-history location.'],
];

for (const [name, input, codex, claude = codex] of cases) {
  test(`compiler rewrites ${name}`, () => {
    const action = 'The compiler output changed for this input. If the pull request does not mean to change what the packages say, fix scripts/standalone/compile.mjs. Change the expected text only for an intended change.';
    assert.equal(compileMarkdown('example.md', input, 'Codex', ['reflect']), codex, `Codex: ${action}`);
    assert.equal(compileMarkdown('example.md', input, 'Claude Code', ['reflect']), claude, `Claude Code: ${action}`);
  });
}

test('actual compiler emits a connected trace including native model and command changes', () => {
  for (const host of ['Codex', 'Claude Code']) {
    const input = 'Keep this literal. gemini-4-carbon-high-fast /reflect End.';
    const steps = [];
    const output = compileMarkdown('example.md', input, host, ['reflect'], s => steps.push(s));
    let cursor = input;
    for (const step of steps) { assert.equal(step.input, cursor); cursor = step.output; }
    assert.equal(cursor, output);
    assert.equal(steps.length, 2);
  }
});

test('every source model spelling compiles to the policy model and keeps its effort', () => {
  for (const [tree, host] of [['codex', 'Codex'], ['claude-code', 'Claude Code']]) {
    const tokens = Object.entries(NATIVE_MODELS[tree]).flatMap(([family, native]) =>
      EFFORTS.flatMap(effort => ['', '-fast'].map(fast => ({ source: `${family}-${effort}${fast}`, native: `${native} ${effort}` }))));
    assert.equal(tokens.length, 40);
    for (const a of tokens) for (const b of tokens)
      assert.equal(compileMarkdown('example.md', `${a.source}, ${b.source}`, host, []), `${a.native}, ${b.native}`);
  }
});

test('the delegate agent keeps a native default model only where the host reads agent frontmatter', () => {
  const input = '---\nname: poteto-agent\nmodel: claude-opus-5-5-xhigh-fast\n---\n\n# Poteto subagent\n';
  assert.match(compileMarkdown('agents/poteto-agent.md', input, 'Claude Code', []), /^---\nname: poteto-agent\nmodel: opus\n---/);
  assert.match(compileMarkdown('agents/poteto-agent.md', input, 'Codex', []), /^---\nname: poteto-agent\n---/);
});
