import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compileMarkdown, compileAudit } from '../standalone/compile.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

for (const [host, tree, judgment, tool, config, code] of [
  ['Codex', 'codex', 'gpt-6.1-sol', 'spawn_agent', '$CODEX_HOME/AGENTS.md', 'gpt-6.1-sol'],
  ['Claude Code', 'claude-code', 'opus', 'Agent', '$CLAUDE_CONFIG_DIR/rules/pstack-models.md', 'opus'],
]) {
  test(`${host} compiles native models, effort, tools and configuration independently`, () => {
    const input = '`claude-opus-5-5-xhigh`, `gemini-4-carbon-high-fast`, `inherit-parent medium`, `auto`, `Task`, `~/.cursor/rules/pstack-models.mdc`';
    const output = compileMarkdown('example.md', input, host, []);
    assert.equal(output, `\`${judgment} xhigh\`, \`${code} high\`, \`inherit-parent medium\`, \`auto\`, \`${tool}\`, \`${config}\``);
  });

  test(`${host} compilation fails when required source sections or shell guards drift`, () => {
    assert.throws(() => compileMarkdown('skills/setup-pstack/SKILL.md', '# Changed', host, []), /source section changed/);
    const audit = readFileSync(join(root, 'pstack/skills/poteto-mode/scripts/worktree-audit.sh'), 'utf8');
    assert.throws(() => compileAudit(audit.replace('harness=cursor', 'harness=other'), host), /source.*changed/);
  });
}
