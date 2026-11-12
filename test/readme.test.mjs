// Structural tests for the README.md updates described in card ACT-1,
// point 6 / acceptance criterion 9, and for the single quality job.
//
// Run with: node --test test/readme.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoFile } from './helpers.mjs';

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

const goSection = section(readme, 'go-quality.yml');
// Prose in README.md is hand-wrapped at ~80 columns, so a phrase like
// "two modules" can legitimately be split across a line break. Flatten
// whitespace for any multi-word, free-text match so a reflow doesn't
// produce a false failure; heading checks stay anchored to real lines.
const goSectionFlat = goSection ? goSection.replace(/\s+/g, ' ') : null;

describe('README.md "go-quality.yml" section', () => {
  test('section exists', () => {
    assert.ok(goSection, 'expected a "## `go-quality.yml`" section in README.md');
  });

  test('inputs table lists the five new inputs', () => {
    assert.ok(goSection);
    for (const name of ['postgres-image', 'postgres-db', 'postgres-user', 'postgres-password', 'pre-test-command']) {
      assert.match(
        goSection,
        new RegExp('`' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`'),
        `expected the inputs table to document \`${name}\``,
      );
    }
  });

  test('describes the test step as "go test -race ./..." everywhere it is mentioned', () => {
    assert.ok(goSectionFlat);
    assert.match(goSectionFlat, /go test -race \.\/\.\.\./, 'expected the updated test command to be documented');
    // Catch a stale leftover description that was not updated.
    const staleBareGoTest = /(?<!-race )go test \.\/\.\.\./.exec(goSectionFlat);
    assert.equal(staleBareGoTest, null, `found an un-updated "go test ./..." mention: ${staleBareGoTest}`);
  });

  test('adds a Postgres example analogous to the Node one, with postgres-image and pre-test-command', () => {
    assert.ok(goSection);
    assert.match(
      goSection,
      /postgres/i,
      'expected a Postgres usage example in the go-quality.yml section',
    );
    assert.match(goSection, /postgres-image:/, 'expected an example snippet setting postgres-image');
    assert.match(goSection, /pre-test-command:/, 'expected an example snippet setting pre-test-command');
  });

  test('the example is a valid go-quality.yml "uses:" call', () => {
    assert.ok(goSection);
    assert.match(
      goSection,
      /uses:\s*ultimatelemon\/shared-actions\/\.github\/workflows\/go-quality\.yml@v2/,
      'expected the example to call go-quality.yml@v2',
    );
  });

  test('removes the now-inaccurate "No service containers" heading', () => {
    assert.ok(goSection);
    assert.doesNotMatch(
      goSection,
      /^###\s+No service containers\s*$/m,
      'go-quality.yml can now start a Postgres service, so this heading is no longer true and must be reworded',
    );
  });

  test('keeps the frameline rationale for its own job (two services, superuser migrations, two modules)', () => {
    assert.ok(goSectionFlat);
    assert.match(goSectionFlat, /frameline/i);
    assert.match(goSectionFlat, /superuser/i, 'expected the superuser-migrations reasoning to be preserved');
    // Both services (Postgres *and* Redis) and both modules should still be mentioned.
    assert.match(goSectionFlat, /redis/i, 'expected the "needs Postgres and Redis" reasoning to be preserved');
    assert.match(goSectionFlat, /two modules|two go modules/i, 'expected the "two modules in one job" reasoning to be preserved');
  });

  test('that section still has some heading explaining why frameline is the exception', () => {
    assert.ok(goSection);
    assert.match(
      goSection,
      /^###\s+.*frameline/im,
      'expected a heading that explains frameline keeps its own job, replacing "No service containers"',
    );
  });
});

// --- One quality job and its required check ---

/** Returns the text under a "### <heading>" line up to the next heading of any level. */
function subsection(markdown, heading) {
  const allLines = markdown.split(/\r?\n/);
  const startIdx = allLines.findIndex((l) => l === `### ${heading}`);
  if (startIdx === -1) return null;
  let endIdx = allLines.length;
  for (let i = startIdx + 1; i < allLines.length; i++) {
    if (/^#{1,6}\s/.test(allLines[i])) {
      endIdx = i;
      break;
    }
  }
  return allLines.slice(startIdx, endIdx).join(' ').replace(/\s+/g, ' ');
}

const nodeSection = section(readme, 'node-quality.yml');
const oneJob = subsection(readme, 'One job, one set of steps');
const branchProtection = subsection(readme, 'Branch protection');

describe('README.md: one quality job', () => {
  test('describes a single job that starts Postgres only for a non-empty image', () => {
    assert.ok(oneJob, 'expected a "### One job, one set of steps" subsection');
    assert.match(oneJob, /single job, `quality`/);
    assert.match(oneJob, /empty image/);
    assert.match(oneJob, /`wait for postgres`/);
  });

  test('the "One job" and "Branch protection" subsections sit in the node-quality.yml section', () => {
    assert.ok(nodeSection);
    assert.match(nodeSection, /^### One job, one set of steps$/m);
    assert.match(nodeSection, /^### Branch protection$/m);
  });

  test('tells callers to require only quality / quality and to drop quality-postgres', () => {
    assert.ok(branchProtection, 'expected a "### Branch protection" subsection');
    assert.match(branchProtection, /`quality \/ quality`/);
    assert.match(branchProtection, /Drop `quality-postgres`/);
    assert.doesNotMatch(branchProtection, /Require \*\*both\*\*/);
  });

  test('mentions quality-postgres only in the Branch protection subsection', () => {
    const count = (text) => (text.match(/quality-postgres/g) || []).length;
    assert.equal(count(readme), count(branchProtection ?? ''));
    assert.doesNotMatch(readme, /#branch-protection-and-the-toggle|#two-jobs-one-set-of-steps/);
  });

  test('every in-page link to these subsections resolves', () => {
    for (const anchor of ['#branch-protection', '#one-job-one-set-of-steps']) {
      assert.ok(readme.includes(`](${anchor})`), `expected a link to ${anchor}`);
    }
  });

  test('says the database URLs are only set with postgres-image', () => {
    const flat = readme.replace(/\s+/g, ' ');
    assert.match(flat, /Without `postgres-image` neither is set/);
  });
});
