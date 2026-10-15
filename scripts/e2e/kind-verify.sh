#!/usr/bin/env bash
# Skein e2e reality layer — deploys the fixture services into a kind cluster in
# the exact combinations Skein verdicts describe, then asserts cluster truth:
#   Scenario "pr-pins-only"  : api-b@b5 + api-a@a1  -> api-b NOT ready (its /v2/orders calls 404)
#   Scenario "skein-fix"     : api-b@b5 + api-a@a2  -> api-b ready
#   Scenario "missing-env"   : api-b@b6 without ORDERS_V2_URL -> pod CrashLoops (exit 1 at boot)
# Output: scripts/e2e/.e2e-output/cluster-truth.json (consumed by prove.sh)
# Requires: kind, helm, kubectl, docker daemon, image skein-fixture:latest loaded.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/.e2e-output"
CLUSTER_NAME="skein-e2e"
NAMESPACE="skein-e2e"
IMAGE="skein-fixture:latest"
CHART="$SCRIPT_DIR/chart"

mkdir -p "$OUTPUT_DIR"
: > "$OUTPUT_DIR/cluster-truth.jsonl"

# Variant → behavior matrix (mirrors the git fixtures in run-local.ts)
serve_for() { case "$1" in a1) echo "/v1/orders";; a2) echo "/v1/orders,/v2/orders";; *) echo "";; esac; }
call_for()  { case "$1" in b3) echo "/v1/orders";; b5|b6) echo "/v1/orders,/v2/orders";; *) echo "";; esac; }

escape_commas() { printf '%s' "${1//,/\\,}"; }

deploy() { # deploy <release> <tag> <call-tag-or-""> [extra --set-string args...]
  local release="$1" tag="$2" call_tag="${3:-}"
  if [[ $# -ge 3 ]]; then shift 3; else shift "$#"; fi
  local args=(--namespace "$NAMESPACE" --set-string image="$IMAGE" --set-string "serve=$(escape_commas "$(serve_for "$tag")")")
  if [[ -n "$call_tag" ]]; then
    args+=(--set-string "call=$(escape_commas "$(call_for "$call_tag")")" --set-string upstream="http://api-a:8080")
  fi
  helm upgrade --install "$release" "$CHART" "${args[@]}" "$@" >/dev/null
}

record() { # record <scenario> <ready|not-ready|crashloop> <detail>
  printf '{"scenario":"%s","observed":"%s","detail":"%s"}\n' "$1" "$2" "$3" >> "$OUTPUT_DIR/cluster-truth.jsonl"
  echo "$1: $2 ($3)"
}

drain_fixtures() { # delete releases AND wait until not a single fixture pod remains
  helm uninstall -n "$NAMESPACE" --wait api-a api-b >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" delete pod -l rig=skein-e2e --wait=true --timeout=90s --force --grace-period=0 >/dev/null 2>&1 || true
}

wait_readiness() { # wait_readiness <release> <seconds> -> 0 if ready
  kubectl -n "$NAMESPACE" rollout status "deploy/$1" --timeout="${2}s" >/dev/null 2>&1
}

echo "==> kind: ensuring cluster $CLUSTER_NAME"
kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME" || kind create cluster --name "$CLUSTER_NAME" --wait 60s >/dev/null
kind load docker-image "$IMAGE" --name "$CLUSTER_NAME" >/dev/null

# Clean-room namespace every run: cross-run leftover deployments are the
# flake factory (terminating pods keep serving; kubectl-set-env RS churn).
kubectl delete namespace "$NAMESPACE" --wait=true --timeout=120s >/dev/null 2>&1 || true
kubectl create namespace "$NAMESPACE" >/dev/null

echo "==> scenario pr-pins-only: deploy b5 against a1 (the PR as written)"
drain_fixtures
deploy api-a a1
deploy api-b a1 b5
if wait_readiness api-b 40; then
  record pr-pins-only ready "UNEXPECTED: b5 healthy against a1"
else
  record pr-pins-only not-ready "b5 not ready against a1 — cluster confirms the co-bump requirement"
fi

echo "==> scenario skein-fix: upgrade a1 -> a2 (Skein's recommendation)"
deploy api-a a2
if wait_readiness api-b 40; then
  record skein-fix ready "b5 healthy against a2 — recommendation is sufficient"
else
  record skein-fix not-ready "UNEXPECTED: b5 still broken against a2"
fi

echo "==> scenario missing-env: deploy b6 which demands ORDERS_V2_URL (absent from values)"
drain_fixtures
deploy api-b a1 b6 --set-string requireEnvNames=ORDERS_V2_URL
crashloop_observed=false
for _ in $(seq 1 30); do
  if kubectl -n "$NAMESPACE" get pods -l app=api-b --no-headers 2>/dev/null | grep -q CrashLoopBackOff; then
    crashloop_observed=true
    break
  fi
  sleep 3
done
if [[ "$crashloop_observed" == true ]]; then
  record missing-env crashloop "b6 crashloops without ORDERS_V2_URL — cluster confirms the missing-env failure"
else
  record missing-env running "UNEXPECTED: b6 running without ORDERS_V2_URL"
fi

echo "==> done: $OUTPUT_DIR/cluster-truth.jsonl"
