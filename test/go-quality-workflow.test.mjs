// Structural tests for .github/workflows/go-quality.yml against card ACT-1.
//
// These tests check the YAML as data (inputs, job guards, env, service
// blocks, the `uses:` reference to the new composite action) — not the
// behaviour of any runner, which this repo cannot execute. Run with:
//   node --test test/go-quality-workflow.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  readRepoFile,
  getBlock,
  getValue,
  getJobBlock,
  splitSteps,
  stepName,
  normalizeCondition,
  runBash,
} from './helpers.mjs';

const WORKFLOW_PATH = '.github/workflows/go-quality.yml';
const workflow = readRepoFile(WORKFLOW_PATH);
// "inputs:" lives two levels deep, under on: -> workflow_call:, so it has
// to be reached by walking the structure rather than searched for
// directly in the whole file (which would only find a *direct child* of
// the file's own top level, i.e. nothing).
const onBlock = getBlock(workflow, 'on');
const workflowCallBlock = onBlock && getBlock(onBlock, 'workflow_call');
const inputsBlock = workflowCallBlock && getBlock(workflowCallBlock, 'inputs');

function serviceNames(servicesBlock) {
  return servicesBlock
    .split(/\r?\n/)
    .filter((l) => /^ {6}[A-Za-z0-9_-]+:/.test(l))
    .map((l) => l.trim().split(':')[0]);
}

describe('go-quality.yml workflow_call inputs (AC1)', () => {
  test('inputs block exists', () => {
    assert.ok(inputsBlock, 'expected a workflow_call.inputs block');
  });

  test('keeps the pre-existing inputs unchanged', () => {
    assert.equal(getValue(getBlock(inputsBlock, 'working-directory'), 'default'), '.');
    assert.equal(getValue(getBlock(inputsBlock, 'golangci-lint-version'), 'default'), 'v2.15.0');
    assert.equal(getValue(getBlock(inputsBlock, 'runs-on'), 'default'), 'build-hel-01-k8s');
    assert.equal(
      getValue(getBlock(inputsBlock, 'container-image'), 'default'),
      'ghcr.io/ultimatelemon/ci-base:latest',
    );
  });

  test('go-version defaults to empty, so the version comes from go.mod', () => {
    const block = getBlock(inputsBlock, 'go-version');
    assert.ok(block, 'missing go-version input');
    assert.equal(getValue(block, 'default'), '');
    assert.equal(getValue(block, 'type'), 'string');
  });

  test('sqlc is a boolean that defaults to off', () => {
    const block = getBlock(inputsBlock, 'sqlc');
    assert.ok(block, 'missing sqlc input');
    assert.equal(getValue(block, 'type'), 'boolean');
    assert.equal(getValue(block, 'default'), 'false');
  });

  test('sqlc-version pins a release tag', () => {
    const block = getBlock(inputsBlock, 'sqlc-version');
    assert.ok(block, 'missing sqlc-version input');
    assert.match(getValue(block, 'default') ?? '', /^v\d+\.\d+\.\d+$/);
  });

  test('adds postgres-image defaulting to an empty string', () => {
    const block = getBlock(inputsBlock, 'postgres-image');
    assert.ok(block, 'missing postgres-image input');
    assert.equal(getValue(block, 'default'), '');
    assert.equal(getValue(block, 'type'), 'string');
  });

  test('adds postgres-db defaulting to "ci"', () => {
    const block = getBlock(inputsBlock, 'postgres-db');
    assert.ok(block, 'missing postgres-db input');
    assert.equal(getValue(block, 'default'), 'ci');
  });

  test('adds postgres-user defaulting to "ci"', () => {
    const block = getBlock(inputsBlock, 'postgres-user');
    assert.ok(block, 'missing postgres-user input');
    assert.equal(getValue(block, 'default'), 'ci');
  });

  test('adds postgres-password defaulting to "ci"', () => {
    const block = getBlock(inputsBlock, 'postgres-password');
    assert.ok(block, 'missing postgres-password input');
    assert.equal(getValue(block, 'default'), 'ci');
  });

  test('adds pre-test-command defaulting to an empty string', () => {
    const block = getBlock(inputsBlock, 'pre-test-command');
    assert.ok(block, 'missing pre-test-command input');
    assert.equal(getValue(block, 'default'), '');
    assert.equal(getValue(block, 'type'), 'string');
  });
});

describe('go-quality.yml: the single "quality" job', () => {
  const job = getJobBlock(workflow, 'quality');
  const GO_CHECKS = 'ultimatelemon/shared-actions/.github/actions/go-checks@v2';

  test('declares its own contents:read permissions, not inherited', () => {
    const permissions = getBlock(job, 'permissions');
    assert.ok(permissions, 'expected an explicit permissions block on the job');
    assert.equal(getValue(permissions, 'contents'), 'read');
  });

  test('no longer sets defaults.run.working-directory at the job level', () => {
    assert.equal(getBlock(job, 'defaults'), null);
  });

  test('checks out the repository and leaves setting up Go to go-checks', () => {
    const steps = splitSteps(getBlock(job, 'steps'));
    const usesList = steps.map((s) => getValue(s, 'uses')).filter(Boolean);
    assert.ok(
      usesList.some((u) => u && u.startsWith('actions/checkout@')),
      'expected actions/checkout to remain a job step',
    );
    assert.ok(
      !usesList.some((u) => u && u.startsWith('actions/setup-go@')),
      'setup-go belongs in go-checks, which resolves the version from go.mod',
    );
  });

  test('delegates every check to go-checks@v2 by its full remote reference', () => {
    const steps = splitSteps(getBlock(job, 'steps'));
    const usesList = steps.map((s) => getValue(s, 'uses')).filter(Boolean);
    assert.equal(
      usesList.filter((u) => u === GO_CHECKS).length,
      1,
      `expected exactly one call to the full "${GO_CHECKS}" reference, got: ${JSON.stringify(usesList)}`,
    );
    assert.ok(
      !usesList.some((u) => u && u.includes('go-checks') && u.startsWith('./')),
      'go-checks must not be referenced with a relative "./" path from inside a reusable workflow',
    );
  });

  test('passes working-directory, go-version, golangci-lint-version, pre-test-command and the sqlc inputs through', () => {
    const steps = splitSteps(getBlock(job, 'steps'));
    const goChecksStep = steps.find((s) => getValue(s, 'uses') === GO_CHECKS);
    assert.ok(goChecksStep, 'go-checks step not found');
    const withBlock = getBlock(goChecksStep, 'with');
    assert.ok(withBlock, 'go-checks step has no "with:" inputs');
    assert.match(getValue(withBlock, 'go-version') ?? '', /inputs\.go-version/);
    assert.match(getValue(withBlock, 'golangci-lint-version') ?? '', /inputs\.golangci-lint-version/);
    assert.match(getValue(withBlock, 'working-directory') ?? '', /inputs\.working-directory/);
    assert.match(getValue(withBlock, 'pre-test-command') ?? '', /inputs\.pre-test-command/);
    assert.match(getValue(withBlock, 'sqlc') ?? '', /inputs\.sqlc\b/);
    assert.match(getValue(withBlock, 'sqlc-version') ?? '', /inputs\.sqlc-version/);
  });

  test('does not itself run go test/go vet/gofmt/go build/golangci-lint (moved into the action)', () => {
    const steps = splitSteps(getBlock(job, 'steps'));
    for (const step of steps) {
      const run = getValue(step, 'run') ?? '';
      assert.doesNotMatch(run, /go test|go vet|gofmt|go build|golangci-lint/,
        `job step "${stepName(step)}" should not inline a check that belongs in go-checks`);
    }
  });

  test('waits for Postgres, then the other services, then runs go-checks', () => {
    const steps = splitSteps(getBlock(job, 'steps'));
    const pg = steps.findIndex((s) => stepName(s) === 'wait for postgres');
    const services = steps.findIndex((s) => stepName(s) === 'wait for services');
    const checks = steps.findIndex((s) => getValue(s, 'uses') === GO_CHECKS);
    assert.ok(pg !== -1 && pg < services && services < checks);
  });
});

describe('go-quality.yml: optional RabbitMQ, Redis and S3 services (INF-10427)', () => {
  const quality = getJobBlock(workflow, 'quality');
  const SERVICES = { rabbitmq: 'rabbitmq-image', redis: 'redis-image', s3: 's3-image' };
  const GO_CHECKS = 'ultimatelemon/shared-actions/.github/actions/go-checks@v2';

  for (const input of Object.values(SERVICES)) {
    test(`${input} is a string input that defaults to empty`, () => {
      const block = getBlock(inputsBlock, input);
      assert.ok(block, `missing ${input} input`);
      assert.equal(getValue(block, 'type'), 'string');
      assert.equal(getValue(block, 'default'), '');
    });
  }

  test('defines each service from its image input, so an empty image starts nothing', () => {
    const services = getBlock(quality, 'services');
    for (const [name, input] of Object.entries(SERVICES)) {
      const block = getBlock(services, name);
      assert.ok(block, `expected services.${name} in quality`);
      assert.equal(getValue(block, 'image'), `\${{ inputs.${input} }}`);
    }
  });

  function waitStep(job) {
    return splitSteps(getBlock(job, 'steps')).find((s) => stepName(s) === 'wait for services');
  }

  test('quality waits for the services in one step, guarded on the three images', () => {
    const step = waitStep(quality);
    assert.ok(step, 'expected a "wait for services" step in quality');
    assert.equal(
      normalizeCondition(getValue(step, 'if')),
      "inputs.rabbitmq-image != '' || inputs.redis-image != '' || inputs.s3-image != ''",
    );
    assert.equal(getValue(step, 'shell'), 'bash');
    const env = getBlock(step, 'env');
    assert.equal(getValue(env, 'NETWORK'), '${{ job.container.network }}');
  });

  test('runs that step between checkout and go-checks', () => {
    const steps = splitSteps(getBlock(quality, 'steps'));
    const wait = steps.findIndex((s) => stepName(s) === 'wait for services');
    const checks = steps.findIndex((s) => getValue(s, 'uses') === GO_CHECKS);
    const checkout = steps.findIndex((s) => (getValue(s, 'uses') ?? '').startsWith('actions/checkout@'));
    assert.ok(checkout < wait && wait < checks, 'expected checkout, wait for services, go-checks');
  });

  function runWait(env) {
    const script = getValue(waitStep(quality), 'run');
    const result = runBash(`: > "$PWD/env"; export GITHUB_ENV="$PWD/env"\n${script}\necho "--env--"; cat "$GITHUB_ENV"`, env);
    return { ...result, env: result.stdout.split('--env--\n')[1] ?? '' };
  }

  test('the script exports nothing when no service is asked for', () => {
    const result = runWait({ RABBITMQ: 'false', REDIS: 'false', S3: 'false', NETWORK: '' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.env, '');
  });

  test('the script fails with an error naming a service that never answers', () => {
    const script = getValue(waitStep(quality), 'run').replace('seq 60', 'seq 1').replace('sleep 2', ':');
    const result = runBash(`export GITHUB_ENV="$PWD/env"\n${script}`, {
      RABBITMQ: 'false', REDIS: 'true', S3: 'false', NETWORK: 'docker-network',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /::error::Redis did not become ready/);
  });

  test('the exported names are the ones the README documents', () => {
    const script = getValue(waitStep(quality), 'run');
    const exported = [...script.matchAll(/echo "(TEST_[A-Z0-9_]+)=/g)].map((m) => m[1]).sort();
    assert.deepEqual(exported, [
      'TEST_RABBITMQ_URL',
      'TEST_REDIS_URL',
      'TEST_S3_ACCESS_KEY_ID',
      'TEST_S3_BUCKET',
      'TEST_S3_ENDPOINT',
      'TEST_S3_REGION',
      'TEST_S3_SECRET_ACCESS_KEY',
    ]);
    const readme = readRepoFile('README.md');
    for (const name of exported) {
      assert.match(readme, new RegExp('`' + name + '`'), `README.md should document ${name}`);
    }
  });
});
