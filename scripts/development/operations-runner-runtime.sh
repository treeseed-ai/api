#!/usr/bin/env bash
set -euo pipefail

candidate=(docker compose --file compose.development.yml --project-name treeseed-api-development)
released=treeseed-api-operations-runner-1

case "${1:-}" in
	takeover)
		if docker container inspect "${released}" >/dev/null 2>&1; then
			docker stop --time 60 "${released}" >/dev/null
		fi
		;;
	cleanup)
		"${candidate[@]}" stop --timeout 60 operations-runner-live >/dev/null 2>&1 || true
		"${candidate[@]}" rm --force operations-runner-live >/dev/null 2>&1 || true
		if [[ "${TREESEED_DEVELOPMENT_CLEANUP_SCOPE:-runtime}" == "session" ]] \
			&& docker container inspect "${released}" >/dev/null 2>&1; then
			docker start "${released}" >/dev/null
		fi
		;;
	*)
		echo "usage: $0 takeover|cleanup" >&2
		exit 2
		;;
esac
