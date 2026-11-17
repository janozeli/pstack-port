import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render, sourceFile, TARGETS, VENDORED } from '../generate-pstack-harness-trees.mjs';
import { coordinator, readonlyAgent, runtime } from '../standalone/runtime.mjs';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// The port policy, stated apart from the compiler: each source model family and the native model each package gives it.
export const NATIVE_MODELS = {
  codex: { 'claude-opus-5-5': 'gpt-6.1-sol', 'claude-fable-5-2': 'gpt-6-astra', 'gemini-4-carbon': 'gpt-6.1-sol' },
  'claude-code': { 'claude-opus-5-5': 'opus', 'claude-fable-5-2': 'fable', 'gemini-4-carbon': 'opus' },
};
export const INVOKE = { codex: '$pstack:', 'claude-code': '/pstack:' };

// Every replaced span that is exactly a source model or a slash command has one allowed result.
export function syntaxRules(tree, skills) {
  const rules = new Map();
  for (const [family, native] of Object.entries(NATIVE_MODELS[tree]))
    for (const effort of EFFORTS)
      for (const fast of ['', '-fast']) rules.set(`${family}-${effort}${fast}`, `${native} ${effort}`);
  for (const skill of skills) rules.set(`/${skill}`, INVOKE[tree] + skill);
  return rules;
}

// Source paths the packages leave out on purpose; plugin.json ships as the host manifests instead.
// Every other tracked file under pstack/ must ship, so a new upstream path fails until it ships or is listed here.
export const NOT_SHIPPED = [/^\.cursor-plugin\//, /^\.gitignore$/, /^assets\//, /^automations\//, /^docs\/harness\//, /^plugin\.json$/];

// The file list comes from git, not from a directory walk, so it shares no traversal or skip rule with the generator.
function tracked(root, dir) {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', dir], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  return listed.split('\0').filter(file => file && existsSync(join(root, file))).map(file => file.slice(dir.length + 1));
}

export function walk(root, dir = '') {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry => {
    assert.ok(!entry.isSymbolicLink(), `Unexpected symlink: ${dir}/${entry.name}`);
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(root, path) : [path];
  }).sort();
}

export function readRoles(text) {
  const blocks = [...text.matchAll(/# budget:[^\n]*\n([\s\S]*?)\n```/g)];
  assert.equal(blocks.length, 1, 'Expected one complete role table');
  return blocks[0][1].split('\n').map(line => {
    const split = line.indexOf(': ');
    assert.ok(split > 0, `Invalid role: ${line}`);
    return { name: line.slice(0, split), seats: line.slice(split + 2).split(', ') };
  });
}

const entry = (path, bytes, executable) => ({ path, sha256: createHash('sha256').update(bytes).digest('hex'), executable });
const executable = file => (statSync(file).mode & 0o111) !== 0;
const byPath = entries => entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

// One bundle per package: the rewrite steps the real render emits, and three inventories.
// `expected` comes from the source files and the port policy, `produced` from the renderer, `actual` from the committed tree.
export function collect(root) {
  const source = join(root, 'pstack');
  const skills = [...readdirSync(join(source, 'skills')), ...VENDORED.skills].sort();
  const vendored = VENDORED.skills.flatMap(skill => [...tracked(root, `${VENDORED.root}/skills/${skill}`).map(file => `skills/${skill}/${file}`), `skills/${skill}/LICENSE`]);
  const sourcePaths = [...tracked(root, 'pstack').filter(path => !NOT_SHIPPED.some(rule => rule.test(path))), ...vendored].sort();
  return TARGETS.map(target => {
    const tree = join(root, 'harness/pstack', target.tree);
    const traces = new Map();
    const rendered = render(target, (path, step) => {
      if (!traces.has(path)) traces.set(path, []);
      traces.get(path).push(step);
    });
    const otherHost = `skills/poteto-mode/scripts/${target.tree === 'codex' ? 'claude' : 'codex'}-worktree-activity.mjs`;
    const paths = sourcePaths.filter(path => path !== otherHost);
    const expected = paths.map(path => {
      const steps = traces.get(path);
      return entry(path, steps ? Buffer.from(steps.at(-1).output) : readFileSync(sourceFile(path)), executable(sourceFile(path)));
    });
    expected.push(entry('docs/runtime.md', Buffer.from(runtime(target.harness)), false));
    if (target.tree !== 'codex') expected.push(entry('agents/poteto-mode.md', Buffer.from(coordinator), false));
    if (target.tree !== 'codex') expected.push(entry('agents/poteto-readonly.md', Buffer.from(readonlyAgent), false));
    const manifest = { ...JSON.parse(readFileSync(join(source, 'plugin.json'))), ...target.manifestFields };
    for (const path of target.manifests) expected.push(entry(path, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), false));
    if (target.tree === 'codex') for (const skill of skills) {
      const frontmatter = readFileSync(sourceFile(`skills/${skill}/SKILL.md`), 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      if (/^disable-model-invocation:\s*true\s*$/m.test(frontmatter))
        expected.push(entry(`skills/${skill}/agents/openai.yaml`, Buffer.from('policy:\n  allow_implicit_invocation: false\n'), false));
    }
    return {
      tree: target.tree,
      skills,
      sourcePaths: paths,
      traces: [...traces].map(([path, steps]) => ({ path, steps })),
      expected: byPath(expected),
      produced: byPath([...rendered].map(([path, file]) => entry(path, file.bytes, file.executable))),
      actual: byPath(walk(tree).map(path => entry(path, readFileSync(join(tree, path)), executable(join(tree, path))))),
      sourceRoles: readRoles(readFileSync(join(source, 'skills/setup-pstack/SKILL.md'), 'utf8')),
      nativeRoles: readRoles(readFileSync(join(tree, 'skills/setup-pstack/SKILL.md'), 'utf8')),
    };
  });
}
