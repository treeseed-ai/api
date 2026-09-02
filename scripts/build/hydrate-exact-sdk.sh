#!/usr/bin/env bash
set -euo pipefail

archive_root="${1:?archive root is required}"
mode="${2:-install}"
sdk_sha="$(node -e "const spec=require('./package.json').dependencies['@treeseed/sdk']; const match=spec.match(/#([0-9a-f]{40})$/); process.stdout.write(match?.[1] ?? '');")"

if [[ -z "${sdk_sha}" ]]; then
  [[ "${mode}" == "install" ]] || exit 0
  expected="$(node -p "require('./package.json').dependencies['@treeseed/sdk']")"
  actual="$(node -p "require('./node_modules/@treeseed/sdk/package.json').version")"
  [[ "${actual}" == "${expected}" ]]
  exit 0
fi

mkdir -p "${archive_root}"
sdk_archive="$(find "${archive_root}" -name '*.tgz' -type f -print -quit 2>/dev/null || true)"
if [[ -z "${sdk_archive}" ]]; then
  [[ "${mode}" == "download" ]]
  artifact_name="sdk-${sdk_sha}"
  run_id=""
  for attempt in {1..120}; do
    mapfile -t candidates < <(gh api "repos/treeseed-ai/sdk/actions/artifacts?name=${artifact_name}&per_page=100" --jq ".artifacts[] | select(.expired == false and .workflow_run.head_sha == \"${sdk_sha}\") | .workflow_run.id")
    for candidate in "${candidates[@]}"; do
      state="$(gh run view "${candidate}" --repo treeseed-ai/sdk --json headSha,status,conclusion --jq '[.headSha,.status,.conclusion]|join(" ")')"
      if [[ "${state}" == "${sdk_sha} completed success" ]]; then run_id="${candidate}"; break; fi
    done
    [[ -n "${run_id}" ]] && break
    sleep 10
  done
  [[ -n "${run_id}" ]]
  gh run download "${run_id}" --repo treeseed-ai/sdk --name "${artifact_name}" --dir "${archive_root}"
  sdk_archive="$(find "${archive_root}" -name '*.tgz' -type f -print -quit)"
fi

[[ "${mode}" == "download" ]] && exit 0
[[ "${mode}" == "install" ]]
for target in node_modules/@treeseed/sdk node_modules/@treeseed/deployment/node_modules/@treeseed/sdk; do
  if [[ "${target}" == node_modules/@treeseed/sdk || -d "${target}" ]]; then
    # npm ci has already materialized the exact transitive dependency tree from
    # package-lock.json. Replace only the SDK package payload; deleting its
    # node_modules directory makes Node fall through to incompatible top-level
    # dependencies and also invalidates release SBOM generation.
    find "${target}" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf -- {} +
    mkdir -p "${target}"
    tar -xzf "${sdk_archive}" --strip-components=1 -C "${target}"
    test -d "${target}/dist"
  fi
done
npm ls --all --omit=dev >/dev/null
