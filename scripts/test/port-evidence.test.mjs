import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sourceFile } from '../generate-pstack-harness-trees.mjs';
import { collect, EFFORTS, syntaxRules, walk } from './port-evidence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bundles = collect(root);

function difference(expected, actual) {
  const want = new Map(expected.map(e => [e.path, e]));
  const have = new Map(actual.map(e => [e.path, e]));
  return {
    missing: [...want.keys()].filter(path => !have.has(path)),
    extra: [...have.keys()].filter(path => !want.has(path)),
    changedBytes: [...want.keys()].filter(path => have.has(path) && have.get(path).sha256 !== want.get(path).sha256),
    changedMode: [...want.keys()].filter(path => have.has(path) && have.get(path).executable !== want.get(path).executable),
  };
}
// Spellings only one package may contain. A seat on the other provider is written `provider:model effort`, so it is not a native seat.
const HOST_ONLY = {
  codex: [/\$pstack:/, /\bspawn_agent\b/, /\$CODEX_HOME\b/, /\.agents\/skills\//, /\.codex-plugin\b/, /\bAGENTS\.md\b/, /\brequest_user_input\b/, /\bcodex -p poteto\b/,
    new RegExp(String.raw`(?<![:\w])gpt-6[\w.-]*`)],
  'claude-code': [/\/pstack:/, /\$CLAUDE_CONFIG_DIR\b/, /\.claude\/skills\//, /\.claude-plugin\b/, /\bpstack-models\.md\b/, /\bAskUserQuestion\b/, /\bclaude --agent\b/, /\bCLAUDE_SESSION_ID\b/,
    new RegExp(String.raw`(?<![:\w])(?:opus|fable|haiku|sonnet) (?:${EFFORTS.join('|')})\b`)],
};
const same = { missing: [], extra: [], changedBytes: [], changedMode: [] };

test('both packages are checked', () => {
  assert.deepEqual(bundles.map(b => b.tree).sort(), ['claude-code', 'codex']);
});

for (const bundle of bundles) {
  const { tree } = bundle;
  const rules = syntaxRules(tree, bundle.skills);

  test(`${tree} ships exactly the files, bytes and executable bits derived from source`, () => {
    assert.ok(bundle.expected.length > 500, 'the derived inventory is not empty');
    assert.equal(new Set(bundle.expected.map(e => e.path)).size, bundle.expected.length, 'each path is derived once');
    assert.deepEqual(difference(bundle.expected, bundle.actual), same, 'committed package against source');
    assert.deepEqual(difference(bundle.expected, bundle.produced), same, 'renderer output against source');
  });

  test(`${tree} ships no spelling that belongs to the other host`, () => {
    const foreign = Object.entries(HOST_ONLY).filter(([host]) => host !== tree).flatMap(([, spellings]) => spellings);
    const found = bundle.actual.flatMap(({ path }) => {
      const text = readFileSync(join(root, 'harness/pstack', tree, path), 'latin1');
      return foreign.flatMap(spelling => (text.match(spelling) ? [`${path}: ${text.match(spelling)[0]}`] : []));
    });
    assert.deepEqual(found, []);
  });

  test(`${tree} role table maps every source seat by the model policy`, () => {
    assert.ok(bundle.sourceRoles.length > 0);
    const translated = bundle.sourceRoles.map(role => ({
      name: role.name,
      seats: role.seats.map(seat => rules.get(seat) ?? `no rule for ${seat}`),
    }));
    assert.deepEqual(bundle.nativeRoles, translated);
  });

  test(`${tree} rewrite chains rebuild every compiled file from its source`, () => {
    assert.ok(bundle.traces.length > 0);
    for (const { path, steps } of bundle.traces) {
      assert.ok(bundle.sourcePaths.includes(path), `${path}: rewritten file has no source`);
      let text = readFileSync(sourceFile(path), 'utf8');
      for (const step of steps) {
        assert.equal(step.chunks.map(c => c.keep + c.before).join('') + step.tail, text, `${path}: ${step.rule} does not start where the previous step ended`);
        assert.equal(step.chunks.map(c => c.keep + c.after).join('') + step.tail, step.output, `${path}: ${step.rule} output is not its own edits applied`);
        for (const chunk of step.chunks)
          if (rules.has(chunk.before)) assert.equal(chunk.after, rules.get(chunk.before), `${path}: ${step.rule} rewrote ${chunk.before}`);
        text = step.output;
      }
      assert.equal(readFileSync(join(root, 'harness/pstack', tree, path), 'utf8'), text, `${path}: committed file is not the end of its chain`);
    }
  });
}

test('package enumeration lists development dependencies and rejects symlinks', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pstack-inventory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'unexpected'), 'bytes');
  writeFileSync(join(dir, '.DS_Store'), 'bytes');
  assert.deepEqual(walk(dir), ['.DS_Store', 'node_modules/unexpected']);
  symlinkSync('node_modules/unexpected', join(dir, 'link'));
  assert.throws(() => walk(dir), /Unexpected symlink/);
});
