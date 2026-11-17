import assert from 'node:assert/strict';
import test from 'node:test';
import { compileMarkdown } from '../standalone/compile.mjs';
import { EFFORTS, NATIVE_MODELS } from './port-evidence.mjs';

test('actual compiler emits a connected trace including native model and command changes', () => {
  for (const host of ['Codex', 'Claude Code']) {
    const input = 'Keep this literal. grok-4.7-high-fast /reflect End.';
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

test('package enumeration lists development dependencies and rejects symlinks', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { walk } = await import('./port-evidence.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'pstack-inventory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'unexpected'), 'bytes');
  writeFileSync(join(dir, '.DS_Store'), 'bytes');
  assert.deepEqual(walk(dir), ['.DS_Store', 'node_modules/unexpected']);
  symlinkSync('node_modules/unexpected', join(dir, 'link'));
  assert.throws(() => walk(dir), /Unexpected symlink/);
});
