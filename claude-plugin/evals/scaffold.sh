#!/usr/bin/env bash
# Prepares one eval case's working directory, which is the current directory
# when `claude plugin eval --scaffold` runs a case's scaffold_script.
#
#   scaffold.sh repo     a copy of fixture-repo/ as a git repo, with both failed runs
#   scaffold.sh denial   the same, keeping only the run whose agent step was denied a write
#   scaffold.sh budget   the same, keeping only the run that hit its spending cap
#   scaffold.sh none     no data repo at all
#   scaffold.sh nocli    the data repo, but no ./engine link: the skill has to find the CLI
#
# In every mode but nocli, ./engine is a copy of this checkout of the engine
# (its sources, docs and node_modules), so the case runs the CLI and the
# reference of the branch under test. A copy and not a link: the eval sandbox
# does not let a command read outside the working directory, and a link to
# the checkout made every CLI call fail. On APFS the copy is a clone, which
# takes a second and no space. It only writes inside the current directory.
set -euo pipefail

mode="${1:-repo}"
evals="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine="$(cd "$evals/../.." && pwd)"

if [ "$mode" != nocli ]; then
  mkdir engine
  for item in src docs package.json tsconfig.json node_modules; do
    cp -Rc "$engine/$item" engine/ 2>/dev/null || cp -R "$engine/$item" engine/
  done
fi
[ "$mode" = none ] && exit 0

cp -R "$evals/fixture-repo/." .
printf '.env\n.params.local.json\n.runs/\nengine\n' > .gitignore
case "$mode" in
  repo | nocli) ;;
  denial) rm -rf .runs/weekly-report/2026-10-26T07-00-00-000Z ;;
  budget) rm -rf .runs/weekly-report/2026-10-19T07-00-00-000Z ;;
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac
git init -q
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm "fixture data repo"
