import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileMarkdown } from '../standalone/compile.mjs';

const skill = 'skills/recall/SKILL.md';
const source = readFileSync(new URL(`../../pstack/${skill}`, import.meta.url), 'utf8');

for (const [host, tree] of [['Codex', 'codex'], ['Claude Code', 'claude-code']]) {
  test(`${host} recall scopes history by workspace before reading conversation content`, () => {
    const compiled = compileMarkdown(skill, source, host, ['recall']);
    const packaged = readFileSync(new URL(`../../harness/pstack/${tree}/${skill}`, import.meta.url), 'utf8');
    for (const [label, text] of [['compiler', compiled], ['package', packaged]]) {
      assert.match(text, /Scope each candidate by workspace metadata before reading conversation content\./,
        `${label}: recall must establish workspace scope before inspecting a conversation`);
    }
  });
}
