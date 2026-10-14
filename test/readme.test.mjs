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
 *
 * `length` has no default on purpose: callers must pick a value that is
 * wide enough to tolerate a reasonable reword but narrow enough to exclude
 * unrelated prose further down the section (see the callers below).
 */
function windowAfter(text, needle, length) {
  const idx = text.indexOf(needle);
  if (idx === -1) return null;
  return text.slice(idx, idx + length);
}

/**
 * Returns a single paragraph of `markdown` (a block of lines bounded by
 * blank lines), with internal whitespace flattened to single spaces, or
 * `null` if no paragraph contains `containingSubstring`. Throws if more
 * than one paragraph matches, since that means `containingSubstring` is no
 * longer unique enough to pin down a single paragraph (a silent wrong pick
 * is worse than a loud error here).
 *
 * This is deliberately much narrower than `textBetweenHeadings()`: the
 * branch-protection warning is three separate paragraphs (the
 * mutually-exclusive/skipped-as-passing explanation, the concrete
 * postgres-image scenario, and the "require both" advice), and several of
 * those paragraphs reuse the same words (e.g. "skipped-therefore-green",
 * "postgres-image", "`quality`" / "`quality-postgres`", "silently"). A test
 * scoped to the whole region can pass purely because of a *different*
 * paragraph than the one it claims to check. Scoping to one paragraph at a
 * time closes that gap: deleting or rewording the targeted sentence makes
 * only the test(s) anchored to that paragraph fail.
 */
function paragraph(markdown, containingSubstring) {
  const blocks = markdown
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const matches = blocks.filter((block) => block.includes(containingSubstring));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(`"${containingSubstring}" matched ${matches.length} paragraphs; expected exactly one`);
  }
  return matches[0].replace(/\s+/g, ' ').trim();
}

const nodeSection = section(readme, 'node-quality.yml');
const nodeSectionFlat = nodeSection ? nodeSection.replace(/\s+/g, ' ') : null;

// The warning may be prose inside "### Two jobs, one set of steps" or a new
// subsection directly after it; either way it must appear before the next
// existing heading ("### Private registries").
const branchProtectionRegion = textBetweenHeadings(readme, 'Two jobs, one set of steps', 'Private registries');

// The warning is three distinct paragraphs. Several of them reuse the same
// vocabulary (e.g. "skipped-therefore-green" appears in both the scenario
// and the advice paragraph, and "postgres-image" / the two job names appear
// in all three), so anchoring on the whole region would let a test pass for
// the wrong reason. Each constant below pins down exactly one paragraph by
// a phrase that is unique to it, so that deleting or rewording *that*
// paragraph is what breaks the corresponding test(s) -- not some other
// paragraph that happens to share a word.
const mutualExclusivityParagraph = branchProtectionRegion
  ? paragraph(branchProtectionRegion, 'mutually exclusive')
  : null;
const scenarioParagraph = branchProtectionRegion ? paragraph(branchProtectionRegion, 'silently loses') : null;
const adviceParagraph = branchProtectionRegion ? paragraph(branchProtectionRegion, 'Require **both**') : null;

describe('README.md branch-protection warning for `quality` vs `quality-postgres` (ACT-4)', () => {
  test('a warning region exists between "Two jobs, one set of steps" and "Private registries"', () => {
    assert.ok(
      branchProtectionRegion,
      'expected the "### Two jobs, one set of steps" heading to exist, with a warning either inside it or in a new subsection directly after it',
    );
  });

  test('the "Branch protection and the toggle" heading exists and its slug matches the anchor used by the caveat links', () => {
    // Renaming or removing this heading, without updating the
    // "#branch-protection-and-the-toggle" anchors the two "Nothing else
    // changes" caveats link to, would leave those links dangling. Deriving
    // the slug from the actual heading text (instead of hard-coding it)
    // means this test fails the moment heading and anchor drift apart.
    const headingLine = readme
      .split(/\r?\n/)
      .find((line) => /^###\s+/.test(line) && /branch protection/i.test(line));
    assert.ok(headingLine, 'expected a "### ..." heading mentioning "branch protection" in README.md');
    const headingText = headingLine.replace(/^###\s+/, '').trim();
    const slug = headingText
      .toLowerCase()
      .replace(/[`*_]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');
    assert.equal(
      slug,
      'branch-protection-and-the-toggle',
      `expected the heading's GitHub-generated slug to match the anchor used by the caveat links, got "#${slug}"`,
    );
  });

  test('states that `quality` and `quality-postgres` are mutually exclusive via their `if:` condition', () => {
    assert.ok(
      mutualExclusivityParagraph,
      'expected a paragraph containing "mutually exclusive" in the branch-protection warning',
    );
    assert.match(mutualExclusivityParagraph, /`quality`/, 'expected the job name `quality` to be named');
    assert.match(
      mutualExclusivityParagraph,
      /`quality-postgres`/,
      'expected the job name `quality-postgres` to be named',
    );
    assert.match(
      mutualExclusivityParagraph,
      /mutually exclusive|only one of (the )?(two )?jobs (ever )?runs|never (both )?run (at the same time|together)|exactly one (of (the )?(two|them))? runs/i,
      'expected an explicit statement that quality and quality-postgres cannot both run',
    );
    assert.match(
      mutualExclusivityParagraph,
      /`if:`/,
      'expected the mutual exclusivity to be tied to the literal `if:` condition',
    );
  });

  test('states that the job whose `if` is false is reported as "skipped"', () => {
    assert.ok(
      mutualExclusivityParagraph,
      'expected a paragraph containing "mutually exclusive" in the branch-protection warning',
    );
    // Not just "the word skipped appears somewhere" (the paragraph also
    // uses "skipped" in the branch-protection sentence) -- specifically
    // that GitHub *reports* the non-matching job *as* skipped.
    assert.match(
      mutualExclusivityParagraph,
      /report\w*[^.]{0,60}\bskipped\b|\bskipped\b[^.]{0,40}\bis\s+report/i,
      'expected a statement that GitHub Actions reports the non-matching job as "skipped"',
    );
  });

  test('states that branch protection counts a skipped required status check as passing', () => {
    assert.ok(
      mutualExclusivityParagraph,
      'expected a paragraph containing "mutually exclusive" in the branch-protection warning',
    );
    assert.match(
      mutualExclusivityParagraph,
      /required status check|branch protection/i,
      'expected a reference to required status checks / branch protection',
    );

    // "as passing/pass/success/green" and "as pending/failing" can both
    // legitimately appear in the same sentence (the real text says
    // "...treats a skipped check as passing, not as pending or failing" to
    // spell out what it is *not*). A plain substring/regex search over the
    // whole sentence can't tell that contrastive "not as pending" apart
    // from an inverted claim like "as pending, never as a pass" -- both
    // contain "passing" and "pending" somewhere. So: require an *unnegated*
    // "as passing"-type phrase (not immediately preceded by "not"/"never"),
    // and forbid any *unnegated* "as pending/failing"-type phrase.
    const unnegatedAsPassing = /(?<!\b(?:not|never)\s)\bas\s+(a\s+)?(passing|pass|success|green)\b/i;
    const unnegatedAsPendingOrFailing = /(?<!\b(?:not|never)\s)\bas\s+(a\s+)?(pending|failing|fail)\b/i;
    assert.match(
      mutualExclusivityParagraph,
      unnegatedAsPassing,
      'expected an explicit, unnegated statement that a skipped required check is treated as passing',
    );
    assert.doesNotMatch(
      mutualExclusivityParagraph,
      unnegatedAsPendingOrFailing,
      'the sentence must not make an unnegated claim that a skipped check is treated as pending/failing',
    );
  });

  test('names the concrete scenario: requiring `quality` and later filling in postgres-image silently drops enforcement', () => {
    assert.ok(scenarioParagraph, 'expected a paragraph containing "silently loses" in the branch-protection warning');
    assert.match(
      scenarioParagraph,
      /postgres-image/,
      'expected the scenario to mention the postgres-image input',
    );
    assert.match(
      scenarioParagraph,
      /silently|without warning|unnoticed|without (anyone )?notic/i,
      'expected the silent/unnoticed nature of the regression to be called out',
    );
    assert.match(
      scenarioParagraph,
      /(lose|loses|losing|lost|drop|drops|dropping)[^.]{0,150}(protection|enforcement|required (status )?check)/i,
      'expected a statement that the caller repo loses protection/enforcement',
    );
    assert.match(
      scenarioParagraph,
      /permanently skipped|always skipped|skipped[^.]{0,60}(forever|permanently|every (time|run))/i,
      'expected a statement that `quality` becomes permanently (skipped and therefore green) once postgres-image is set',
    );
  });

  test('gives the concrete advice: require BOTH `quality` and `quality-postgres` as required status checks', () => {
    assert.ok(
      adviceParagraph,
      'expected a paragraph containing the literal text "Require **both**" in the branch-protection warning',
    );
    assert.match(adviceParagraph, /\bboth\b/i, 'expected the advice to say "both" checks are required');
    assert.match(adviceParagraph, /`quality`/);
    assert.match(adviceParagraph, /`quality-postgres`/);
    assert.match(
      adviceParagraph,
      /required status check|branch protection/i,
      'expected the advice to reference branch protection / required status checks',
    );
    assert.match(
      adviceParagraph,
      /toggl(e|ing)|regardless of|either way|whether or not/i,
      'expected the advice to explain this makes enforcement independent of whether postgres-image is set',
    );
  });
});

describe('README.md "Nothing else changes" sentences get a branch-protection caveat (ACT-4)', () => {
  // The window is deliberately short: wide enough to tolerate a reasonable
  // reword of the ~190 characters between "Nothing else changes" and the
  // end of the "[Branch protection and the toggle](#branch-protection-and-
  // the-toggle)" link in both sentences, but far short of the next link or
  // heading in either section (over 1 kB further down), so it cannot be
  // satisfied by unrelated prose. A generic but/however/except alternation
  // over a wide window would be satisfied by any unrelated clause nearby;
  // AC4 specifically requires these sentences to carry the real markdown
  // link to the new warning, so the test checks for the literal link text
  // and its anchor instead.
  const CAVEAT_WINDOW = 300;

  test('the node-quality.yml "Tests against a real Postgres" sentence points at the warning', () => {
    assert.ok(nodeSectionFlat, 'expected a "## `node-quality.yml`" section in README.md');
    const window = windowAfter(nodeSectionFlat, 'Nothing else changes', CAVEAT_WINDOW);
    assert.ok(
      window,
      'expected to find the "Nothing else changes" sentence in the node-quality.yml "Tests against a real Postgres" subsection',
    );
    assert.match(
      window,
      /\[Branch protection and the toggle\]/i,
      'expected the "Nothing else changes" sentence to carry the actual link text to the branch-protection warning, not just a generic "but/however" clause',
    );
    assert.match(
      window,
      /#branch-protection-and-the-toggle/i,
      'expected the link to point at the "Branch protection and the toggle" anchor',
    );
  });

  test('the go-quality.yml "Tests against a real Postgres" sentence points at the warning', () => {
    assert.ok(goSectionFlat, 'expected a "## `go-quality.yml`" section in README.md');
    const window = windowAfter(goSectionFlat, 'Nothing else changes', CAVEAT_WINDOW);
    assert.ok(
      window,
      'expected to find the "Nothing else changes" sentence in the go-quality.yml "Tests against a real Postgres" subsection',
    );
    assert.match(
      window,
      /\[Branch protection and the toggle\]/i,
      'expected the "Nothing else changes" sentence to carry the actual link text to the branch-protection warning, not just a generic "but/however" clause',
    );
    assert.match(
      window,
      /#branch-protection-and-the-toggle/i,
      'expected the link to point at the "Branch protection and the toggle" anchor',
    );
  });
});
