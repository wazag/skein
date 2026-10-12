#!/usr/bin/env bash
# Skein manual proof rig — creates three fixture service repos in a target org and
# pushes a tagged history that exercises the whole pipeline:
#
#   <prefix>-api      tags a1, a2   a2 starts calling /v2/orders (declared in
#                                  config/endpoints.json, NOT in a harvestable code
#                                  literal, so the requirement can only be served by
#                                  the orders service)
#   <prefix>-orders   tags b3, b5   b5 adds the /v2/orders route
#   <prefix>-worker   tags w1, w2   w2 reads RENDER_BUCKET — the known-breaking bump:
#                                  no values file in the demo provides it
#
# Then it prints the skein.yaml + values file to paste into a values repo, and the two
# demo PRs to raise against it. This is the manual rig only — Skein reads git tags,
# never clusters, so there is no kind/Kubernetes step anywhere.
#
# Usage: scripts/bootstrap-fixtures.sh <org> [prefix]     (prefix default: skein-fixture)
#
# Requires: gh (authenticated), git >= 2.28 (initial-branch flag). Fixture repos are
# created PUBLIC so any token can read them; delete them after the demo, or fork the
# script to --private.
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "usage: $0 <org> [prefix]   (prefix default: skein-fixture)" >&2
  exit 2
fi

org="$1"
prefix="${2:-skein-fixture}"

if ! [[ "$prefix" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "prefix must be lowercase letters/digits/dashes, got '$prefix'" >&2
  exit 2
fi

command -v gh >/dev/null || { echo "gh CLI not found — https://cli.github.com/" >&2; exit 1; }
gh auth status >/dev/null || { echo "gh not authenticated — run: gh auth login" >&2; exit 1; }
gh auth setup-git >/dev/null 2>&1 || true

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# Hermetic identity: fixture commits must not depend on the caller's git config.
readonly GIT_COMMIT=(git -c user.name="Skein fixture rig" -c user.email="skein-fixtures@localhost")

create_fixture_repo() {
  local repo_name="$1" description="$2"
  local full_name="${org}/${repo_name}"
  # gh prints the new repo URL to stdout when not attached to a TTY — inside this
  # function that stdout is captured by the caller's command substitution, so it
  # MUST be discarded here or the URL+newline ends up in the git remote URL and the
  # printed skein.yaml. The function's stdout contract is: exactly one line, the
  # full repo name.
  if ! gh repo create "$full_name" --public --description "$description" >/dev/null; then
    echo "could not create $full_name — delete it or pass a different prefix" >&2
    exit 1
  fi
  echo "$full_name"
}

# init_repo <dir> <full-name>: fresh repo with an authenticated remote, ready to commit.
init_repo() {
  git -C "$1" init --initial-branch=main >/dev/null
  git -C "$1" remote add origin "https://github.com/$2.git"
}

push_tagged() {
  local dir="$1" tag="$2" message="$3"
  "${GIT_COMMIT[@]}" -C "$dir" add -A
  "${GIT_COMMIT[@]}" -C "$dir" commit --quiet --message "$message"
  git -C "$dir" tag "$tag"
  git -C "$dir" push --quiet origin main --tags
}

echo "==> creating fixture repos in org '$org' (prefix '$prefix')"

# ---------------------------------------------------------------- api: a1, a2
api_dir="$workdir/api"
api_repo="$(create_fixture_repo "${prefix}-api" "Skein fixture: api consumer — /v1/orders then /v2/orders")"
mkdir -p "$api_dir/config" "$api_dir/src"
init_repo "$api_dir" "$api_repo"

cat >"$api_dir/config/endpoints.json" <<'EOF'
{
  "ordersV1": "/v1/orders"
}
EOF

cat >"$api_dir/src/client.ts" <<'EOF'
// Endpoint paths live in config/endpoints.json on purpose: the deterministic
// harvest only scans code files, so the *caller* never registers as *serving*
// the endpoint (the harvest is direction-blind — see README limitations).
import endpoints from "../config/endpoints.json";

export const ORDERS_BASE_URL = process.env.ORDERS_BASE_URL ?? "https://orders.internal";

export async function createOrder(payload: unknown): Promise<Response> {
  return fetch(`${ORDERS_BASE_URL}${endpoints.ordersV1}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
EOF

cat >"$api_dir/README.md" <<EOF
# fixture: api

Consumer service for the Skein demo rig (pushed by ${prefix} bootstrap).
- \`a1\` — calls \`/v1/orders\`
- \`a2\` — switches to \`/v2/orders\` (new outbound requirement)
EOF

push_tagged "$api_dir" a1 "api: call /v1/orders"

cat >"$api_dir/config/endpoints.json" <<'EOF'
{
  "ordersV1": "/v1/orders",
  "ordersV2": "/v2/orders"
}
EOF

cat >"$api_dir/src/client.ts" <<'EOF'
// Endpoint paths live in config/endpoints.json on purpose: the deterministic
// harvest only scans code files, so the *caller* never registers as *serving*
// the endpoint (the harvest is direction-blind — see README limitations).
import endpoints from "../config/endpoints.json";

export const ORDERS_BASE_URL = process.env.ORDERS_BASE_URL ?? "https://orders.internal";

export async function createOrder(payload: unknown): Promise<Response> {
  return fetch(`${ORDERS_BASE_URL}${endpoints.ordersV2}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
EOF

push_tagged "$api_dir" a2 "api: switch to /v2/orders"

# ------------------------------------------------------------ orders: b3, b5
orders_dir="$workdir/orders"
orders_repo="$(create_fixture_repo "${prefix}-orders" "Skein fixture: orders provider — /v1/orders, then /v2/orders at b5")"
mkdir -p "$orders_dir/src"
init_repo "$orders_dir" "$orders_repo"

cat >"$orders_dir/src/routes.ts" <<'EOF'
import type { Router } from "./router";

export function buildRoutes(router: Router): void {
  router.post("/v1/orders", createOrder);
  router.get("/v1/orders/:id", getOrder);
}
EOF

cat >"$orders_dir/README.md" <<EOF
# fixture: orders

Provider service for the Skein demo rig.
- \`b3\` — serves \`/v1/orders\` only
- \`b5\` — also serves \`/v2/orders\` (the co-deploy fix for api a2)
EOF

push_tagged "$orders_dir" b3 "orders: serve /v1/orders"

cat >"$orders_dir/src/routes.ts" <<'EOF'
import type { Router } from "./router";

export function buildRoutes(router: Router): void {
  router.post("/v1/orders", createOrder);
  router.get("/v1/orders/:id", getOrder);
  router.post("/v2/orders", createOrderV2);
}
EOF

push_tagged "$orders_dir" b5 "orders: serve /v2/orders"

# ------------------------------------------------------------ worker: w1, w2
worker_dir="$workdir/worker"
worker_repo="$(create_fixture_repo "${prefix}-worker" "Skein fixture: worker — w2 is the known-breaking bump (RENDER_BUCKET)")"
mkdir -p "$worker_dir/src"
init_repo "$worker_dir" "$worker_repo"

cat >"$worker_dir/src/worker.ts" <<'EOF'
export function runWorker(): void {
  const region = process.env.WORKER_REGION;
  poll(region);
}
EOF

cat >"$worker_dir/README.md" <<EOF
# fixture: worker

Worker service for the Skein demo rig.
- \`w1\` — reads \`WORKER_REGION\`
- \`w2\` — also reads \`RENDER_BUCKET\`: the KNOWN-BREAKING bump, because the demo
  values repo never sets it
EOF

push_tagged "$worker_dir" w1 "worker: read WORKER_REGION"

cat >"$worker_dir/src/worker.ts" <<'EOF'
export function runWorker(): void {
  const region = process.env.WORKER_REGION;
  const renderBucket = process.env.RENDER_BUCKET;
  poll(region, renderBucket);
}
EOF

push_tagged "$worker_dir" w2 "worker: read RENDER_BUCKET (breaking)"

echo
echo "==> fixture repos ready:"
echo "      $api_repo     tags: a1 a2"
echo "      $orders_repo  tags: b3 b5"
echo "      $worker_repo  tags: w1 w2   (w2 = known-breaking: RENDER_BUCKET)"
echo
echo "==> paste into your VALUES repo"
echo
echo "skein.yaml:"
cat <<EOF
services:
  api:
    repo: $api_repo
    file: env/prod/values.yaml
    path: services.api.tag
  orders:
    repo: $orders_repo
    file: env/prod/values.yaml
    path: services.orders.tag
  worker:
    repo: $worker_repo
    file: env/prod/values.yaml
    path: services.worker.tag
EOF
echo
echo "env/prod/values.yaml (starting state):"
cat <<'EOF'
services:
  api:
    tag: a1
    env:
      ORDERS_BASE_URL: https://orders.internal
  orders:
    tag: b3
  worker:
    tag: w1
    env:
      WORKER_REGION: eu-west-1
EOF
echo
echo "==> demo PRs to raise in the values repo (the README quickstart workflow gates them)"
echo
echo "1. THE DISCOVERED CO-BUMP (expected: verdict pass + one required co-bump row)"
echo "   PR edits env/prod/values.yaml:  api.tag: a1 -> a2"
echo "   Skein diffs api a1..a2, extracts 'calls /v2/orders', and reports:"
echo "     Required co-bumps: orders: b3 -> b5 — serves /v2/orders (needed by api)"
echo
echo "2. THE KNOWN-BREAKING BUMP (expected: verdict fail + missing env row)"
echo "   PR edits env/prod/values.yaml:  api.tag: a1 -> a2  AND  worker.tag: w1 -> w2"
echo "   Same co-bump row, plus:"
echo "     Missing env vars: RENDER_BUCKET (consumer worker, citation src/worker.ts:4)"
echo
echo "Notes:"
echo "- Extraction is live LLM work: claim wording and cited line numbers can vary"
echo "   slightly; the deterministic layers (harvest, solver, report) are what CI pins."
echo "- Public fixture repos mean any PAT/App token can read them; the values-repo"
echo "   default GITHUB_TOKEN still cannot — see README 'Authentication'."
echo "- No kind cluster is involved: Skein reads git tags, never clusters."
