// Structural tests for the README.md updates described in card ACT-1,
// point 6 / acceptance criterion 9.
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
      /uses:\s*ultimatelemon\/shared-actions\/\.github\/workflows\/go-quality\.yml@v1/,
      'expected the example to call go-quality.yml@v1',
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
