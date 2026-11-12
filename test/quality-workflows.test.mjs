// What node-quality.yml and go-quality.yml share: one `quality` job whose
// Postgres service starts only when postgres-image is set.
//
// Run with: node --test test/quality-workflows.test.mjs

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

const WORKFLOWS = {
  'node-quality.yml': 'ultimatelemon/shared-actions/.github/actions/node-checks@v2',
  'go-quality.yml': 'ultimatelemon/shared-actions/.github/actions/go-checks@v2',
};

for (const [file, checks] of Object.entries(WORKFLOWS)) {
  const workflow = readRepoFile(`.github/workflows/${file}`);
  const job = getJobBlock(workflow, 'quality');
  const steps = splitSteps(getBlock(job ?? '', 'steps'));
  const waitStep = steps.find((s) => stepName(s) === 'wait for postgres');

  describe(`${file}: one quality job`, () => {
    test('has exactly one job, quality, without an if', () => {
      const names = getBlock(workflow, 'jobs')
        .split(/\r?\n/)
        .filter((l) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l))
        .map((l) => l.trim().slice(0, -1));
      assert.deepEqual(names, ['quality']);
      assert.equal(getValue(job, 'if'), undefined);
    });

    test('runs on the runs-on and container-image inputs', () => {
      assert.equal(getValue(job, 'runs-on'), '${{ inputs.runs-on }}');
      assert.equal(getValue(job, 'container'), '${{ inputs.container-image }}');
    });

    test('defines the postgres service from the postgres inputs', () => {
      const postgres = getBlock(getBlock(job, 'services'), 'postgres');
      assert.ok(postgres, 'expected services.postgres');
      assert.equal(getValue(postgres, 'image'), '${{ inputs.postgres-image }}');
      const env = getBlock(postgres, 'env');
      assert.equal(getValue(env, 'POSTGRES_DB'), '${{ inputs.postgres-db }}');
      assert.equal(getValue(env, 'POSTGRES_USER'), '${{ inputs.postgres-user }}');
      assert.equal(getValue(env, 'POSTGRES_PASSWORD'), '${{ inputs.postgres-password }}');
      assert.match(getValue(env, 'POSTGRES_INITDB_ARGS'), /--auth-host=scram-sha-256/);
      assert.match(getValue(env, 'POSTGRES_INITDB_ARGS'), /-c fsync=off/);
    });

    // A job-level DATABASE_URL would hand repositories without a database a URL to nothing.
    test('has no job-level env', () => {
      assert.equal(getBlock(job, 'env'), null);
    });

    test('waits for postgres only when an image is set, before the checks', () => {
      assert.ok(waitStep, 'expected a "wait for postgres" step');
      assert.equal(normalizeCondition(getValue(waitStep, 'if')), "inputs.postgres-image != ''");
      const wait = steps.indexOf(waitStep);
      const run = steps.findIndex((s) => getValue(s, 'uses') === checks);
      assert.ok(wait !== -1 && wait < run);
    });

    test('passes the credentials to the step through env', () => {
      const env = getBlock(waitStep, 'env');
      assert.equal(getValue(env, 'PGUSER'), '${{ inputs.postgres-user }}');
      assert.equal(getValue(env, 'PGPASSWORD'), '${{ inputs.postgres-password }}');
      assert.equal(getValue(env, 'PGDATABASE'), '${{ inputs.postgres-db }}');
      assert.equal(getValue(env, 'NETWORK'), '${{ job.container.network }}');
      assert.doesNotMatch(getValue(waitStep, 'run'), /\$\{\{/);
    });

    function runWait({ network = '', ready = true, attempts } = {}) {
      let script = getValue(waitStep, 'run');
      if (attempts) script = script.replace('seq 60', `seq ${attempts}`).replace('sleep 2', ':');
      const stub = ready ? 'echo "$@" >> "$PWD/calls"' : 'exit 2';
      return runBash(
        [
          'mkdir bin',
          `printf '#!/bin/sh\\n%s\\n' '${stub}' > bin/pg_isready`,
          'chmod +x bin/pg_isready',
          'export PATH="$PWD/bin:$PATH" GITHUB_ENV="$PWD/env"',
          ': > "$GITHUB_ENV"',
          script,
          'echo "--env--"; cat "$GITHUB_ENV"; echo "--calls--"; cat calls 2>/dev/null || true',
        ].join('\n'),
        { PGUSER: 'u', PGPASSWORD: 'p', PGDATABASE: 'd', NETWORK: network },
      );
    }

    test('exports both URLs for localhost in Kubernetes mode', () => {
      const result = runWait();
      assert.equal(result.status, 0, result.stderr);
      const env = result.stdout.split('--env--\n')[1].split('--calls--')[0];
      assert.equal(
        env,
        'TEST_DATABASE_URL=postgresql://u:p@localhost:5432/d\nDATABASE_URL=postgresql://u:p@localhost:5432/d\n',
      );
      assert.match(result.stdout, /-h localhost -q/);
    });

    test('uses the service name on Docker', () => {
      const result = runWait({ network: 'github_network_1' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^DATABASE_URL=postgresql:\/\/u:p@postgres:5432\/d$/m);
      assert.match(result.stdout, /-h postgres -q/);
    });

    test('fails without exporting anything when Postgres never answers', () => {
      const result = runWait({ ready: false, attempts: 2 });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /::error::Postgres did not become ready/);
      assert.doesNotMatch(result.stdout, /DATABASE_URL/);
    });
  });
}
