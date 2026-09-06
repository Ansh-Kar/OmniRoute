#!/usr/bin/env bash
# Import the fork's parallel fusion combos into a running OmniRoute.
#
# Usage:
#   bash examples/fusion-parallel/import.sh [base-url] [api-key]
#
#   base-url  defaults to http://localhost:20128
#   api-key   defaults to $OMNIROUTE_API_KEY
#
# The combos use config.panelFromTags: their panels are resolved from the
# model tag index at dispatch time, so they track the catalog automatically.
# No judgeModel is set — the judge defaults to the first panel member; set
# your own via the dashboard if you prefer a specific synthesizer.
set -euo pipefail

BASE_URL="${1:-http://localhost:20128}"
API_KEY="${2:-${OMNIROUTE_API_KEY:-}}"

if [[ -z "$API_KEY" ]]; then
  echo "error: pass an API key as \$2 or set OMNIROUTE_API_KEY" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Importing parallel fusion combos into ${BASE_URL} ..."
node - "$BASE_URL" "$API_KEY" "$SCRIPT_DIR/combos.json" <<'EOF'
const [baseUrl, apiKey, combosPath] = process.argv.slice(2);
const combos = require("node:fs").readFileSync(combosPath, "utf8");
const parsed = JSON.parse(combos);
(async () => {
  let ok = 0;
  for (const combo of parsed) {
    const res = await fetch(`${baseUrl}/api/combos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(combo),
    });
    if (res.ok) {
      ok += 1;
      console.log(`  ✓ ${combo.name}`);
    } else {
      const body = await res.text();
      console.error(`  ✗ ${combo.name}: HTTP ${res.status} ${body.slice(0, 300)}`);
    }
  }
  console.log(`${ok}/${parsed.length} combos imported.`);
  process.exit(ok === parsed.length ? 0 : 1);
})();
EOF
