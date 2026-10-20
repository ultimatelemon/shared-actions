// Structural AND behavioural tests for
// .github/actions/node-checks/action.yml.
//
// Modeled closely on test/go-checks-action.test.mjs: steps without a
// meaningful literal `name:` are identified by behaviour (the `uses:`
// target, or what their `env:`/`run:` actually reference), not by an
// assumed step name. Where a step is "just" a shell snippet, we actually
// execute the extracted bash with `bash -c` (via the shared `runBash`
// helper) in a scratch directory, because that is the one thing pure
// structural parsing cannot verify: whether an empty `npmrc` input really
// is a no-op, and whether a non-empty one really writes `~/.npmrc` with
// the right content and the right permissions.
//
// Run with: node --test test/node-checks-action.test.mjs

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
  normalizeCondition,
  runBash,
  lines,
} from './helpers.mjs';

const ACTION_PATH = '.github/actions/node-checks/action.yml';

describe('node-checks/action.yml exists and is a composite action', () => {
  test('file exists at the documented path', () => {
    assert.ok(fileExists(ACTION_PATH), `expected a composite action at ${ACTION_PATH} — it does not exist`);
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

/**
 * Returns the names of the *direct* children of a block of mapping text
 * (e.g. the top-level input names directly under "inputs:"), ignoring
 * anything nested deeper. This intentionally mirrors the indentation
 * rule the rest of this repo's test helpers use (same indent as the
 * block's own first line = sibling key), scoped to this one assertion so
 * we can do an exact-set comparison instead of N independent existence
 * checks.
 */
function directChildKeyNames(blockText) {
  const allLines = lines(blockText);
  const nonBlank = allLines.filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (nonBlank.length === 0) return [];
  const baseIndent = /^( *)/.exec(nonBlank[0])[1].length;
  const names = [];
  for (const l of allLines) {
    const trimmed = l.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = /^( *)/.exec(l)[1].length;
    if (indent !== baseIndent) continue;
    const m = /^([\w-]+):/.exec(trimmed);
    if (m) names.push(m[1]);
  }
  return names;
}

describe('node-checks/action.yml inputs', () => {
  test('declares exactly node-version, package-manager, working-directory, npmrc — no more, no fewer', () => {
    requireAction();
    assert.ok(inputsBlock, 'missing inputs: block');
    const actual = new Set(directChildKeyNames(inputsBlock));
    const expected = new Set(['node-version', 'package-manager', 'working-directory', 'npmrc']);
    assert.deepEqual(
      actual,
      expected,
      `inputs: block must declare exactly {${[...expected].join(', ')}}, found {${[...actual].join(', ')}}`,
    );
  });

  test('node-version defaults to \'24\'', () => {
    requireAction();
    const block = getBlock(inputsBlock, 'node-version');
    assert.ok(block, 'missing input "node-version"');
    assert.equal(getValue(block, 'default'), '24');
  });

  test('package-manager defaults to npm', () => {
    requireAction();
    const block = getBlock(inputsBlock, 'package-manager');
    assert.ok(block, 'missing input "package-manager"');
    assert.equal(getValue(block, 'default'), 'npm');
  });

  test('working-directory defaults to .', () => {
    requireAction();
    const block = getBlock(inputsBlock, 'working-directory');
    assert.ok(block, 'missing input "working-directory"');
    assert.equal(getValue(block, 'default'), '.');
  });

  test('npmrc defaults to an empty string', () => {
    requireAction();
    const block = getBlock(inputsBlock, 'npmrc');
    assert.ok(block, 'missing input "npmrc"');
    assert.equal(getValue(block, 'default'), '');
  });
});

function findEnablePnpmStep() {
  return steps.find((s) => /pnpm\/action-setup/.test(getValue(s, 'uses') ?? ''));
}

function findSetupNodeStep() {
  return steps.find((s) => /actions\/setup-node/.test(getValue(s, 'uses') ?? ''));
}

function findNpmAuthStep() {
  return steps.find((s) => {
    const env = getBlock(s, 'env');
    return env && /inputs\.npmrc/.test(env);
  });
}

function findInstallStep() {
  return steps.find((s) => {
    const run = getValue(s, 'run') ?? '';
    return /pnpm install --frozen-lockfile/.test(run) && /npm ci/.test(run);
  });
}

function findScriptStep(scriptName) {
  const re = new RegExp(`run --if-present ${scriptName}$`);
  return steps.find((s) => re.test((getValue(s, 'run') ?? '').trim()));
}

describe('node-checks/action.yml: enable pnpm step', () => {
  test('is conditional on package-manager == pnpm', () => {
    requireAction();
    const step = findEnablePnpmStep();
    assert.ok(step, 'no step using pnpm/action-setup found');
    assert.equal(
      normalizeCondition(getValue(step, 'if')),
      normalizeCondition("inputs.package-manager == 'pnpm'"),
    );
  });

  test('passes package_json_file derived from working-directory', () => {
    requireAction();
    const step = findEnablePnpmStep();
    assert.ok(step, 'no step using pnpm/action-setup found');
    const withBlock = getBlock(step, 'with');
    assert.ok(withBlock, 'enable pnpm step has no with: block');
    assert.match(getValue(withBlock, 'package_json_file') ?? '', /inputs\.working-directory/);
  });
});

describe('node-checks/action.yml: setup-node step', () => {
  test('cache is driven by the package-manager input', () => {
    requireAction();
    const step = findSetupNodeStep();
    assert.ok(step, 'no step using actions/setup-node found');
    const withBlock = getBlock(step, 'with');
    assert.ok(withBlock, 'setup-node step has no with: block');
    assert.equal(getValue(withBlock, 'cache'), "${{ inputs.package-manager }}");
  });

  test('cache-dependency-path picks pnpm-lock.yaml for pnpm and package-lock.json for npm, under working-directory', () => {
    requireAction();
    const step = findSetupNodeStep();
    assert.ok(step, 'no step using actions/setup-node found');
    const withBlock = getBlock(step, 'with');
    assert.ok(withBlock, 'setup-node step has no with: block');
    const cdp = getValue(withBlock, 'cache-dependency-path') ?? '';
    // Four independent substring checks would stay green even if the
    // ternary's branches were swapped (pnpm pointed at package-lock.json
    // and vice versa). Pin the actual binding between the condition and
    // its lockfile instead.
    assert.match(
      cdp,
      /inputs\.package-manager == 'pnpm'\s*&&\s*'pnpm-lock\.yaml'\s*\|\|\s*'package-lock\.json'/,
      'cache-dependency-path must pick pnpm-lock.yaml when package-manager is pnpm, package-lock.json otherwise',
    );
    assert.match(cdp, /inputs\.working-directory/, 'must reference inputs.working-directory');
  });
});

describe('node-checks/action.yml: npm auth step (structural)', () => {
  test('receives npmrc through env:, never through ${{ }} interpolation in the run body', () => {
    requireAction();
    const step = findNpmAuthStep();
    assert.ok(step, 'no step wiring inputs.npmrc through env: found');
    const run = getValue(step, 'run') ?? '';
    assert.doesNotMatch(
      run,
      /\$\{\{\s*inputs\.npmrc\s*\}\}/,
      'npmrc must not be interpolated directly into the run body — secrets must flow through env: only',
    );
    const env = getBlock(step, 'env');
    assert.match(env, /inputs\.npmrc/, 'npmrc must be passed via env:');
  });
});

describe('node-checks/action.yml: npm auth step (behavioural)', () => {
  function envVarNameFor(step) {
    const env = getBlock(step, 'env');
    const m = /^\s*([A-Z0-9_]+):\s*\$\{\{\s*inputs\.npmrc\s*\}\}\s*$/m.exec(env);
    assert.ok(m, `could not find an env var mapped to \${{ inputs.npmrc }} in:\n${env}`);
    return m[1];
  }

  test('is a genuine no-op and writes nothing when npmrc is empty', () => {
    requireAction();
    const step = findNpmAuthStep();
    assert.ok(step, 'no npm auth step found');
    const envVarName = envVarNameFor(step);

    const run = getValue(step, 'run') ?? '';
    assert.ok(run.length > 0, 'npm auth step has no run body to execute');

    // Never let this test write to the real developer/CI-runner $HOME —
    // give it its own scratch HOME and make the step use that instead.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'node-checks-home-'));
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'node-checks-marker-')), 'ran');

    const result = runBash(`${run}\ntouch '${marker}'`, { [envVarName]: '', HOME: fakeHome });
    assert.equal(result.status, 0, `expected exit code 0 for empty npmrc, got ${result.status}\nstderr: ${result.stderr}`);
    assert.ok(
      !fs.existsSync(path.join(fakeHome, '.npmrc')),
      'expected no ~/.npmrc to be written when npmrc is empty',
    );
    // The step must return before reaching the touch below it, proving it
    // actually short-circuited instead of merely happening to exit 0.
    assert.ok(!fs.existsSync(marker), 'expected the step to exit before running anything after it');
  });

  test('writes a 0600 ~/.npmrc with the given content when npmrc is non-empty', () => {
    requireAction();
    const step = findNpmAuthStep();
    assert.ok(step, 'no npm auth step found');
    const envVarName = envVarNameFor(step);

    const run = getValue(step, 'run') ?? '';
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'node-checks-home-'));
    const dummyToken = 'some-dummy-value-not-a-real-token';

    const result = runBash(run, { [envVarName]: dummyToken, HOME: fakeHome });
    assert.equal(result.status, 0, `expected exit code 0, got ${result.status}\nstderr: ${result.stderr}`);

    const npmrcPath = path.join(fakeHome, '.npmrc');
    assert.ok(fs.existsSync(npmrcPath), 'expected ~/.npmrc to be written when npmrc is non-empty');
    // The script does `printf '%s\n' "$NPMRC" > file`, which adds a
    // trailing newline, so compare after trimming.
    assert.equal(fs.readFileSync(npmrcPath, 'utf8').trim(), dummyToken);
    assert.equal(fs.statSync(npmrcPath).mode & 0o777, 0o600, 'expected ~/.npmrc to be chmod 600');
  });
});

describe('node-checks/action.yml: install step', () => {
  test('runs pnpm install --frozen-lockfile for pnpm and npm ci otherwise', () => {
    requireAction();
    const step = findInstallStep();
    assert.ok(step, 'no install step found running both pnpm install --frozen-lockfile and npm ci');
    // Locating the step already requires both literals to be present; that
    // alone doesn't prove which branch goes with which package manager, so
    // pin the actual condition-to-command binding too (otherwise swapping
    // the two branches would stay undetected).
    const run = getValue(step, 'run') ?? '';
    assert.match(
      run,
      /inputs\.package-manager == 'pnpm'\s*&&\s*'pnpm install --frozen-lockfile'\s*\|\|\s*'npm ci'/,
      "install step must run 'pnpm install --frozen-lockfile' when package-manager is pnpm, 'npm ci' otherwise",
    );
  });
});

describe('node-checks/action.yml: caches', () => {
  function findCacheStep(pathRe) {
    return steps.find((s) => {
      const withBlock = getBlock(s, 'with') ?? '';
      return /actions\/cache@/.test(getValue(s, 'uses') ?? '') && pathRe.test(getValue(withBlock, 'path') ?? '');
    });
  }

  test('cache keys are computed in a step before install, not inline in the cache steps', () => {
    requireAction();
    const keysIdx = steps.findIndex((s) => getValue(s, 'id') === 'keys');
    assert.notEqual(keysIdx, -1, 'no step with id "keys" found');
    assert.ok(keysIdx < steps.indexOf(findInstallStep()), 'keys must be computed before install');
    for (const step of [findCacheStep(/node_modules$/), findCacheStep(/\.next\/cache$/)]) {
      assert.ok(step, 'missing node_modules or .next/cache cache step');
      // The post step re-evaluates its inputs; hashFiles there would walk node_modules.
      assert.doesNotMatch(getBlock(step, 'with'), /hashFiles/, 'cache steps must take their keys from steps.keys');
    }
  });

  test('a node_modules hit skips install and runs the root install scripts instead', () => {
    requireAction();
    const cache = findCacheStep(/node_modules$/);
    assert.ok(cache, 'no node_modules cache step found');
    assert.equal(getValue(cache, 'id'), 'node-modules');
    assert.equal(
      normalizeCondition(getValue(findInstallStep(), 'if')),
      normalizeCondition("steps.node-modules.outputs.cache-hit != 'true'"),
    );
    const scripts = steps.find((s) => /for script in preinstall install postinstall prepare/.test(getValue(s, 'run') ?? ''));
    assert.ok(scripts, 'no step running the install scripts found');
    assert.equal(
      normalizeCondition(getValue(scripts, 'if')),
      normalizeCondition("steps.node-modules.outputs.cache-hit == 'true'"),
    );
  });

  test('node_modules is not cached for workspaces', () => {
    requireAction();
    const keys = steps.find((s) => getValue(s, 'id') === 'keys');
    const run = getValue(keys, 'run') ?? '';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-checks-keys-'));
    const out = path.join(dir, 'out');
    const env = { LOCK: 'abc', SOURCES: 'def', PREFIX: 'Linux-nodev24-npm', GITHUB_OUTPUT: out };
    const outputs = (pkg, extra = {}) => {
      fs.writeFileSync(path.join(dir, 'package.json'), pkg);
      for (const [f, c] of Object.entries(extra)) fs.writeFileSync(path.join(dir, f), c);
      fs.writeFileSync(out, '');
      const result = runBash(`cd '${dir}'\n${run}`, env);
      assert.equal(result.status, 0, result.stderr);
      return fs.readFileSync(out, 'utf8');
    };
    assert.match(outputs('{"name":"app"}'), /^modules=node-modules-Linux-nodev24-npm-abc$/m);
    assert.doesNotMatch(outputs('{"workspaces":["packages/*"]}'), /^modules=/m);
    assert.doesNotMatch(outputs('{"name":"app"}', { 'pnpm-workspace.yaml': 'packages: []\n' }), /^modules=/m);
  });
});

describe('node-checks/action.yml: script steps', () => {
  const scriptCases = [
    ['format', 'format:check'],
    ['typecheck', 'typecheck'],
    ['lint', 'lint'],
    ['test', 'test'],
    ['build', 'build'],
    ['verify', 'verify'],
  ];

  for (const [label, scriptName] of scriptCases) {
    test(`${label} step runs "\${{ inputs.package-manager }} run --if-present ${scriptName}" with if: '!cancelled()'`, () => {
      requireAction();
      const step = findScriptStep(scriptName);
      assert.ok(step, `no step running --if-present ${scriptName} found`);
      assert.equal(getValue(step, 'if'), '!cancelled()');
      assert.equal(
        (getValue(step, 'run') ?? '').trim(),
        `\${{ inputs.package-manager }} run --if-present ${scriptName}`,
      );
    });
  }
});

describe('node-checks/action.yml step order', () => {
  test('enable-pnpm < setup-node < npm-auth < install < format < typecheck < lint < test < build < verify', () => {
    requireAction();
    assert.ok(steps.length > 0, 'no steps found');

    const enablePnpmIdx = steps.findIndex((s) => /pnpm\/action-setup/.test(getValue(s, 'uses') ?? ''));
    const setupNodeIdx = steps.findIndex((s) => /actions\/setup-node/.test(getValue(s, 'uses') ?? ''));
    const npmAuthIdx = steps.findIndex((s) => {
      const env = getBlock(s, 'env');
      return env && /inputs\.npmrc/.test(env);
    });
    const installIdx = steps.findIndex((s) => {
      const run = getValue(s, 'run') ?? '';
      return /pnpm install --frozen-lockfile/.test(run) && /npm ci/.test(run);
    });
    const formatIdx = steps.findIndex((s) => /run --if-present format:check$/.test((getValue(s, 'run') ?? '').trim()));
    const typecheckIdx = steps.findIndex((s) => /run --if-present typecheck$/.test((getValue(s, 'run') ?? '').trim()));
    const lintIdx = steps.findIndex((s) => /run --if-present lint$/.test((getValue(s, 'run') ?? '').trim()));
    const testIdx = steps.findIndex((s) => /run --if-present test$/.test((getValue(s, 'run') ?? '').trim()));
    const buildIdx = steps.findIndex((s) => /run --if-present build$/.test((getValue(s, 'run') ?? '').trim()));
    const verifyIdx = steps.findIndex((s) => /run --if-present verify$/.test((getValue(s, 'run') ?? '').trim()));

    assert.notEqual(enablePnpmIdx, -1, 'no enable pnpm step found');
    assert.notEqual(setupNodeIdx, -1, 'no setup-node step found');
    assert.notEqual(npmAuthIdx, -1, 'no npm auth step found');
    assert.notEqual(installIdx, -1, 'no install step found');
    assert.notEqual(formatIdx, -1, 'no format step found');
    assert.notEqual(typecheckIdx, -1, 'no typecheck step found');
    assert.notEqual(lintIdx, -1, 'no lint step found');
    assert.notEqual(testIdx, -1, 'no test step found');
    assert.notEqual(buildIdx, -1, 'no build step found');
    assert.notEqual(verifyIdx, -1, 'no verify step found');

    assert.ok(enablePnpmIdx < setupNodeIdx, 'enable pnpm must run before setup-node');
    assert.ok(setupNodeIdx < npmAuthIdx, 'setup-node must run before npm auth');
    assert.ok(npmAuthIdx < installIdx, 'npm auth must run before install');
    assert.ok(installIdx < formatIdx, 'install must run before format');
    assert.ok(formatIdx < typecheckIdx, 'format must run before typecheck');
    assert.ok(typecheckIdx < lintIdx, 'typecheck must run before lint');
    assert.ok(lintIdx < testIdx, 'lint must run before test');
    assert.ok(testIdx < buildIdx, 'test must run before build');
    assert.ok(buildIdx < verifyIdx, 'build must run before verify');
  });
});
