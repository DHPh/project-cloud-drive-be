#!/usr/bin/env bash
set -euo pipefail

if [[ "${SSH_ORIGINAL_COMMAND:-}" =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  exec /usr/bin/sudo -n /opt/project-cloud-drive-be/release.sh "${BASH_REMATCH[1]}"
fi

echo 'Deployment key accepts only a deploy command with a 40-character commit SHA.' >&2
exit 2
