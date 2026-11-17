# Tests and CI

Run repository checks with Node.js 22.23.4 and install the committed dependency tree with `npm ci`. Bun tool packages use Bun 1.3.14 and their own committed lockfiles. Install Git, Bash, jq and ripgrep for worktree audit fixtures. No production accounts or external model calls are required by CI.

```bash
npm ci
node scripts/validate-plugins.mjs
node scripts/generate-pstack-harness-trees.mjs --check
node scripts/check-pstack-docs.mjs
npm test
npm run typecheck:statechart

(cd pstack/skills/poteto-mode/scripts && bun install --frozen-lockfile && bun run test && bun run typecheck)
(cd orchestrate/skills/orchestrate/scripts && bun install --frozen-lockfile && bun run test && bun run typecheck)
```

The generated packages are built from `pstack/` and the compiler. After changing either, run `node scripts/generate-pstack-harness-trees.mjs` and commit the generated output. Tests exercise each host's installed audit script, native model and effort mappings, plan checker, manifest fields, relative links and anchors, skill inventory, panel sizes and invocation policies. The source Cursor behavior remains covered separately.

## Statechart and TLC

TLC is the TLA+ model checker. The suite compares statechart results against real TLC, in addition to deterministic replay fixtures and renderer checks. Use Java 17 and TLC 1.7.4, the same TLC release used by the skill. Download it into a temporary tools directory and verify its checksum:

```bash
mkdir -p /tmp/pstack-test-tools
curl --fail --location --retry 3 https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar --output /tmp/pstack-test-tools/tla2tools.jar
echo '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88  /tmp/pstack-test-tools/tla2tools.jar' | sha256sum --check
export TLA2TOOLS=/tmp/pstack-test-tools/tla2tools.jar
npm run test:statechart
```

Without `TLA2TOOLS`, local integration cases explicitly skip. This is a partial run, not full verification. CI installs the jar, verifies the checksum, checks that it exists, and requires the final TAP summary to report zero skipped tests. Renderer dependencies are installed from the root lockfile before the tests; tests do not install packages into a shared home cache. File-level concurrency is limited to two to bound Java and rendering load.

Cancellation tests hold the worker at an observed write through a test-only Node preload, then send the real signal to the command. This exercises cleanup without racing a transient directory rename or adding a production test hook.

## Native installation

The smoke check uses the real host CLI, the distribution's marketplace metadata and only the generated package, copied into a disposable marketplace. It creates temporary home/configuration directories, verifies discovery and compares the installed bytes and executable bits against the package. It removes those directories afterward and never invokes a model.

```bash
python3 scripts/check-native-install.py codex --require
python3 scripts/check-native-install.py claude --require
```

Use `--cli /absolute/path/to/binary` if a version-manager shim depends on the original home directory. Without `--require`, a missing CLI reports `SKIP`; an installed CLI that fails always fails the check. CI uses `--require` with Codex 0.165.0 and Claude Code 2.1.312. Update these versions deliberately when adopting a new host contract. These checks prove installation and discovery, not every agent-driven workflow or optional external service.

## Port checks

`npm test` runs the real renderer and compares three inventories for each host: the files derived from `git ls-files pstack` and the port policy, the renderer output, and the committed package, by path, bytes and executable bit. A tracked source path must ship or be listed in `NOT_SHIPPED` in `scripts/test/port-evidence.mjs`. The same run checks each native role seat against the model policy, rebuilds each compiled file from its source through the emitted rewrite steps, and rejects any source model spelling in a shipped file. Property tests compare the rewrite engine with the native `String` replacement methods.

## Mutation run

`npm run test:mutation` checks the tests themselves. `scripts/mutation/mutations.mjs` lists realistic faults in the compiler, the rewrite engine, the generator and the source. For each one the runner clones `HEAD`, applies the fault, regenerates the packages as a real commit would, and runs `npm test`. A fault that `npm test` does not catch fails the run unless its entry records why it is accepted (`survives`) or why it changes nothing (`equivalent`). The runner tests committed code only, so commit before you run it. Pass mutation IDs to run a subset.

## The merge gate

The `Gate` workflow is the check that decides whether a pull request may merge. It uses `pull_request_target`, so the workflow file and `scripts/gate/check.mjs` come from the base branch and the pull request cannot edit them. It checks out the pull request merged into the base branch and runs, in this order:

1. It fails if the pull request changes the gate itself: anything under `.github/` or `scripts/gate/`, or `scripts/mutation/run.mjs`.
2. It stops with a pass if no port input changed.
3. It compares the mutation list with the base branch. No mutation may disappear, and none may newly become `survives` or `equivalent`.
4. It fails if the generated packages change while no source file changed and existing test lines were deleted or mutations were rewritten. That pattern means the pull request redefined what is correct.
5. It runs `node --test scripts/test/*.test.mjs` directly, the generator check, the document check and the manifest check.
6. It runs the mutations. One that still applies runs as the base branch wrote it. One whose target code changed runs with the pull request's edits, and the log warns about it.

Each failure is one `::error::` line with the cause and the action. `gh run view <run> --log-failed | grep '::error'` prints them. To run the same gate before you push, commit and run `node scripts/gate/check.mjs . --base origin/main`.

A pull request that the gate cannot pass by design, such as a change to the gate or the removal of a mutation, needs the repository owner.

## After an upstream sync

Merge upstream, then run `node scripts/generate-pstack-harness-trees.mjs` and `npm test`. Each failure below names a decision that the sync needs.

| Failure | Meaning | Action |
| --- | --- | --- |
| `source section changed: <text>` from the generator | Upstream moved or reworded the text that a `section()` call in `scripts/standalone/compile.mjs` replaces. | Update the anchors, and rewrite the replacement if the upstream meaning changed. |
| `unresolved host dependency` from the generator | New source text names a Cursor feature. | Add a rewrite rule and a case in `scripts/test/compiler-rules.test.mjs`. |
| `no rule for <seat>` in the role table test, or a source model spelling in a shipped file | Upstream changed its default models. | Decide the native model for each host, then update `NATIVE_MODELS` in `scripts/test/port-evidence.mjs`, the model rules in the compiler, and the mapping text in `README.md`. |
| `missing` or `extra` paths in the inventory test | Upstream added, moved or removed a source path. | Ship it through the generator, or list it in `NOT_SHIPPED` with the reason. |
| A spelling that belongs to the other host | A replacement uses one host's command, path or model in both packages. | Make the replacement depend on the host. |
| `Mutation X no longer applies` | The code that a fault edits changed shape. | Rewrite the `edits` of that entry so that it plants the same fault in the new code. The gate warns about each rewritten mutation. |

Then set the port version in `TARGETS` in the generator to the new upstream version, regenerate, and commit the generated packages with the change. Read the diff under `harness/pstack/`: the tests do not judge the meaning of rewritten prose, so that diff is the review of it.

A rule can stop firing when upstream removes its text. To list such rules, collect the `rule` of every step that `render` emits and compare with the rules in the compiler. Delete a rule only when `git log -S` shows that its text left the source once and did not return, and keep a synthetic case for each rule you keep.

## CI coverage

The workflow runs on every pull request, pushes to `main`, and manual dispatch. It has separate jobs for repository validation, each Bun package, statechart, and each native host. A failure in one suite does not prevent unrelated suites from reporting. The token has read-only repository permissions. Jobs have finite timeouts, and superseded runs are cancelled.

The retained `orchestrate` source is tested and typechecked even though the standalone pstack marketplaces expose only pstack. The CI does not validate live Slack, webhook, multi-provider or cloud-machine behavior: those capabilities require separate host-specific proof when used.
