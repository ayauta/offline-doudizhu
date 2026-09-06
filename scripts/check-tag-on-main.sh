#!/usr/bin/env bash
set -euo pipefail

commit_sha="${1:-${GITHUB_SHA:-}}"
tag_name="${2:-${GITHUB_REF_NAME:-}}"

if [[ -z "$commit_sha" || -z "$tag_name" ]]; then
  echo "Tag ancestry check requires a commit SHA and tag name." >&2
  exit 1
fi

if [[ "$(git rev-parse "${tag_name}^{commit}")" != "$commit_sha" ]]; then
  echo "Tag ${tag_name} does not resolve to ${commit_sha}." >&2
  exit 1
fi

git fetch --no-tags origin main
if ! git merge-base --is-ancestor "$commit_sha" refs/remotes/origin/main; then
  echo "Release commit ${commit_sha} is not contained in origin/main." >&2
  exit 1
fi

echo "Tag ${tag_name} points to protected main history."
