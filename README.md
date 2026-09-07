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

### Private registries

A project that installs from a private npm registry passes the `.npmrc` as a
secret instead of committing it. The registry lines are not secret, so only
the token comes from a repository secret:

```yaml
    secrets:
      npmrc: |
        @awesome.me:registry=https://npm.fontawesome.com/
        @fortawesome:registry=https://npm.fontawesome.com/
        //npm.fontawesome.com/:_authToken=${{ secrets.FONTAWESOME_NPM_AUTH_TOKEN }}
```

It is written to the runner's home directory, never the working directory, so
it cannot reach a build context or a diff.

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

Not part of this workflow: publishing a tag does not make a running container
re-pull it. Pair it with `dokploy-deploy.yml`.

## `dokploy-deploy.yml`

Tells Dokploy to pull and roll out what `docker-publish.yml` just pushed, and
records the result under a GitHub environment.

```yaml
  deploy:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    needs: publish
    uses: ultimatelemon/shared-actions/.github/workflows/dokploy-deploy.yml@v1
    with:
      url: https://yptuinen.nl
    secrets:
      webhook-url: ${{ secrets.DOKPLOY_DEPLOY_URL }}
```

### Inputs

| Input         | Default         | Purpose                             |
| ------------- | --------------- | ----------------------------------- |
| `url`         | *(empty)*       | Public URL, shown in Deployments.   |
| `environment` | `production`    | GitHub environment to record under. |
| `runs-on`     | `ubuntu-latest` | Runner label.                       |

`webhook-url` is required and comes from the application's Deployments tab in
Dokploy.

### Deployment titles

Dokploy names a deployment after `head_commit.message` from the webhook body
and falls back to "NEW COMMIT" when it is absent, so the payload carries the
first line of the commit message and the SHA. The commit message reaches the
script through `env`, never through `${{ }}` interpolation, so a crafted
message cannot run as shell.

### Why the status check

Dokploy answers a webhook it will not act on with a 3xx, and `curl -f` only
fails on 4xx and 5xx. A plain `curl -f` therefore reports a successful deploy
that never happened, so this checks for 2xx explicitly and prints the reply.

### Gating

The workflow itself does not decide when to deploy. Guard the calling job with
an `if`, so tag builds and manual runs can publish without rolling anything
out.

## Versioning

Call these workflows on the `v1` tag, never on `@main` — a push to this
repository would otherwise change CI in every repository at once. Move the
`v1` tag forward only after the change has run green in one repository.
