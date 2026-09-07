# shared-actions

Shared CI building blocks for UltimateLemon repositories.

## `node-quality.yml`

A reusable workflow that owns the entire quality job for a Node project:
checkout, Node setup, dependency install and every check, in one runner job.

```yaml
name: Code Quality

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: code-quality-${{ github.ref }}
  cancel-in-progress: true

jobs:
  quality:
    uses: ultimatelemon/shared-actions/.github/workflows/node-quality.yml@v1
```

### Which checks run

Not decided by inputs. Every step is `run --if-present`, so a repository opts
in by having the script in its `package.json`. In order:

| Script         | Suggested command      |
| -------------- | ---------------------- |
| `lint`         | `eslint src/`          |
| `format:check` | `prettier --check ...` |
| `typecheck`    | `tsc --noEmit`         |
| `test`         | `jest` / `vitest run`  |
| `build`        | `next build`           |

A missing script is skipped silently. Adding a check to a repository means
adding a script, not editing this workflow.

**Next.js projects**: `tsc --noEmit` alone fails on a fresh checkout. Image and
stylesheet imports get their types from `next-env.d.ts`, which Next generates
and which belongs in `.gitignore`, so it is absent until something generates
it. Use `next typegen && tsc --noEmit` — `typegen` writes that file and the
route types without running a full build.

All checks run even when an earlier one fails (`if: !cancelled()`), so one
run reports every problem. The job still fails.

### Inputs

| Input               | Default         | Purpose                              |
| ------------------- | --------------- | ------------------------------------ |
| `node-version`      | `22`            | Node.js version.                     |
| `package-manager`   | `npm`           | `npm` or `pnpm`.                     |
| `working-directory` | `.`             | Where `package.json` lives.          |
| `runs-on`           | `ubuntu-latest` | Runner label.                        |

Keep this list short. A repository that needs something genuinely different
is better off with its own workflow than with another input here.

### Versioning

Call it on the `v1` tag, never on `@main` — a push to this repository would
otherwise change CI in every repository at once. Move the `v1` tag forward
only after the change has run green in one repository.

## `node/quality-check`

Superseded by `node-quality.yml` and unused. It wrapped three `npm run` lines
without owning checkout and install, which is where the actual time goes.
