// Structural AND behavioural tests for the new composite action
// .github/actions/go-checks/action.yml against card ACT-1.
//
// Where a step is "just" a shell snippet referencing env vars (the
// pre-test-command step), we actually execute the extracted bash with
// `bash -c` in a scratch directory. That is cheap, needs no extra
// dependency, and catches the one thing pure structural parsing cannot:
// whether an empty `pre-test-command` really is a no-op, and whether a
// non-empty one really runs.
//
// Run with: node --test test/go-checks-action.test.mjs

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fileExists,
  readRepoFile,
  getBlock,
  getValue,
  splitSteps,
  stepName,
  runBash,
} from './helpers.mjs';

const ACTION_PATH = '.github/actions/go-checks/action.yml';

describe('go-checks/action.yml exists and is a composite action (AC6)', () => {
  test('file exists at the documented path', () => {
    assert.ok(
      fileExists(ACTION_PATH),
      `expected a new composite action at ${ACTION_PATH} (card ACT-1, point 3) — it does not exist yet`,
    );
  });

  test('declares itself as a composite action', () => {
    const action = readRepoFile(ACTION_PATH);
    const runs = getBlock(action, 'runs');
    assert.ok(runs, 'missing "runs:" block');
    assert.equal(getValue(runs, 'using'), 'composite');
  });
});

// Everything below needs the file to exist; guard with a single before()
// so a missing file produces one clear failure instead of a stack trace
// per test.
let action;
let inputsBlock;
let steps;

before(() => {
  if (!fileExists(ACTION_PATH)) return;
  action = readRepoFile(ACTION_PATH);
  inputsBlock = getBlock(action, 'inputs');
  const runsBlock = getBlock(action, 'runs');
  steps = splitSteps(getBlock(runsBlock ?? '', 'steps'));
});

function requireAction() {
  assert.ok(action, `${ACTION_PATH} is missing; cannot run this check`);
}

describe('go-checks/action.yml inputs', () => {
  test('declares go-version, golangci-lint-version, working-directory, pre-test-command, sqlc and sqlc-version', () => {
    requireAction();
    assert.ok(inputsBlock, 'missing inputs: block');
    for (const name of ['go-version', 'golangci-lint-version', 'working-directory', 'pre-test-command', 'sqlc', 'sqlc-version']) {
      assert.ok(getBlock(inputsBlock, name), `missing input "${name}"`);
    }
  });

  test('pre-test-command defaults to an empty string', () => {
    requireAction();
    const block = getBlock(inputsBlock, 'pre-test-command');
    assert.ok(block);
    assert.equal(getValue(block, 'default'), '');
  });

  test('go-version defaults to empty and sqlc to off', () => {
    requireAction();
    assert.equal(getValue(getBlock(inputsBlock, 'go-version'), 'default'), '');
    assert.equal(getValue(getBlock(inputsBlock, 'sqlc'), 'default'), 'false');
  });
});

describe('go-checks/action.yml: Go setup (INF-10420 AC1, AC3)', () => {
  const resolveStep = () => steps.find((s) => getValue(s, 'id') === 'go-version');
  const setupGoStep = () => steps.find((s) => (getValue(s, 'uses') ?? '').startsWith('actions/setup-go@'));

  function resolve(goMod, goVersion = '') {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'go-version-')), 'out');
    fs.writeFileSync(out, '');
    const write = goMod === null ? '' : `cat > go.mod <<'GOMOD'\n${goMod}\nGOMOD\n`;
    const result = runBash(write + getValue(resolveStep(), 'run'), { GO_VERSION: goVersion, GITHUB_OUTPUT: out });
    return { status: result.status, output: fs.readFileSync(out, 'utf8').trim() };
  }

  test('resolves the version before setup-go, which runs before every check', () => {
    requireAction();
    const resolveIdx = steps.indexOf(resolveStep());
    const setupIdx = steps.indexOf(setupGoStep());
    const formatIdx = steps.findIndex((s) => /gofmt/.test(getValue(s, 'run') ?? ''));
    assert.notEqual(resolveIdx, -1, 'no step with id go-version');
    assert.notEqual(setupIdx, -1, 'no actions/setup-go step');
    assert.ok(resolveIdx < setupIdx && setupIdx < formatIdx);
  });

  test('setup-go takes the resolved version and caches on go.sum', () => {
    requireAction();
    const withBlock = getBlock(setupGoStep(), 'with');
    assert.match(getValue(withBlock, 'go-version') ?? '', /steps\.go-version\.outputs\.version/);
    assert.match(getValue(withBlock, 'cache-dependency-path') ?? '', /inputs\.working-directory\s*\}\}\/go\.sum$/);
    assert.notEqual(getValue(withBlock, 'cache'), 'false');
  });

  test('takes the minor of the go directive', () => {
    requireAction();
    assert.deepEqual(resolve('module x\n\ngo 1.25.4'), { status: 0, output: 'version=1.25' });
    assert.deepEqual(resolve('module x\n\ngo 1.27'), { status: 0, output: 'version=1.27' });
  });

  test('prefers the toolchain directive', () => {
    requireAction();
    assert.deepEqual(resolve('module x\n\ngo 1.26.0\n\ntoolchain go1.27.2'), { status: 0, output: 'version=1.27' });
  });

  test('an explicit go-version wins over go.mod', () => {
    requireAction();
    assert.deepEqual(resolve('module x\n\ngo 1.25.4', '1.26'), { status: 0, output: 'version=1.26' });
    assert.deepEqual(resolve(null, '1.26.3'), { status: 0, output: 'version=1.26.3' });
  });

  test('fails when go.mod has no version', () => {
    requireAction();
    assert.notEqual(resolve('module x').status, 0);
  });
});

describe('go-checks/action.yml: sqlc (INF-10420 AC2)', () => {
  const sqlcSteps = () => steps.filter((s) => /inputs\.sqlc == ''true''/.test(getValue(s, 'if') ?? ''));

  test('installs and runs sqlc only when the input is true, and even after an earlier failure', () => {
    requireAction();
    assert.equal(sqlcSteps().length, 2, 'expected an install and a check step gated on inputs.sqlc');
    for (const step of sqlcSteps()) {
      assert.match(getValue(step, 'if'), /^!cancelled\(\) && /);
    }
  });

  test('installs the pinned sqlc-version and checks with sqlc diff', () => {
    requireAction();
    const [install, check] = sqlcSteps();
    assert.match(getBlock(install, 'env') ?? '', /inputs\.sqlc-version/);
    assert.match(getValue(install, 'run') ?? '', /sqlc-dev\/sqlc\/releases\/download\/\$VERSION\//);
    assert.match(getValue(check, 'run') ?? '', /sqlc diff/);
  });

  test('runs after vet and before the tests', () => {
    requireAction();
    const vetIdx = steps.findIndex((s) => /go vet/.test(getValue(s, 'run') ?? ''));
    const testIdx = steps.findIndex((s) => /go test/.test(getValue(s, 'run') ?? ''));
    for (const step of sqlcSteps()) {
      const idx = steps.indexOf(step);
      assert.ok(vetIdx < idx && idx < testIdx);
    }
  });
});

describe('go-checks/action.yml step order and content (AC6, AC7, AC8)', () => {
  test('has the expected checks, in order: format, vet, pre-test, test, build, lint', () => {
    requireAction();
    assert.ok(steps.length > 0, 'no steps found');

    const indexOfRunContaining = (pattern) =>
      steps.findIndex((s) => pattern.test(getValue(s, 'run') ?? ''));

    const formatIdx = indexOfRunContaining(/gofmt/);
    const vetIdx = indexOfRunContaining(/go vet/);
    const testIdx = indexOfRunContaining(/go test/);
    const buildIdx = indexOfRunContaining(/go build/);
    const lintRunIdx = indexOfRunContaining(/golangci-lint run/);

    assert.notEqual(formatIdx, -1, 'no gofmt step found');
    assert.notEqual(vetIdx, -1, 'no go vet step found');
    assert.notEqual(testIdx, -1, 'no go test step found');
    assert.notEqual(buildIdx, -1, 'no go build step found');
    assert.notEqual(lintRunIdx, -1, 'no golangci-lint run step found');

    // The pre-test step is identified by behaviour, not by an assumed
    // literal step name: it is whichever step wires pre-test-command
    // through via env.
    const preTestIdx = steps.findIndex((s) => {
      const env = getBlock(s, 'env');
      if (!env) return false;
      return /inputs\.pre-test-command/.test(env);
    });
    assert.notEqual(preTestIdx, -1, 'no step wires inputs.pre-test-command through env:');

    assert.ok(formatIdx < vetIdx, 'format must run before vet');
    assert.ok(vetIdx < preTestIdx, 'pre-test-command step must run after vet');
    assert.ok(preTestIdx < testIdx, 'pre-test-command step must run before go test');
    assert.ok(testIdx < buildIdx, 'go test must run before go build');
    assert.ok(buildIdx < lintRunIdx, 'go build must run before golangci-lint run');
  });

  test('go test runs with -race, unconditionally (AC5)', () => {
    requireAction();
    const testStep = steps.find((s) => /go test/.test(getValue(s, 'run') ?? ''));
    assert.ok(testStep, 'no go test step found');
    assert.match(getValue(testStep, 'run') ?? '', /go test -race \.\/\.\.\./);
  });

  test('go test and the pre-test step both run even after an earlier failure', () => {
    requireAction();
    const testStep = steps.find((s) => /go test/.test(getValue(s, 'run') ?? ''));
    assert.equal(getValue(testStep, 'if'), '!cancelled()');

    const preTestStep = steps.find((s) => {
      const env = getBlock(s, 'env');
      return env && /inputs\.pre-test-command/.test(env);
    });
    assert.equal(getValue(preTestStep, 'if'), '!cancelled()');
  });

  test('every step sets its own shell: bash and working-directory (no job-level defaults to rely on) (AC8)', () => {
    requireAction();
    const runSteps = steps.filter((s) => getValue(s, 'run') !== undefined);
    assert.ok(runSteps.length >= 5, 'expected at least 5 run: steps');
    for (const step of runSteps) {
      assert.equal(getValue(step, 'shell'), 'bash', `step "${stepName(step)}" must set shell: bash explicitly`);
      assert.match(
        getValue(step, 'working-directory') ?? '',
        /inputs\.working-directory/,
        `step "${stepName(step)}" must set its own working-directory: \${{ inputs.working-directory }}`,
      );
    }
  });

  test('build step runs "go build ./..."', () => {
    requireAction();
    const buildStep = steps.find((s) => /go build/.test(getValue(s, 'run') ?? ''));
    assert.ok(buildStep);
    assert.match(getValue(buildStep, 'run') ?? '', /go build \.\/\.\.\./);
  });

  test('golangci-lint install and lint steps reference the golangci-lint-version input', () => {
    requireAction();
    const installStep = steps.find((s) => /install\.sh/.test(getValue(s, 'run') ?? ''));
    assert.ok(installStep, 'no golangci-lint install step found');
    const installText = installStep;
    assert.match(installText, /inputs\.golangci-lint-version/);

    const lintStep = steps.find((s) => /golangci-lint run/.test(getValue(s, 'run') ?? ''));
    assert.ok(lintStep, 'no golangci-lint run step found');
    assert.match(getValue(lintStep, 'run') ?? '', /golangci-lint run \.\/\.\.\./);
  });
});

describe('go-checks/action.yml: pre-test-command step (AC7)', () => {
  function findPreTestStep() {
    return steps.find((s) => {
      const env = getBlock(s, 'env');
      return env && /inputs\.pre-test-command/.test(env);
    });
  }

  test('receives the value through env:, never through ${{ }} interpolation in the run body', () => {
    requireAction();
    const step = findPreTestStep();
    assert.ok(step, 'pre-test step not found');
    const run = getValue(step, 'run') ?? '';
    assert.doesNotMatch(
      run,
      /\$\{\{\s*inputs\.pre-test-command\s*\}\}/,
      'pre-test-command must not be interpolated directly into the run body — a crafted command could then run as shell outside the intended variable',
    );
    const env = getBlock(step, 'env');
    assert.match(env, /inputs\.pre-test-command/, 'pre-test-command must be passed via env:');
  });

  test('is a genuine no-op at runtime when pre-test-command is empty', () => {
    requireAction();
    const step = findPreTestStep();
    assert.ok(step, 'pre-test step not found');
    const env = getBlock(step, 'env');
    const envVarMatch = /^\s*([A-Z0-9_]+):\s*\$\{\{\s*inputs\.pre-test-command\s*\}\}\s*$/m.exec(env);
    assert.ok(envVarMatch, `could not find an env var mapped to \${{ inputs.pre-test-command }} in:\n${env}`);
    const envVarName = envVarMatch[1];

    const run = getValue(step, 'run') ?? '';
    assert.ok(run.length > 0, 'pre-test step has no run body to execute');

    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'marker-')), 'ran');
    const result = runBash(`${run}\ntouch '${marker}'`, { [envVarName]: '' });
    // The script itself must not error out just because the command is empty.
    assert.equal(result.status, 0, `expected exit code 0 for an empty command, got ${result.status}\nstderr: ${result.stderr}`);
    // The step must return before reaching the touch below it, proving it
    // actually short-circuited instead of merely happening to exit 0.
    assert.ok(!fs.existsSync(marker), 'expected the step to exit before running anything after it');
  });

  test('actually runs the given command at runtime when pre-test-command is non-empty', () => {
    requireAction();
    const step = findPreTestStep();
    assert.ok(step, 'pre-test step not found');
    const env = getBlock(step, 'env');
    const envVarMatch = /^\s*([A-Z0-9_]+):\s*\$\{\{\s*inputs\.pre-test-command\s*\}\}\s*$/m.exec(env);
    assert.ok(envVarMatch, `could not find an env var mapped to \${{ inputs.pre-test-command }} in:\n${env}`);
    const envVarName = envVarMatch[1];

    const run = getValue(step, 'run') ?? '';
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-'));
    const marker = path.join(scratch, 'ran');

    const result = runBash(run, { [envVarName]: `touch '${marker}'` });
    assert.equal(result.status, 0, `expected exit code 0, got ${result.status}\nstderr: ${result.stderr}`);
    assert.ok(fs.existsSync(marker), 'expected the command in pre-test-command to actually execute');
  });
});
