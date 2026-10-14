// Structural tests for the README.md updates described in card ACT-1,
// point 6 / acceptance criterion 9, and card ACT-4 (the branch-protection
// warning for the `quality` / `quality-postgres` job split).
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

// --- ACT-4: branch-protection gotcha for `quality` vs `quality-postgres` ---
//
// Both node-quality.yml and go-quality.yml split their single logical job
// into two mutually exclusive jobs, `quality` and `quality-postgres`,
// selected by an `if:` on `postgres-image`. GitHub Actions reports the job
// whose `if` evaluates false as "skipped", and GitHub branch protection
// treats a skipped *required* status check as passing. A caller repo that
// only requires the `quality` check therefore silently loses that
// protection the moment someone fills in `postgres-image`, because the real
// work then runs under `quality-postgres` while `quality` stays
// permanently skipped-therefore-green. README.md must carry an explicit
// warning about this, and the two "Nothing else changes" sentences (which
// currently read as an unconditional promise) must point at it.

/**
 * Returns the text from the first heading (any level, "#" to "######")
 * containing `startSubstring`, up to (not including) the next heading
 * containing `endSubstring`, or EOF if that one is never found. Returns
 * `null` if the start heading itself is not found.
 *
 * Unlike `section()` (which only matches "## " headings and is used above
 * for the top-level workflow sections), this also matches "### " headings,
 * because the warning this card asks for may land either as prose inside
 * "### Two jobs, one set of steps" or as a brand-new subsection directly
 * after it — both placements must be picked up without assuming which
 * heading text was chosen.
 */
function textBetweenHeadings(markdown, startSubstring, endSubstring) {
  const allLines = markdown.split(/\r?\n/);
  const isHeading = (l) => /^#{1,6}\s/.test(l);
  const startIdx = allLines.findIndex((l) => isHeading(l) && l.includes(startSubstring));
  if (startIdx === -1) return null;
  let endIdx = allLines.length;
  for (let i = startIdx + 1; i < allLines.length; i++) {
    if (isHeading(allLines[i]) && allLines[i].includes(endSubstring)) {
      endIdx = i;
      break;
    }
  }
  return allLines.slice(startIdx, endIdx).join('\n');
}

/**
 * Returns a window of `length` characters starting at the first occurrence
 * of `needle` in `text` (which should already have whitespace flattened to
 * single spaces), or `null` if `needle` is not found. Used to check that a
 * caveat was added *near* a specific sentence, without assuming exactly how
 * close ("same sentence" vs. "sentence right after") the fix places it.
 */
function windowAfter(text, needle, length = 450) {
  const idx = text.indexOf(needle);
  if (idx === -1) return null;
  return text.slice(idx, idx + length);
}

const nodeSection = section(readme, 'node-quality.yml');
const nodeSectionFlat = nodeSection ? nodeSection.replace(/\s+/g, ' ') : null;

// The warning may be prose inside "### Two jobs, one set of steps" or a new
// subsection directly after it; either way it must appear before the next
// existing heading ("### Private registries").
const branchProtectionRegion = textBetweenHeadings(readme, 'Two jobs, one set of steps', 'Private registries');
const branchProtectionRegionFlat = branchProtectionRegion ? branchProtectionRegion.replace(/\s+/g, ' ') : null;

describe('README.md branch-protection warning for `quality` vs `quality-postgres` (ACT-4)', () => {
  test('a warning region exists between "Two jobs, one set of steps" and "Private registries"', () => {
    assert.ok(
      branchProtectionRegion,
      'expected the "### Two jobs, one set of steps" heading to exist, with a warning either inside it or in a new subsection directly after it',
    );
  });

  test('states that `quality` and `quality-postgres` are mutually exclusive via their `if:` condition', () => {
    assert.ok(branchProtectionRegionFlat, 'expected the warning region to exist');
    assert.match(branchProtectionRegionFlat, /`quality`/, 'expected the job name `quality` to be named');
    assert.match(
      branchProtectionRegionFlat,
      /`quality-postgres`/,
      'expected the job name `quality-postgres` to be named',
    );
    assert.match(
      branchProtectionRegionFlat,
      /mutually exclusive|only one of (the )?(two )?jobs (ever )?runs|never (both )?run (at the same time|together)|exactly one (of (the )?(two|them))? runs/i,
      'expected an explicit statement that quality and quality-postgres cannot both run',
    );
    assert.match(
      branchProtectionRegionFlat,
      /\bif\b/,
      'expected the mutual exclusivity to be tied to the `if:` condition',
    );
  });

  test('states that the job whose `if` is false is reported as "skipped"', () => {
    assert.ok(branchProtectionRegionFlat, 'expected the warning region to exist');
    assert.match(
      branchProtectionRegionFlat,
      /skipped/i,
      'expected the word "skipped" describing the non-matching job',
    );
  });

  test('states that branch protection counts a skipped required status check as passing', () => {
    assert.ok(branchProtectionRegionFlat, 'expected the warning region to exist');
    assert.match(
      branchProtectionRegionFlat,
      /required status check|branch protection/i,
      'expected a reference to required status checks / branch protection',
    );
    assert.match(
      branchProtectionRegionFlat,
      /(skipped[^.]{0,100}(as )?(pass|passing|a pass|green|success)|treats? (a |the )?skipped[^.]{0,100}as (passing|a pass|success))/i,
      'expected an explicit statement that a skipped required check is treated as passing (not as "no check ran")',
    );
  });

  test('names the concrete scenario: requiring `quality` and later filling in postgres-image silently drops enforcement', () => {
    assert.ok(branchProtectionRegionFlat, 'expected the warning region to exist');
    assert.match(
      branchProtectionRegionFlat,
      /postgres-image/,
      'expected the scenario to mention the postgres-image input',
    );
    assert.match(
      branchProtectionRegionFlat,
      /silently|without warning|unnoticed|without (anyone )?notic/i,
      'expected the silent/unnoticed nature of the regression to be called out',
    );
    assert.match(
      branchProtectionRegionFlat,
      /(lose|loses|losing|lost|drop|drops|dropping)[^.]{0,150}(protection|enforcement|required (status )?check)/i,
      'expected a statement that the caller repo loses protection/enforcement',
    );
    assert.match(
      branchProtectionRegionFlat,
      /permanently skipped|always skipped|skipped[^.]{0,60}(forever|permanently|every (time|run))/i,
      'expected a statement that `quality` becomes permanently (skipped and therefore green) once postgres-image is set',
    );
  });

  test('gives the concrete advice: require BOTH `quality` and `quality-postgres` as required status checks', () => {
    assert.ok(branchProtectionRegionFlat, 'expected the warning region to exist');
    assert.match(branchProtectionRegionFlat, /\bboth\b/i, 'expected the advice to say "both" checks are required');
    assert.match(branchProtectionRegionFlat, /`quality`/);
    assert.match(branchProtectionRegionFlat, /`quality-postgres`/);
    assert.match(
      branchProtectionRegionFlat,
      /required status check|branch protection/i,
      'expected the advice to reference branch protection / required status checks',
    );
    assert.match(
      branchProtectionRegionFlat,
      /toggl(e|ing)|regardless of|either way|whether or not/i,
      'expected the advice to explain this makes enforcement independent of whether postgres-image is set',
    );
  });
});

describe('README.md "Nothing else changes" sentences get a branch-protection caveat (ACT-4)', () => {
  test('the node-quality.yml "Tests against a real Postgres" sentence points at the warning', () => {
    assert.ok(nodeSectionFlat, 'expected a "## `node-quality.yml`" section in README.md');
    const window = windowAfter(nodeSectionFlat, 'Nothing else changes');
    assert.ok(
      window,
      'expected to find the "Nothing else changes" sentence in the node-quality.yml "Tests against a real Postgres" subsection',
    );
    assert.match(
      window,
      /except|however|but\b|see (the )?(warning|caveat|note)|branch protection|required status check|status check/i,
      'expected a caveat near the "Nothing else changes" sentence, pointing at the branch-protection warning, since the sentence is no longer an unconditional promise',
    );
  });

  test('the go-quality.yml "Tests against a real Postgres" sentence points at the warning', () => {
    assert.ok(goSectionFlat, 'expected a "## `go-quality.yml`" section in README.md');
    const window = windowAfter(goSectionFlat, 'Nothing else changes');
    assert.ok(
      window,
      'expected to find the "Nothing else changes" sentence in the go-quality.yml "Tests against a real Postgres" subsection',
    );
    assert.match(
      window,
      /except|however|but\b|see (the )?(warning|caveat|note)|branch protection|required status check|status check/i,
      'expected a caveat near the "Nothing else changes" sentence, pointing at the branch-protection warning, since the sentence is no longer an unconditional promise',
    );
  });
});
