#!/bin/sh
# Stage the poisoned seed repository under OPENCODE_PROJECTS_ROOT as its own git repo, ready for an
# OpenCode-runner session. Re-running resets the project to its original (poisoned) state.
#
#   OPENCODE_PROJECTS_ROOT=~/.rewind/projects sh scripts/stage-demo.sh [seed-name]
set -e
seed="${1:-csv-stats-poisoned}"
root="${OPENCODE_PROJECTS_ROOT:-./projects}"
here="$(cd "$(dirname "$0")/.." && pwd)"
src="$here/seed_repos/$seed"
[ -d "$src" ] || { echo "no seed repository named $seed under seed_repos/" >&2; exit 1; }
mkdir -p "$root"
dest="$root/$seed"
rm -rf "$dest"
cp -R "$src" "$dest"
rm -rf "$dest/__pycache__" "$dest/.pytest_cache"
cd "$dest"
git init -q
git add -A
git -c user.name=demo -c user.email=demo@localhost commit -qm "base"
echo "staged $seed at $dest"
echo "start a session with runner=opencode and project_path=$seed"
