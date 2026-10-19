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

permissions: {}

concurrency:
  group: code-quality-${{ github.ref }}
  cancel-in-progress: true

jobs:
  quality:
    uses: ultimatelemon/shared-actions/.github/workflows/node-quality.yml@v2
    permissions:
      contents: read
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
| `verify`       | *(anything repo-own)*  |

A missing script is skipped silently. Adding a check to a repository means
adding a script, not editing this workflow.

`verify` runs last and exists for checks that are real but specific to one
repository: a migration drift check, an extra bundle step, a generated file
that must match its source. Put them behind a `verify` script instead of
keeping a hand-written workflow next to this one.

`typecheck` runs before `lint` on purpose. In a Next.js project it is the step
that generates `next-env.d.ts` and the route types, and type-aware ESLint
rules report everything as `error typed` without them.

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
| `node-version`      | `24`            | Node.js version.                     |
| `package-manager`   | `npm`           | `npm` or `pnpm`.                     |
| `working-directory` | `.`             | Where `package.json` lives.          |
| `runs-on`           | `build-hel-01-k8s` | Runner label.                     |
| `container-image`   | `ci-base:latest` | Job container (see below).         |
| `postgres-image`    | *(empty)*       | Postgres image; empty runs no database. |
| `postgres-db`       | `ci`            | Database in the service container.   |
| `postgres-user`     | `ci`            | User in the service container.       |
| `postgres-password` | `ci`            | Password for that user.              |

Keep this list short. A repository that needs something genuinely different
is better off with its own workflow than with another input here.

### Tests against a real Postgres

A repository whose tests need a database passes an image. Nothing else
changes about the workflow itself; leaving `postgres-image` empty runs the
job exactly as before — but see
[Branch protection and the toggle](#branch-protection-and-the-toggle) below
for what adding or removing it means for a required status check.

```yaml
  quality:
    uses: ultimatelemon/shared-actions/.github/workflows/node-quality.yml@v2
    with:
      working-directory: apps/web
      postgres-image: postgres:18.6-trixie
```

Pin the image to an exact version and distro. Another glibc means other
collations, and a test that asserts on sort order then fails for a reason
that has nothing to do with the change.

Every step gets both `TEST_DATABASE_URL` and `DATABASE_URL`, pointing at the
same container. `DATABASE_URL` is there because `drizzle-kit` and `prisma`
read it by convention, so a drift check in `verify` needs no extra wiring. It
is safe: the container is created for this job and thrown away with the
runner, and a runner has no route to a production database. The one thing to
know is that a `build` which prerenders against a database now finds one
instead of failing fast.

The defaults `ci` / `ci` / `ci` are the credentials of that throwaway
container, not a secret. Override them only when the tests hardcode a
database name.

### Two jobs, one set of steps

A `services:` block cannot be conditional, so the workflow has two jobs,
`quality` and `quality-postgres`, and an `if` on `postgres-image` picks one.
Both run the same steps from
`.github/actions/node-checks`, a composite action in this repository, so the
step list exists once.

That action is referenced by its full name and tag. Inside a reusable
workflow a relative `uses: ./...` resolves against the *calling* repository,
which would look for the action in every repository that calls this workflow.

### Branch protection and the toggle

`quality` and `quality-postgres` are mutually exclusive: exactly one of them
runs on any given workflow call, selected by the `if:` on `postgres-image`,
and GitHub Actions reports the other one as "skipped". A skipped job is not
the same as "no check ran" for the purposes of branch protection: GitHub
treats a skipped *required* status check as passing, not as pending or
failing.

That matters because the required-check name a caller repo configures is one
of these two job names, not a name for "the workflow" — GitHub shows it as
`<caller job id> / quality` or `<caller job id> / quality-postgres`. A
repository that sets up branch protection requiring the `quality` check
while it has no `postgres-image` is protected today. The moment someone
later adds `postgres-image` to that same `uses:` call to pick up database
tests, that repository silently loses that protection: `quality` becomes
permanently skipped-therefore-green on every subsequent pull request, while
the actual checks now run under `quality-postgres` — which enforces nothing
unless it is *also* added as a required check. Lint, format, type, test and
build failures can then merge without anyone noticing the required check
stopped checking anything. (The same applies to `go-quality.yml`, where the
checks are gofmt, `go vet`, `go test`, `go build` and golangci-lint.)

Require **both** `quality` and `quality-postgres` as required status checks
in branch protection, not just the one currently in use. With both required,
toggling `postgres-image` only ever changes which job does the work; it
never silently changes what is enforced, because the one that does not run
is skipped-therefore-green while the other actually gates the merge.

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

## `go-quality.yml`

The same idea for a Go module: one job that checks out, sets up Go and runs
gofmt, `go vet`, `go test -race ./...`, `go build ./...` and golangci-lint,
each with `if: !cancelled()` so one run reports every problem.

```yaml
jobs:
  bot:
    uses: ultimatelemon/shared-actions/.github/workflows/go-quality.yml@v2
    with:
      working-directory: apps/bot
```

### Inputs

| Input                   | Default            | Purpose                                 |
| ----------------------- | ------------------ | --------------------------------------- |
| `working-directory`     | `.`                | Where `go.mod` lives.                   |
| `go-version`            | `1.25`             | Go version.                             |
| `golangci-lint-version` | `v2.12.2`          | Release tag, `v` included.              |
| `runs-on`               | `build-hel-01-k8s` | Runner label.                           |
| `container-image`       | `ci-base:latest`   | Job container (see below).              |
| `postgres-image`        | *(empty)*          | Postgres image; empty runs no database. |
| `postgres-db`           | `ci`               | Database in the service container.      |
| `postgres-user`         | `ci`               | User in the service container.          |
| `postgres-password`     | `ci`               | Password for that user.                 |
| `pre-test-command`      | *(empty)*          | Command to run before the tests.        |

The lint step installs golangci-lint from its own install script, so the
version input is also the version in the URL. A repository with a
`.golangci.yml` keeps using it; the config is v2 in every repository here.

### Tests against a real Postgres

A module whose tests need a database passes an image. Nothing else changes
about the workflow itself; leaving `postgres-image` empty runs the job
without a database — but see
[Branch protection and the toggle](#branch-protection-and-the-toggle),
described under `node-quality.yml` above, for what adding or removing it
means for a required status check.

```yaml
  bot:
    uses: ultimatelemon/shared-actions/.github/workflows/go-quality.yml@v2
    with:
      working-directory: apps/bot
      postgres-image: postgres:18.6-trixie
      pre-test-command: go run ./cmd/migrate
```

Pin the image to an exact version and distro. Another glibc means other
collations, and a test that asserts on sort order then fails for a reason
that has nothing to do with the change.

Every step gets both `TEST_DATABASE_URL` and `DATABASE_URL`, pointing at the
same container, so a migration tool that reads either one by convention needs
no extra wiring. The defaults `ci` / `ci` / `ci` are the credentials of that
throwaway container, not a secret.

`pre-test-command` runs after `go vet` and before the tests, in the working
directory, and is the place for applying migrations or seeding. The value is
a command and is deliberately executed, but it reaches the shell through
`env` rather than `${{ }}` interpolation in the script body, so it cannot
also rewrite the step around it. Leaving it empty runs nothing, with or
without a database.

The two jobs behind this work exactly as described under
[Two jobs, one set of steps](#two-jobs-one-set-of-steps) for
`node-quality.yml`, sharing `.github/actions/go-checks`.

### Why frameline keeps its own job

`frameline` needs Postgres *and* Redis, applies SQL migrations as a superuser
before the tests and builds two modules in one job, so it keeps its own Go
job. A single service input would only cover half of that case.

## `docker-publish.yml`

Builds one image and pushes it to GHCR: buildx, login, tag and label rules and
a scoped build cache.

```yaml
jobs:
  publish:
    uses: ultimatelemon/shared-actions/.github/workflows/docker-publish.yml@v2
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
| `buildkit-endpoint` | `tcp://buildkitd.buildkit:1234` | BuildKit daemon to build on. |
| `runs-on`    | `build-hel-01-k8s` | Runner label.                           |
| `container-image` | `ci-base:latest` | Job container (see below).            |

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
    uses: ultimatelemon/shared-actions/.github/workflows/dokploy-deploy.yml@v2
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
| `runs-on`     | `build-hel-01-k8s` | Runner label.                    |
| `container-image` | `ci-base:latest` | Job container (see below).     |

`webhook-url` is required and comes from the application's Deployments tab in
Dokploy.

`cf-access-client-id` and `cf-access-client-secret` are optional. When both
are non-empty, the deploy step sends them as the `CF-Access-Client-Id` and
`CF-Access-Client-Secret` headers on the webhook call, which is how
Cloudflare Access service-token authentication is normally presented to a
protected origin. Adding them is additive and backward compatible: leaving
either one unset or empty keeps the webhook call exactly as it is today.
Note that setting them currently has no effect, because no Cloudflare
Access application has been configured yet for the Dokploy webhook path —
until one exists, these headers are simply ignored, so do not assume they
protect anything yet.

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

## Runners and the job container

`v2` runs on `build-hel-01-k8s`: GitHub Actions runners on the k3s cluster on
build-hel-01 (ARC in kubernetes mode, see the infrastructure repository). Only
private repositories in the organisation can use them. That mode has three
consequences for everything here:

- Every job runs in a container, `ghcr.io/ultimatelemon/ci-base:latest` by
  default (git, build tools, `psql`, the docker CLI with buildx). A repository
  that needs more passes its own image as `container-image`.
- There is no Docker daemon. `docker-publish.yml` builds on the cluster's
  shared rootless BuildKit through buildx's remote driver, so `linux/amd64`
  is the only platform. A step that runs `docker run` or `docker compose`
  does not work; use `services:` instead.
- Services run in the job's pod and are reached on `localhost`. Their Docker
  `options`, health checks included, are ignored, which is why
  `node-quality.yml` and `go-quality.yml` wait for Postgres with `pg_isready` itself.

Setting `runs-on: ubuntu-latest` still works, inside the same container, except
for Postgres: on Docker a service is reached by its name, not on `localhost`.

## Versioning

Call these workflows on a version tag, never on `@main` — a push to this
repository would otherwise change CI in every repository at once. Move a tag
forward only after the change has run green in one repository.

- `v2`: the build-hel-01-k8s runners and the ci-base container.
- `v1`: GitHub-hosted runners, unchanged. Public repositories stay on `v1`:
  the build-hel-01-k8s runners only serve private ones, and a public
  repository's pull requests must never run on our own hardware.
