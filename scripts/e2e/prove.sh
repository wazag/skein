#!/usr/bin/env bash
# Skein e2e orchestrator — the full proof: run the local harness (real pipeline,
# real LLM) and the kind reality layer, then assert the two agree:
#   new-endpoint scenario says "b5 requires a2"      <-> pr-pins-only breaks, skein-fix heals
#   missing-env scenario says "ORDERS_V2_URL absent" <-> b6 crashloops without it
# Exit 0 only when verdicts AND cluster truth line up.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/.e2e-output"
FAILURES=0

echo "==> [1/4] building fixture image"
docker build -q -t skein-fixture:latest "$SCRIPT_DIR" >/dev/null

echo "==> [2/4] local harness (real pipeline + real LLM)"
if ! (cd "$SCRIPT_DIR/../.." && npx tsx scripts/e2e/run-local.mts); then
  echo "PROOF FAILED: local harness scenarios did not match expectations"
  exit 1
fi

echo "==> [3/4] kind reality layer"
bash "$SCRIPT_DIR/kind-verify.sh"

echo "==> [4/4] cross-checking verdicts against cluster truth"
python3 - "$OUTPUT_DIR" << 'PYEOF'
import json, pathlib, sys

output_dir = pathlib.Path(sys.argv[1])
scenarios = {entry["scenario"]: entry for entry in json.loads((output_dir / "scenarios.json").read_text())}
truth = {}
for line in (output_dir / "cluster-truth.jsonl").read_text().splitlines():
    if line.strip():
        entry = json.loads(line)
        truth[entry["scenario"]] = entry

failures = []
if not scenarios.get("new-endpoint-requires-a2", {}).get("passed"):
    failures.append("verdict layer: new-endpoint scenario did not produce the a1->a2 recommendation")
if truth.get("pr-pins-only", {}).get("observed") != "not-ready":
    failures.append("cluster layer: pr-pins-only was unexpectedly healthy (gate would be lying)")
if truth.get("skein-fix", {}).get("observed") != "ready":
    failures.append("cluster layer: skein-fix did not heal (recommendation insufficient)")
if not scenarios.get("env-var-missing-fails", {}).get("passed"):
    failures.append("verdict layer: missing-env scenario did not report ORDERS_V2_URL")
if truth.get("missing-env", {}).get("observed") != "crashloop":
    failures.append("cluster layer: missing-env was unexpectedly running")

for problem in failures:
    print(f"MISMATCH: {problem}")
print("PROOF " + ("FAILED" if failures else "PASSED — Skein's verdicts match cluster reality"))
sys.exit(1 if failures else 0)
PYEOF
