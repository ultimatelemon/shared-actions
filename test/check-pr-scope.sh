#!/usr/bin/env bash
# Verifies acceptance criterion 10 of card ACT-1:
#   - the PR touches only go-quality.yml, the new go-checks composite
#     action, and README.md;
#   - the v1 tag has not been moved.
#
# This checks the *diff of an actual PR branch*, not a static property of
# a single file, so it cannot be a node:test case — there is nothing to
# assert until a feature branch with real commits exists. Run it from that
# branch, after committing the change, e.g.:
#
#   test/check-pr-scope.sh origin/main
#
# It exits non-zero and prints what is wrong on any violation, and exits 0
# with a short confirmation when the PR is in scope and v1 has not moved.

set -euo pipefail

BASE_REF="${1:-origin/main}"

allowed_files=(
  ".github/workflows/go-quality.yml"
  ".github/actions/go-checks/action.yml"
  "README.md"
)

# Anything under test/ is this card's own verification tooling, not part of
# the behavioural change itself (AC10 only constrains the latter).
is_allowed() {
  local file="$1"
  case "$file" in
    test/*) return 0 ;;
  esac
  for allowed in "${allowed_files[@]}"; do
    [ "$file" = "$allowed" ] && return 0
  done
  return 1
}

changed_files="$(git diff --name-only "${BASE_REF}...HEAD")"

if [ -z "${changed_files}" ]; then
  echo "No changes found between ${BASE_REF} and HEAD — nothing to verify yet." >&2
  exit 1
fi

status=0

while IFS= read -r file; do
  [ -n "$file" ] || continue
  if ! is_allowed "$file"; then
    echo "OUT OF SCOPE: $file (card ACT-1 only allows go-quality.yml, go-checks/action.yml, README.md and test/)" >&2
    status=1
  fi
done <<< "$changed_files"

echo "Changed files:"
echo "$changed_files" | sed 's/^/  /'

if git rev-parse -q --verify "refs/tags/v1" >/dev/null; then
  v1_sha="$(git rev-parse v1)"
  base_sha="$(git rev-parse "${BASE_REF}")"
  # v1 must still point at (an ancestor of) the base ref, i.e. it was not
  # fast-forwarded onto this change as part of this PR.
  if ! git merge-base --is-ancestor "$v1_sha" "$base_sha" 2>/dev/null && [ "$v1_sha" != "$base_sha" ]; then
    echo "v1 tag ($v1_sha) is not an ancestor of ${BASE_REF} ($base_sha) — it may have been moved by this change." >&2
    status=1
  else
    echo "v1 tag unchanged relative to ${BASE_REF}: ok"
  fi
else
  echo "No local v1 tag found to check; verify manually that it was not moved." >&2
fi

if [ "$status" -eq 0 ]; then
  echo "PR scope OK."
fi

exit "$status"
