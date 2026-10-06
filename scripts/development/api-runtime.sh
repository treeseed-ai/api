#!/usr/bin/env bash
set -euo pipefail

compose=(docker compose --file compose.development.yml --project-name treeseed-api-development)

case "${1:-}" in
	cleanup)
		if [[ "${TREESEED_DEVELOPMENT_CLEANUP_SCOPE:-runtime}" == "session" ]]; then
			"${compose[@]}" down --remove-orphans
		else
			"${compose[@]}" stop --timeout 30 api-live
			"${compose[@]}" rm --force api-live
		fi
		;;
	*)
		echo "usage: $0 cleanup" >&2
		exit 2
		;;
esac
