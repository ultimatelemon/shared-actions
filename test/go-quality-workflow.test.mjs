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

describe('go-quality.yml workflow_call inputs (AC1)', () => {
  test('inputs block exists', () => {
    assert.ok(inputsBlock, 'expected a workflow_call.inputs block');
  });

  test('keeps the pre-existing inputs unchanged', () => {
    assert.equal(getValue(getBlock(inputsBlock, 'working-directory'), 'default'), '.');
    assert.equal(getValue(getBlock(inputsBlock, 'go-version'), 'default'), '1.25');
    assert.equal(getValue(getBlock(inputsBlock, 'golangci-lint-version'), 'default'), 'v2.12.2');
    assert.equal(getValue(getBlock(inputsBlock, 'runs-on'), 'default'), 'build-hel-01-k8s');
    assert.equal(
      getValue(getBlock(inputsBlock, 'container-image'), 'default'),
      'ghcr.io/ultimatelemon/ci-base:latest',
    );
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

describe('go-quality.yml: "quality" job (no Postgres) (AC2, AC6, AC8)', () => {
  const job = getJobBlock(workflow, 'quality');

  test('job block exists', () => {
    assert.ok(job, 'expected a top-level "quality" job');
  });

  test('only runs when postgres-image is empty', () => {
    assert.ok(job, 'job missing');
    const condition = normalizeCondition(getValue(job, 'if'));
    assert.equal(condition, "inputs.postgres-image == ''");
  });

  test('declares its own contents:read permissions, not inherited', () => {
    assert.ok(job, 'job missing');
    const permissions = getBlock(job, 'permissions');
    assert.ok(permissions, 'expected an explicit permissions block on the job');
    assert.equal(getValue(permissions, 'contents'), 'read');
  });

  test('has no services block (that is what quality-postgres is for)', () => {
    assert.ok(job, 'job missing');
    assert.equal(getBlock(job, 'services'), null);
  });

  test('has no DATABASE_URL/TEST_DATABASE_URL in its env', () => {
    assert.ok(job, 'job missing');
    assert.doesNotMatch(job, /DATABASE_URL/);
  });

  test('no longer sets defaults.run.working-directory at the job level', () => {
    assert.ok(job, 'job missing');
    assert.equal(getBlock(job, 'defaults'), null);
  });

  test('still checks out the repository and sets up Go as job steps', () => {
    assert.ok(job, 'job missing');
    const steps = splitSteps(getBlock(job, 'steps'));
    const usesList = steps.map((s) => getValue(s, 'uses')).filter(Boolean);
    assert.ok(
      usesList.some((u) => u && u.startsWith('actions/checkout@')),
      'expected actions/checkout to remain a job step',
    );
    assert.ok(
      usesList.some((u) => u && u.startsWith('actions/setup-go@')),
      'expected actions/setup-go to remain a job step',
    );
  });

  test('delegates every check to go-checks@v2 by its full remote reference', () => {
    assert.ok(job, 'job missing');
    const steps = splitSteps(getBlock(job, 'steps'));
    const usesList = steps.map((s) => getValue(s, 'uses')).filter(Boolean);
    const goChecksUses = usesList.filter(
      (u) => u === 'ultimatelemon/shared-actions/.github/actions/go-checks@v2',
    );
    assert.equal(
      goChecksUses.length,
      1,
      `expected exactly one call to the full "ultimatelemon/shared-actions/.github/actions/go-checks@v2" reference, got: ${JSON.stringify(usesList)}`,
    );
    assert.ok(
      !usesList.some((u) => u && u.includes('go-checks') && u.startsWith('./')),
      'go-checks must not be referenced with a relative "./" path from inside a reusable workflow',
    );
  });

  test('passes working-directory, go-version, golangci-lint-version and pre-test-command through', () => {
    assert.ok(job, 'job missing');
    const steps = splitSteps(getBlock(job, 'steps'));
    const goChecksStep = steps.find((s) => getValue(s, 'uses') === 'ultimatelemon/shared-actions/.github/actions/go-checks@v2');
    assert.ok(goChecksStep, 'go-checks step not found');
    const withBlock = getBlock(goChecksStep, 'with');
    assert.ok(withBlock, 'go-checks step has no "with:" inputs');
    assert.match(getValue(withBlock, 'go-version') ?? '', /inputs\.go-version/);
    assert.match(getValue(withBlock, 'golangci-lint-version') ?? '', /inputs\.golangci-lint-version/);
    assert.match(getValue(withBlock, 'working-directory') ?? '', /inputs\.working-directory/);
    assert.match(getValue(withBlock, 'pre-test-command') ?? '', /inputs\.pre-test-command/);
  });

  test('does not itself run go test/go vet/gofmt/go build/golangci-lint (moved into the action)', () => {
    assert.ok(job, 'job missing');
    const steps = splitSteps(getBlock(job, 'steps'));
    for (const step of steps) {
      const run = getValue(step, 'run') ?? '';
      assert.doesNotMatch(run, /go test|go vet|gofmt|go build|golangci-lint/,
        `job step "${stepName(step)}" should not inline a check that belongs in go-checks`);
    }
  });
});

describe('go-quality.yml: "quality-postgres" job (AC3, AC4, AC6)', () => {
  const job = getJobBlock(workflow, 'quality-postgres');

  test('job block exists', () => {
    assert.ok(job, 'expected a top-level "quality-postgres" job');
  });

  test('only runs when postgres-image is non-empty', () => {
    assert.ok(job, 'job missing');
    const condition = normalizeCondition(getValue(job, 'if'));
    assert.equal(condition, "inputs.postgres-image != ''");
  });

  test('declares its own contents:read permissions, not inherited from "quality"', () => {
    assert.ok(job, 'job missing');
    const permissions = getBlock(job, 'permissions');
    assert.ok(permissions, 'expected an explicit permissions block on quality-postgres');
    assert.equal(getValue(permissions, 'contents'), 'read');
  });

  test('declares exactly one postgres service container', () => {
    assert.ok(job, 'job missing');
    const services = getBlock(job, 'services');
    assert.ok(services, 'expected a services: block');
    const postgres = getBlock(services, 'postgres');
    assert.ok(postgres, 'expected a services.postgres block');
    assert.match(getValue(postgres, 'image') ?? '', /inputs\.postgres-image/);

    const env = getBlock(postgres, 'env');
    assert.ok(env, 'expected services.postgres.env');
    assert.match(getValue(env, 'POSTGRES_DB') ?? '', /inputs\.postgres-db/);
    assert.match(getValue(env, 'POSTGRES_USER') ?? '', /inputs\.postgres-user/);
    assert.match(getValue(env, 'POSTGRES_PASSWORD') ?? '', /inputs\.postgres-password/);

    // Only one postgres service block should exist in the job.
    const occurrences = (job.match(/^\s*postgres:\s*$/gm) || []).length;
    assert.equal(occurrences, 1, 'expected exactly one "postgres:" service, found duplicates');
  });

  // Kubernetes mode ignores service options, health checks included.
  test('waits for the service with pg_isready in a step before go-checks', () => {
    assert.ok(job, 'job missing');
    const steps = splitSteps(getBlock(job, 'steps'));
    const waitIndex = steps.findIndex((s) => /pg_isready\s+-h\s+localhost/.test(s));
    const checksIndex = steps.findIndex(
      (s) => getValue(s, 'uses') === 'ultimatelemon/shared-actions/.github/actions/go-checks@v2'
    );
    assert.ok(waitIndex !== -1, 'expected a step that runs pg_isready -h localhost');
    assert.ok(waitIndex < checksIndex, 'expected the wait step before go-checks');
  });

  test('sets both DATABASE_URL and TEST_DATABASE_URL at the job level from the postgres inputs', () => {
    assert.ok(job, 'job missing');
    const env = getBlock(job, 'env');
    assert.ok(env, 'expected a job-level env: block');
    const expected = /^postgresql:\/\/\$\{\{\s*inputs\.postgres-user\s*\}\}:\$\{\{\s*inputs\.postgres-password\s*\}\}@localhost:5432\/\$\{\{\s*inputs\.postgres-db\s*\}\}$/;

    const databaseUrl = getValue(env, 'DATABASE_URL');
    assert.ok(databaseUrl, 'DATABASE_URL missing from job env');
    assert.match(databaseUrl, expected);

    const testDatabaseUrl = getValue(env, 'TEST_DATABASE_URL');
    assert.ok(testDatabaseUrl, 'TEST_DATABASE_URL missing from job env');
    assert.match(testDatabaseUrl, expected);

    assert.equal(databaseUrl, testDatabaseUrl, 'DATABASE_URL and TEST_DATABASE_URL should point at the same container');

    // No duplicate keys.
    assert.equal((env.match(/^\s*DATABASE_URL:/gm) || []).length, 1);
    assert.equal((env.match(/^\s*TEST_DATABASE_URL:/gm) || []).length, 1);
  });

  test('also delegates to go-checks@v2 exactly once, by its full remote reference', () => {
    assert.ok(job, 'job missing');
    const steps = splitSteps(getBlock(job, 'steps'));
    const usesList = steps.map((s) => getValue(s, 'uses')).filter(Boolean);
    const goChecksUses = usesList.filter(
      (u) => u === 'ultimatelemon/shared-actions/.github/actions/go-checks@v2',
    );
    assert.equal(goChecksUses.length, 1);
  });

  test('still checks out the repository and sets up Go as job steps', () => {
    assert.ok(job, 'job missing');
    const steps = splitSteps(getBlock(job, 'steps'));
    const usesList = steps.map((s) => getValue(s, 'uses')).filter(Boolean);
    assert.ok(usesList.some((u) => u && u.startsWith('actions/checkout@')));
    assert.ok(usesList.some((u) => u && u.startsWith('actions/setup-go@')));
  });
});

describe('go-quality.yml: edge cases', () => {
  test('the two job guards are mutually exclusive and exhaustive for any postgres-image value', () => {
    // Not an execution test (no workflow runner available here) but a
    // sanity check on the literal conditions themselves: they must be
    // exact complements of each other, not e.g. both using "==" or both
    // using "!=" by a copy-paste mistake.
    const quality = normalizeCondition(getValue(getJobBlock(workflow, 'quality') ?? '', 'if'));
    const qualityPostgres = normalizeCondition(getValue(getJobBlock(workflow, 'quality-postgres') ?? '', 'if'));
    assert.equal(quality, "inputs.postgres-image == ''");
    assert.equal(qualityPostgres, "inputs.postgres-image != ''");
  });

  test('go-checks is invoked with the same go-version/golangci-lint-version/working-directory in both jobs', () => {
    const jobs = ['quality', 'quality-postgres'].map((name) => getJobBlock(workflow, name));
    const withBlocks = jobs.map((job) => {
      const steps = splitSteps(getBlock(job ?? '', 'steps'));
      const step = steps.find((s) => getValue(s, 'uses') === 'ultimatelemon/shared-actions/.github/actions/go-checks@v2');
      assert.ok(step, 'go-checks step missing in one of the jobs');
      return getBlock(step, 'with');
    });
    for (const key of ['go-version', 'golangci-lint-version', 'working-directory', 'pre-test-command']) {
      assert.equal(getValue(withBlocks[0], key), getValue(withBlocks[1], key), `"${key}" should be wired identically in both jobs`);
    }
  });
});
