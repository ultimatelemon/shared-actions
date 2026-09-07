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

## `docker-publish.yml`

Builds one image and pushes it to GHCR: buildx, login, tag and label rules and
a scoped build cache.

```yaml
jobs:
  publish:
    uses: ultimatelemon/shared-actions/.github/workflows/docker-publish.yml@v1
    permissions:
      contents: read
      packages: write
    with:
      image: ghcr.io/ultimatelemon/yptuinen
      build-args: |
        NEXT_PUBLIC_COC=${{ vars.NEXT_PUBLIC_COC }}
    secrets:
      build-secrets: |
        FONTAWESOME_NPM_AUTH_TOKEN=${{ secrets.FONTAWESOME_NPM_AUTH_TOKEN }}
```

### Inputs

| Input        | Default         | Purpose                                    |
| ------------ | --------------- | ------------------------------------------ |
| `image`      | *(required)*    | Image name without a tag.                  |
| `context`    | `.`             | Build context.                             |
| `dockerfile` | `Dockerfile`    | Path relative to the context.              |
| `target`     | *(empty)*       | Stage to build; empty builds the last one. |
| `platforms`  | `linux/amd64`   | Target platforms.                          |
| `build-args` | *(empty)*       | Newline-separated `KEY=value`.             |
| `runs-on`    | `ubuntu-latest` | Runner label.                              |

### `build-args` versus `build-secrets`

A build arg ends up in the image and in the build log. A credential belongs in
`build-secrets`, which BuildKit exposes only to the step that mounts it:

```dockerfile
RUN --mount=type=secret,id=MY_TOKEN,env=MY_TOKEN,required=true npm ci
```

### Tags published

`latest` on the default branch, the branch name, the short SHA, and on a `v*`
git tag both `1.2.3` and `1.2`.

### Multi-stage images

A Dockerfile whose stages run as separate services calls this workflow once
per stage, each as its own job with its own `target` and `image`. The cache is
scoped per image and target so the builds do not evict each other.

### Deploying

Not part of this workflow. Publishing a tag does not make a running container
re-pull it, and how a service is rolled out differs per repository, so the
caller keeps its own deploy job.

## Versioning

Call these workflows on the `v1` tag, never on `@main` — a push to this
repository would otherwise change CI in every repository at once. Move the
`v1` tag forward only after the change has run green in one repository.
