import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { applyEdits, rewriter } from '../standalone/edits.mjs';

const text = fc.array(fc.constantFrom('a', 'b', 'c', 'X', '$', '/', '-', ' ', '\n', '😀'), { maxLength: 24 }).map(chars => chars.join(''));
const regex = fc.constantFrom(
  ['a', ''], ['a', 'g'], ['(a)(b)?', 'g'], ['(?<x>a)|(?<y>b)', 'g'], ['(?=a)', 'g'], ['\\b', 'g'], ['[abc]+', 'g'], ['^.*$', 'm'], ['^.*$', 'gm'],
  ['(?:)', 'g'], ['X*', 'g'], ['a|ab', 'g'], ['(.)\\1', 'g'], ['.', 'gu'], ['\\$', ''], ['(a)?(b)?(c)?(X)?(a)?(b)?(c)?(X)?(a)?(b)?(c)', 'g'],
);
const template = fc.array(fc.constantFrom('$$', '$&', '$`', "$'", '$1', '$2', '$9', '$10', '$11', '$12', '$01', '$00', '$0', '$<x>', '$<y>', '$<z>', '$<', '$', 'x', '-', ' '), { maxLength: 5 })
  .map(parts => parts.join(''));
const callback = fc.constantFrom(
  match => `[${match}]`,
  (...args) => args.findIndex(arg => typeof arg === 'number'),
  (match, ...rest) => rest.filter(arg => typeof arg === 'string').join('|'),
  () => 7,
  () => undefined,
  () => '$&',
);

function native(input, pattern, replacement, all) {
  try { return { value: all ? input.replaceAll(pattern, replacement) : input.replace(pattern, replacement) }; }
  catch (error) { return { threw: error.constructor.name }; }
}

test('replace and replaceAll equal the native String methods and emit the edits they applied', () => {
  fc.assert(fc.property(text, fc.oneof(text, regex), fc.oneof(template, callback), fc.boolean(), (input, pattern, replacement, all) => {
    const build = () => (typeof pattern === 'string' ? pattern : new RegExp(...pattern));
    const steps = [];
    const engine = rewriter(step => steps.push(step));
    const expected = native(input, build(), replacement, all);
    if (expected.threw) {
      assert.throws(() => (all ? engine.replaceAll : engine.replace)(input, build(), replacement), error => error.constructor.name === expected.threw);
      return;
    }
    const actual = all ? engine.replaceAll(input, build(), replacement) : engine.replace(input, build(), replacement);
    assert.equal(actual, expected.value);
    assert.equal(steps.length, actual === input ? 0 : 1, 'one step exactly when the text changed');
    for (const step of steps) {
      assert.equal(step.input, input);
      assert.equal(step.output, actual);
      assert.equal(step.chunks.map(c => c.keep + c.before).join('') + step.tail, input);
      assert.equal(step.chunks.map(c => c.keep + c.after).join('') + step.tail, actual);
    }
  }), { numRuns: 2000 });
});

test('ordered disjoint edits equal the same splices applied from the end', () => {
  const edits = text.chain(input => fc.tuple(fc.constant(input),
    fc.array(fc.tuple(fc.nat(input.length), fc.nat(input.length), text), { maxLength: 4 }).map(spans => {
      let cursor = 0;
      return spans.map(([a, b, after]) => [Math.min(a, b), Math.max(a, b), after]).sort((x, y) => x[0] - y[0] || x[1] - y[1])
        .flatMap(([start, end, after]) => (start < cursor ? [] : [{ start, end: (cursor = end), after }]));
    })));
  fc.assert(fc.property(edits, ([input, spans]) => {
    const expected = spans.reduceRight((out, { start, end, after }) => out.slice(0, start) + after + out.slice(end), input);
    assert.equal(applyEdits(input, spans), expected);
  }), { numRuns: 1000 });
});

test('overlapping, reversed and out-of-bounds edits are rejected before construction', () => {
  for (const edits of [
    [{ start: 0, end: 2, after: 'x' }, { start: 1, end: 3, after: 'y' }],
    [{ start: 2, end: 1, after: 'x' }], [{ start: 0, end: 4, after: 'x' }],
    [{ start: -1, end: 1, after: 'x' }], [{ start: 0.5, end: 1, after: 'x' }],
    [{ start: 0, end: 1, after: 7 }],
  ]) assert.throws(() => applyEdits('abc', edits), /Invalid or overlapping/);
});
