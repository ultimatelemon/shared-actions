// Structural tests for .github/workflows/dokploy-deploy.yml against card
// INF-22: two new optional secrets (cf-access-client-id,
// cf-access-client-secret) used to add optional Cloudflare Access
// service-token headers (CF-Access-Client-Id / CF-Access-Client-Secret) to
// the Dokploy deploy webhook call, additive and backward compatible.
//
// Most of these tests check the YAML as data (the workflow_call.secrets
// block, the step's env:, and the literal text of the run: script body)
// rather than the behaviour of a real GitHub-hosted runner. The run-script
// body is inspected with plain text/regex checks for most assertions, since
// the point there is to pin down the *shape* of the script (unconditional
// base headers, headers added only inside an if-branch keyed on both env
// vars, no direct secret interpolation), which is exactly what a structural
// check is good at.
//
// The one place a structural check is not enough is whether the assembled
// `headers` array actually reaches the `curl` call with correct quoting —
// a missing `"${headers[@]}"` or an unquoted expansion would still satisfy
// every text-based assertion while silently breaking the request. The
// "behavioural" describe block below closes that gap the same way
// test/go-checks-action.test.mjs already does for its own run bodies: by
// running the extracted script through real bash (via helpers.mjs'
// runBash) with stub `curl`/`jq` executables on PATH that record their argv.
//
// Written against the acceptance criteria on the card. Run with:
//   node --test test/dokploy-deploy-workflow.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readRepoFile,
  getBlock,
  getValue,
  getJobBlock,
  splitSteps,
  stepName,
  runBash,
} from './helpers.mjs';

const WORKFLOW_PATH = '.github/workflows/dokploy-deploy.yml';
const workflow = readRepoFile(WORKFLOW_PATH);

// "secrets:" lives two levels deep, under on: -> workflow_call:, same as
// "inputs:" in the go-quality.yml tests — it has to be reached by walking
// the structure, not searched for directly in the whole file.
const onBlock = getBlock(workflow, 'on');
const workflowCallBlock = onBlock && getBlock(onBlock, 'workflow_call');
const secretsBlock = workflowCallBlock && getBlock(workflowCallBlock, 'secrets');

const deployJob = getJobBlock(workflow, 'deploy');
const deploySteps = deployJob ? splitSteps(getBlock(deployJob, 'steps')) : [];
// There is only one step today; find it by its run body (rather than
// assuming it stays the first/only step) so the test keeps working even if
// a step is prepended later.
const webhookStep =
  deploySteps.find((s) => /curl/.test(getValue(s, 'run') ?? '')) ?? deploySteps[0];
const runText = webhookStep ? getValue(webhookStep, 'run') ?? '' : '';

/**
 * Extracts the text of every top-level `if ... fi` block in a bash script,
 * using simple word-boundary token scanning (depth-counts `if`/`fi` as
 * whole words). This is not a real shell parser, but this repo's run
 * scripts are small and conventionally formatted, so it is reliable enough
 * to check *where* a line lives (inside vs. outside a conditional) without
 * having to assume the implementer's exact wording of the condition.
 */
function extractIfBlocks(text) {
  const tokenRe = /\b(if|fi)\b/g;
  let match;
  let depth = 0;
  let start = -1;
  const blocks = [];
  while ((match = tokenRe.exec(text)) !== null) {
    if (match[1] === 'if') {
      if (depth === 0) start = match.index;
      depth++;
    } else {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(text.slice(start, match.index + 2));
        start = -1;
      }
    }
  }
  return blocks;
}

/** Removes every top-level `if ... fi` block, leaving only unconditional text. */
function removeIfBlocks(text) {
  let result = text;
  for (const block of extractIfBlocks(text)) {
    result = result.replace(block, '');
  }
  return result;
}

describe('dokploy-deploy.yml workflow_call.secrets (AC1)', () => {
  test('secrets block exists', () => {
    assert.ok(secretsBlock, 'expected a workflow_call.secrets block');
  });

  test('keeps webhook-url required and otherwise unchanged', () => {
    assert.ok(secretsBlock, 'secrets block missing');
    const webhookUrl = getBlock(secretsBlock, 'webhook-url');
    assert.ok(webhookUrl, 'expected the pre-existing webhook-url secret to still be declared');
    assert.equal(getValue(webhookUrl, 'required'), 'true', 'webhook-url must stay required: true');
    assert.equal(
      getValue(webhookUrl, 'description'),
      'Dokploy deploy webhook for the application.',
      'webhook-url description should be unchanged',
    );
  });

  test('declares cf-access-client-id as optional (required: false)', () => {
    assert.ok(secretsBlock, 'secrets block missing');
    const block = getBlock(secretsBlock, 'cf-access-client-id');
    assert.ok(block, 'expected a "cf-access-client-id" secret under workflow_call.secrets');
    assert.equal(getValue(block, 'required'), 'false', 'cf-access-client-id must be required: false');
  });

  test('declares cf-access-client-secret as optional (required: false)', () => {
    assert.ok(secretsBlock, 'secrets block missing');
    const block = getBlock(secretsBlock, 'cf-access-client-secret');
    assert.ok(block, 'expected a "cf-access-client-secret" secret under workflow_call.secrets');
    assert.equal(getValue(block, 'required'), 'false', 'cf-access-client-secret must be required: false');
  });

  test('declares exactly one of each secret (no accidental duplicates)', () => {
    assert.ok(secretsBlock, 'secrets block missing');
    assert.equal(
      (secretsBlock.match(/^\s*cf-access-client-id:\s*$/gm) || []).length,
      1,
      'expected exactly one "cf-access-client-id:" secret declaration',
    );
    assert.equal(
      (secretsBlock.match(/^\s*cf-access-client-secret:\s*$/gm) || []).length,
      1,
      'expected exactly one "cf-access-client-secret:" secret declaration',
    );
  });
});

describe('dokploy-deploy.yml "trigger Dokploy redeploy" step: env wiring (AC4)', () => {
  test('step exists', () => {
    assert.ok(webhookStep, 'expected to find the step that curls the Dokploy webhook');
  });

  test('passes both secrets through env, same pattern as WEBHOOK_URL/COMMIT_MESSAGE', () => {
    assert.ok(webhookStep, 'step missing');
    const env = getBlock(webhookStep, 'env');
    assert.ok(env, 'expected an env: block on the webhook step');

    const clientId = getValue(env, 'CF_ACCESS_CLIENT_ID');
    assert.ok(clientId, 'expected CF_ACCESS_CLIENT_ID in the step env');
    assert.match(clientId, /\$\{\{\s*secrets\.cf-access-client-id\s*\}\}/, 'CF_ACCESS_CLIENT_ID must come from secrets.cf-access-client-id');

    const clientSecret = getValue(env, 'CF_ACCESS_CLIENT_SECRET');
    assert.ok(clientSecret, 'expected CF_ACCESS_CLIENT_SECRET in the step env');
    assert.match(
      clientSecret,
      /\$\{\{\s*secrets\.cf-access-client-secret\s*\}\}/,
      'CF_ACCESS_CLIENT_SECRET must come from secrets.cf-access-client-secret',
    );

    // Pre-existing env entries must still be there, unchanged.
    assert.match(getValue(env, 'WEBHOOK_URL') ?? '', /secrets\.webhook-url/);
    assert.match(getValue(env, 'COMMIT_MESSAGE') ?? '', /github\.event\.head_commit\.message/);
  });

  test('the run-script body never interpolates the secrets directly (goes through env only)', () => {
    assert.ok(webhookStep, 'step missing');
    assert.doesNotMatch(
      runText,
      /\$\{\{\s*secrets\.cf-access-client-id\s*\}\}/,
      'the run body must read $CF_ACCESS_CLIENT_ID from env, not interpolate ${{ secrets.cf-access-client-id }} directly into the script',
    );
    assert.doesNotMatch(
      runText,
      /\$\{\{\s*secrets\.cf-access-client-secret\s*\}\}/,
      'the run body must read $CF_ACCESS_CLIENT_SECRET from env, not interpolate ${{ secrets.cf-access-client-secret }} directly into the script',
    );
  });

  test('the step itself is not conditionally skipped based on these secrets (no if: on secrets.*)', () => {
    assert.ok(webhookStep, 'step missing');
    const stepIf = getValue(webhookStep, 'if');
    if (stepIf !== undefined) {
      assert.doesNotMatch(
        stepIf,
        /secrets\.cf-access-client/,
        'the branching must happen inside the bash body, not by skipping the whole step via a YAML if: on these secrets',
      );
    }
  });
});

describe('dokploy-deploy.yml "trigger Dokploy redeploy" step: conditional CF-Access headers (AC2, AC3)', () => {
  test('run body mentions both CF-Access header names and both env vars', () => {
    assert.ok(webhookStep, 'step missing');
    assert.match(runText, /CF-Access-Client-Id/, 'expected the CF-Access-Client-Id header name in the run body');
    assert.match(runText, /CF-Access-Client-Secret/, 'expected the CF-Access-Client-Secret header name in the run body');
    assert.match(runText, /CF_ACCESS_CLIENT_ID/, 'expected the CF_ACCESS_CLIENT_ID env var to be referenced');
    assert.match(runText, /CF_ACCESS_CLIENT_SECRET/, 'expected the CF_ACCESS_CLIENT_SECRET env var to be referenced');
  });

  test('adds the CF-Access headers from inside a conditional branch, not unconditionally', () => {
    assert.ok(webhookStep, 'step missing');
    const ifBlocks = extractIfBlocks(runText);
    assert.ok(ifBlocks.length > 0, 'expected at least one if/fi block in the run body');

    const headerBlock = ifBlocks.find(
      (block) => /CF-Access-Client-Id/.test(block) && /CF-Access-Client-Secret/.test(block),
    );
    assert.ok(
      headerBlock,
      'expected an if/fi block whose body adds both the CF-Access-Client-Id and CF-Access-Client-Secret headers together',
    );

    // The branch's own condition (its first line) must check both env vars,
    // not just one -- the headers are a pair and must be keyed on both
    // being present, per the card ("when both secrets are set").
    const conditionLine = headerBlock.split('\n')[0];
    assert.match(
      conditionLine,
      /CF_ACCESS_CLIENT_ID/,
      `expected the guarding if-condition to test CF_ACCESS_CLIENT_ID, got: ${conditionLine}`,
    );
    assert.match(
      conditionLine,
      /CF_ACCESS_CLIENT_SECRET/,
      `expected the guarding if-condition to test CF_ACCESS_CLIENT_SECRET, got: ${conditionLine}`,
    );

    // Everything outside any if/fi block must not mention the CF-Access
    // headers at all -- i.e. they are never added unconditionally.
    const unconditional = removeIfBlocks(runText);
    assert.doesNotMatch(
      unconditional,
      /CF-Access-Client-Id|CF-Access-Client-Secret/,
      'the CF-Access headers must only be added inside a conditional branch, never unconditionally',
    );
  });

  test('the base headers (Content-Type + X-GitHub-Event) stay unconditional / unchanged', () => {
    assert.ok(webhookStep, 'step missing');
    const unconditional = removeIfBlocks(runText);
    assert.match(
      unconditional,
      /-H\s+'Content-Type: application\/json'/,
      'expected the Content-Type: application/json header to remain unconditional and unchanged',
    );
    assert.match(
      unconditional,
      /-H\s+'X-GitHub-Event: push'/,
      'expected the X-GitHub-Event: push header to remain unconditional and unchanged',
    );

    // Each base header line must appear exactly once in the whole script --
    // not duplicated once unconditionally and once again inside a branch.
    assert.equal(
      (runText.match(/-H\s+'Content-Type: application\/json'/g) || []).length,
      1,
      'Content-Type header should appear exactly once',
    );
    assert.equal(
      (runText.match(/-H\s+'X-GitHub-Event: push'/g) || []).length,
      1,
      'X-GitHub-Event header should appear exactly once',
    );
  });

  test('there is exactly one curl invocation, with -o/-w/-X POST/-d and the webhook URL all present', () => {
    // Static-analysis proxy for "byte-identical to today when either secret
    // is missing": the curl invocation line itself (method, -o, -w,
    // payload, target URL) must be the same single statement as today, with
    // no alternate/duplicated curl call guarded by a *different* condition
    // (e.g. no second "curl -sS ... -X POST" elsewhere in the script).
    assert.ok(webhookStep, 'step missing');
    const curlInvocations = runText.match(/curl\s+-sS/g) || [];
    assert.equal(
      curlInvocations.length,
      1,
      'expected exactly one curl invocation -- headers must be assembled conditionally and fed into the same single curl call, not via a second duplicated call',
    );
    assert.match(runText, /-o\s+\/tmp\/dokploy-response/, 'expected the -o /tmp/dokploy-response flag to remain');
    assert.match(runText, /-w\s+'%\{http_code\}'/, 'expected the -w \'%{http_code}\' flag to remain');
    assert.match(runText, /-X\s+POST/, 'expected -X POST to remain');
    assert.match(runText, /-d\s+"\$payload"/, 'expected -d "$payload" to remain');
    assert.match(runText, /"\$WEBHOOK_URL"/, 'expected the target URL argument "$WEBHOOK_URL" to remain');
  });

  test('the assembled headers array is actually passed to curl, properly quoted', () => {
    // Closes the gap the regex checks above cannot: a `headers=(...)` array
    // that is built but never referenced, or referenced unquoted as
    // ${headers[@]} (which would word-split 'Content-Type: application/json'
    // into two argv entries), would still satisfy every assertion above.
    assert.ok(webhookStep, 'step missing');
    assert.match(
      runText,
      /curl[^\n]*\n(?:[^\n]*\n)*?[^\n]*"\$\{headers\[@\]\}"/,
      'expected the curl invocation to expand the headers array as "${headers[@]}" (quoted) so each -H flag/value survives as one argv word',
    );
    assert.doesNotMatch(
      runText,
      /(?<!")\$\{headers\[@\]\}/,
      'the headers array expansion must be fully quoted ("${headers[@]}"), not left unquoted where it would word-split',
    );
  });
});

describe('dokploy-deploy.yml "trigger Dokploy redeploy" step: behavioural curl argv (AC2, AC3)', () => {
  // Runs the extracted run-script body through real bash with stub
  // curl/jq executables on PATH that record their argv to a file, instead
  // of only pattern-matching the script text. This is the only way to be
  // sure the headers array is both built *and* actually reaches curl with
  // the right quoting in every combination of the two secrets being set.

  function withStubBinDir(fn) {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dokploy-stub-bin-'));
    const captureFile = path.join(binDir, 'curl-argv.txt');

    // Stub curl: records every argv word on its own line, writes a dummy
    // body to whatever -o path it was given, and prints a fixed "200" to
    // stdout (standing in for curl's -w '%{http_code}' output, since real
    // -o diverts the response body elsewhere).
    fs.writeFileSync(
      path.join(binDir, 'curl'),
      [
        '#!/usr/bin/env bash',
        `printf '%s\\n' "$@" > '${captureFile}'`,
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "-o" ]; then printf \'stub body\' > "$arg"; fi',
        '  prev="$arg"',
        'done',
        'printf 200',
      ].join('\n'),
      { mode: 0o755 },
    );

    // Stub jq: the script only uses it to build a JSON payload that this
    // test does not inspect, so any well-formed, successful output is fine.
    fs.writeFileSync(path.join(binDir, 'jq'), ['#!/usr/bin/env bash', "printf '{}'"].join('\n'), {
      mode: 0o755,
    });

    try {
      return fn(binDir, captureFile);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  }

  function runWebhookScript(env) {
    return withStubBinDir((binDir, captureFile) => {
      const result = runBash(runText, {
        PATH: `${binDir}:${process.env.PATH}`,
        WEBHOOK_URL: 'https://example.invalid/hook/opaque-token',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
        COMMIT_MESSAGE: 'test commit',
        CF_ACCESS_CLIENT_ID: '',
        CF_ACCESS_CLIENT_SECRET: '',
        ...env,
      });
      assert.equal(result.status, 0, `expected the deploy script to exit 0, got ${result.status}\nstderr: ${result.stderr}`);
      const argv = fs.existsSync(captureFile)
        ? fs.readFileSync(captureFile, 'utf8').split('\n').filter((l) => l !== '')
        : [];
      return argv;
    });
  }

  /**
   * Extracts every "-H <value>" pair from an argv list by position (not by
   * substring-matching the value), so the result can never accidentally
   * pick up an unrelated argument that happens to contain a colon (e.g. the
   * "https://..." webhook URL).
   */
  function headerArgs(argv) {
    const result = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '-H') {
        result.push(argv[i], argv[i + 1]);
        i++;
      }
    }
    return result;
  }

  test('sends CF-Access-Client-Id/Secret headers, in addition to the base headers, when both secrets are set', () => {
    assert.ok(webhookStep, 'step missing');
    const argv = runWebhookScript({
      CF_ACCESS_CLIENT_ID: 'my-client-id',
      CF_ACCESS_CLIENT_SECRET: 'my-client-secret',
    });

    assert.deepEqual(
      headerArgs(argv),
      [
        '-H',
        'Content-Type: application/json',
        '-H',
        'X-GitHub-Event: push',
        '-H',
        'CF-Access-Client-Id: my-client-id',
        '-H',
        'CF-Access-Client-Secret: my-client-secret',
      ],
      `expected both base headers and both CF-Access headers as distinct, intact argv words, got: ${JSON.stringify(argv)}`,
    );
  });

  test('sends only the base headers, byte-identical to today, when CF_ACCESS_CLIENT_SECRET is empty', () => {
    assert.ok(webhookStep, 'step missing');
    const argv = runWebhookScript({ CF_ACCESS_CLIENT_ID: 'my-client-id', CF_ACCESS_CLIENT_SECRET: '' });

    assert.deepEqual(
      headerArgs(argv),
      ['-H', 'Content-Type: application/json', '-H', 'X-GitHub-Event: push'],
      `expected no CF-Access headers when only one secret is set, got: ${JSON.stringify(argv)}`,
    );
  });

  test('sends only the base headers, byte-identical to today, when CF_ACCESS_CLIENT_ID is empty', () => {
    assert.ok(webhookStep, 'step missing');
    const argv = runWebhookScript({ CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: 'my-client-secret' });

    assert.deepEqual(
      headerArgs(argv),
      ['-H', 'Content-Type: application/json', '-H', 'X-GitHub-Event: push'],
      `expected no CF-Access headers when only one secret is set, got: ${JSON.stringify(argv)}`,
    );
  });

  test('sends only the base headers, byte-identical to today, when neither secret is set', () => {
    assert.ok(webhookStep, 'step missing');
    const argv = runWebhookScript({ CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '' });

    assert.deepEqual(
      headerArgs(argv),
      ['-H', 'Content-Type: application/json', '-H', 'X-GitHub-Event: push'],
      `expected no CF-Access headers when neither secret is set, got: ${JSON.stringify(argv)}`,
    );
  });
});

describe('dokploy-deploy.yml "trigger Dokploy redeploy" step: status check unchanged (AC5)', () => {
  test('still uses curl -sS (not curl -f) with explicit 2xx/3xx-boundary status check', () => {
    assert.ok(webhookStep, 'step missing');
    assert.match(runText, /curl\s+-sS\b/, 'expected curl -sS to remain');
    assert.doesNotMatch(runText, /curl\s+(-\w*f\w*\s|--fail\b)/, 'curl -f/--fail must not be introduced (it masks 3xx-as-success issues)');
    assert.match(runText, /\$code"?\s+-lt\s+200/, 'expected the explicit "$code -lt 200" check to remain');
    assert.match(runText, /\$code"?\s+-ge\s+300/, 'expected the explicit "$code -ge 300" check to remain');
  });

  test('no verbose/tracing flags are introduced anywhere in the run body', () => {
    assert.ok(webhookStep, 'step missing');
    assert.doesNotMatch(runText, /curl\s+[^\n]*(\s-v\b|--trace\b|--trace-ascii\b)/, 'no -v/--trace flag should appear on the curl call');
    assert.doesNotMatch(runText, /\s-v\s|--trace\b/, 'no -v/--trace flag should appear anywhere in the run body');
  });
});

describe('dokploy-deploy.yml: edge cases', () => {
  test('the step name is unchanged ("trigger Dokploy redeploy")', () => {
    assert.ok(webhookStep, 'step missing');
    assert.equal(stepName(webhookStep), 'trigger Dokploy redeploy');
  });

  test('the "deploy" job still has exactly one step', () => {
    assert.ok(deployJob, 'deploy job missing');
    assert.equal(deploySteps.length, 1, 'expected the deploy job to still have exactly one step');
  });

  test('inputs block (url/environment/runs-on) is untouched by this change', () => {
    const inputsBlock = workflowCallBlock && getBlock(workflowCallBlock, 'inputs');
    assert.ok(inputsBlock, 'expected workflow_call.inputs to still exist');
    assert.equal(getValue(getBlock(inputsBlock, 'url'), 'default'), '');
    assert.equal(getValue(getBlock(inputsBlock, 'environment'), 'default'), 'production');
    assert.equal(getValue(getBlock(inputsBlock, 'runs-on'), 'default'), 'ubuntu-latest');
  });
});

// --- README.md documentation (AC6) ---
//
// Mirrors the local `section()` helper pattern used by test/readme.test.mjs
// (not imported from there, since that file does not export it), scoped to
// the "## `dokploy-deploy.yml`" heading.

const readme = readRepoFile('README.md');

/** Returns the text between a "## <heading>" line and the next "## " heading (or EOF). */
function section(markdown, headingSubstring) {
  const lines = markdown.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^##\s/.test(l) && l.includes(headingSubstring));
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n');
}

const dokploySection = section(readme, 'dokploy-deploy.yml');
const dokploySectionFlat = dokploySection ? dokploySection.replace(/\s+/g, ' ') : null;

describe('README.md "dokploy-deploy.yml" section documents the new secrets (AC6)', () => {
  test('section exists', () => {
    assert.ok(dokploySection, 'expected a "## `dokploy-deploy.yml`" section in README.md');
  });

  test('documents both new secret names', () => {
    assert.ok(dokploySection);
    assert.match(dokploySection, /`cf-access-client-id`/, 'expected cf-access-client-id to be documented');
    assert.match(dokploySection, /`cf-access-client-secret`/, 'expected cf-access-client-secret to be documented');
  });

  test('explains the purpose: Cloudflare Access service-token auth for the deploy webhook', () => {
    assert.ok(dokploySectionFlat);
    assert.match(dokploySectionFlat, /cloudflare access/i, 'expected a mention of Cloudflare Access');
    assert.match(
      dokploySectionFlat,
      /service token|service-token/i,
      'expected a mention of the Cloudflare Access service-token mechanism',
    );
    assert.match(
      dokploySectionFlat,
      /webhook/i,
      'expected the explanation to tie the secrets to the deploy webhook call',
    );
  });

  test('states the change is additive and backward compatible', () => {
    assert.ok(dokploySectionFlat);
    assert.match(
      dokploySectionFlat,
      /additive|backward[- ]compatible|optional/i,
      'expected the section to call out that the new secrets are additive/optional/backward-compatible',
    );
  });

  test('states the secrets currently have no effect, since no Access application exists yet for this path', () => {
    assert.ok(dokploySectionFlat);
    assert.match(
      dokploySectionFlat,
      /no effect|do(es)? not (yet )?(do|have|change) anything|not (yet )?(in use|active|enforced)/i,
      'expected a statement that the secrets have no effect today',
    );
    assert.match(
      dokploySectionFlat,
      /no (cloudflare )?access application|not (yet )?(configured|set up|created)/i,
      'expected a statement that no Access application exists yet for this path',
    );
  });
});
