import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEdits, rewriter } from '../standalone/edits.mjs';
import { compileMarkdown } from '../standalone/compile.mjs';
import { EFFORTS, NATIVE_MODELS } from './port-evidence.mjs';

for (const [input, pattern, replacement, all] of [
  ['aXbXc', 'X', "[$`][$&][$']", false],
  ['abc', /(a)(b)(c)/, '$1-$2-$3-$$-$12-$01-$0', false],
  ['a a', /(?<letter>a)/g, '$<letter> $<missing>', false],
  ['😀alpha/reflect end', /\/reflect/g, '$pstack:reflect', false],
  ['aaa', /(?=a)/g, '-', false],
  ['abc', '', '-', true],
  ['a1a2', /a(\d)/g, (_, n, index) => `${index}:${n}`, false],
  ['nothing', /x/g, 'y', false],
]) {
  test(`certified edits preserve native replacement semantics: ${input} ${pattern}`, () => {
    const steps = [];
    const engine = rewriter(s => steps.push(s));
    const actual = all ? engine.replaceAll(input, pattern, replacement) : engine.replace(input, pattern, replacement);
    assert.equal(actual, all ? input.replaceAll(pattern, replacement) : input.replace(pattern, replacement));
    for (const step of steps) {
      assert.equal(step.chunks.map(c => c.keep + c.before).join('') + step.tail, input);
      assert.equal(step.chunks.map(c => c.keep + c.after).join('') + step.tail, actual);
    }
  });
}

test('overlapping, reversed and out-of-bounds edits are rejected before construction', () => {
  for (const edits of [
    [{ start: 0, end: 2, after: 'x' }, { start: 1, end: 3, after: 'y' }],
    [{ start: 2, end: 1, after: 'x' }], [{ start: 0, end: 4, after: 'x' }],
    [{ start: -1, end: 1, after: 'x' }], [{ start: 0.5, end: 1, after: 'x' }],
  ]) assert.throws(() => applyEdits('abc', edits), /Invalid or overlapping/);
});

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
