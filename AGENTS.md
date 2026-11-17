# pstack-port

This repository ports pstack to Claude Code and Codex. `pstack/` is the upstream source. `scripts/standalone/` compiles it, and `harness/pstack/` holds the two generated packages that users install.

## Rules the checks cannot enforce for you

- A failing check reports a defect. Fix the code that the message names. Do not change an expected value, a test, a mutation or a list such as `NOT_SHIPPED` or `HOST_ONLY` so that the check passes.
- A refactor leaves `harness/pstack/` byte-identical. If the packages change and you did not mean to change what users install, the change is the defect.
- Change `pstack/` only to bring in an upstream release. Never edit it to make a check pass. Never edit `harness/pstack/` by hand: run the generator.
- The `Gate` check runs from `main`, so a pull request cannot change the gate that judges it. When it says a change needs the owner, say so in the pull request and stop. Do not look for another way through.
- Do not change branch protection, rulesets, repository settings or anything under `.github/` unless the owner asked for that in the task.

## Before you push

```bash
npm ci
node scripts/generate-pstack-harness-trees.mjs        # then commit harness/pstack/
node --test scripts/test/*.test.mjs
node scripts/gate/check.mjs . --base origin/main      # the gate CI runs, against your last commit
```

`docs/testing.md` explains each check and what to do when an upstream sync breaks one.
