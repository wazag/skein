# Skein

Cross-repo deploy compatibility gate for Helm values repos.

Your values repo pins every service to a git tag. A PR bumps one pin. Skein diffs the
bumped service's repo old-tag→new-tag, extracts the new cross-repo requirements it
starts making (endpoints it calls, env vars it reads, task queues it consumes),
verifies every claim against the code, and reports the **minimal set of co-deploy
bumps** the rest of the system needs — pass/fail, with citations.

```yaml
      - uses: wazag/skein@v0.1.0
        with:
          github-token: ${{ secrets.SKEIN_GH_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## What a report looks like

Every run upserts a single comment on the PR (marker `<!-- skein-report:v1 -->`):

```markdown
<!-- skein-report:v1 -->
## 🪿 Skein — ❌ FAIL

**Changed pins**
- api: a1 → a2 ([compare](https://github.com/acme/svc-api/compare/a1...a2))
- worker: w1 → w2 ([compare](https://github.com/acme/svc-worker/compare/w1...w2))

**Required co-bumps**

| bump | why |
| --- | --- |
| orders: b3 → b5 | serves /v2/orders (needed by api — config/endpoints.json:3) |

**Missing env vars**

| var | consumer | citation |
| --- | --- | --- |
| `RENDER_BUCKET` | worker | src/worker.ts:4 |

---
🪶 2/2 claims verified · 💰 $0.014 · model extraction, mechanical verification
```

Verdict **fail** here because `RENDER_BUCKET` is nowhere in the values files. The
`orders` co-bump is a *fixable* finding — it appears even on passing runs, telling you
the minimal companion bump to ship together.

## Quickstart

In your **values repo** (the repo whose PRs bump service pins):

1. Add a `skein.yaml` at the root describing where each service's pin lives.

   ```yaml
   services:
     api:
       repo: acme/svc-api
       file: env/prod/values.yaml      # path within this values repo
       path: services.api.tag          # path within that file
     orders:
       repo: acme/svc-orders
       file: env/prod/values.yaml
       path: services.orders.tag
     worker:
       repo: acme/svc-worker
       file: env/prod/values.yaml
       path: deployments.worker[0].tag # dotted keys plus [n] list indexing
   ```

2. Add the workflow (`.github/workflows/skein.yml`):

   ```yaml
   name: skein
   on:
     pull_request:
       paths: [env/**, skein.yaml]  # don't burn LLM calls on README edits
   permissions:
     contents: read
     pull-requests: write           # the report comment
   jobs:
     skein:
       runs-on: ubuntu-latest
       steps:
         # fetch-depth: 0 is REQUIRED — Skein reads the PR base snapshot from this
         # checkout and refuses to guess when the base ref is missing (see
         # Troubleshooting). The default shallow clone makes every run fail fast.
         - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0
           with:
             fetch-depth: 0
         - uses: wazag/skein@v0.1.0
           with:
             github-token: ${{ secrets.SKEIN_GH_TOKEN }}        # PAT, see Authentication
             anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
   ```

3. Create the two repo secrets (`Settings → Secrets and variables → Actions`):
   - `SKEIN_GH_TOKEN` — a fine-grained PAT that can read the **service** repos
     (this is the GitHub Secrets recipe; Vault and AWS variants below)
   - `ANTHROPIC_API_KEY` — an Anthropic API key

Open a PR that bumps one pin in `env/prod/values.yaml`. Skein comments within a minute
or two, depending on diff size.

> The default `GITHUB_TOKEN` **cannot** be used here — see [Authentication](#authentication).

### skein.yaml reference

| key | meaning |
| --- | --- |
| `services.<name>.repo` | `owner/repo` of the service's source repo (read via your token) |
| `services.<name>.file` | values file path in the values repo, e.g. `env/prod/values.yaml` |
| `services.<name>.path` | dotted path to the pin inside that file, with `[n]` for list items: `deployments.worker[0].tag` |
| `services.<name>.hints` | accepted but inert in v1 (reserved, e.g. `hints: {type: temporal}`) |

Service names must match `[a-z][a-z0-9-]*`. The path must resolve to a scalar (string
or number) at **both** the PR base and head — a path that misses at head is a config
error (exit 1); a path that misses at base simply means a first-time pin.

## Authentication

Skein needs a GitHub credential that can **read the service repos** (it clones each
one, blobless) and **write PR comments on the values repo**. Two supported modes:

| | Fine-grained PAT (`github-token`) | GitHub App (`app-id` + `app-private-key`) |
| --- | --- | --- |
| Setup effort | one token, select repos | create App, install on the org, store key |
| Token lifetime | up to 1 year, manual rotation | 1-hour installation tokens, minted per run |
| Scope control | per-repo in token settings | per-repo at install time |
| Comments appear as | the token owner | the App's bot identity |
| Audit story | personal | org-owned, revocable per installation |
| Best for | getting started, single-team | org standard, least standing privilege |

Fine-grained PAT needs: **Contents: Read-only** on every service repo, and
**Pull requests: Read and write** on the values repo. A GitHub App needs the same two
permissions on the repos where it is installed.

> **The default `GITHUB_TOKEN` cannot read sibling repos.** It is scoped to the values
> repo alone, so every service-repo clone fails. This is not a Skein limitation — pass
> a PAT or a GitHub App via the recipes below. (The one exception is Skein's own
> [dogfood](#dogfood), whose only service repo is itself.)

## Secret recipes

Skein is **secret-source-agnostic**: it reads the `anthropic-api-key` input (or the
`ANTHROPIC_API_KEY` env var) and the `github-token` / `app-id` / `app-private-key`
inputs, and never fetches secrets itself. Any secret store works as a **preceding
workflow step that exports environment variables** into the Skein step:

### 1. GitHub Secrets (default)

The quickstart above is the full recipe: two repo secrets, referenced directly in
`with:`.

### 2. HashiCorp Vault

`.github/workflows/skein.yml` in full:

```yaml
name: skein
on:
  pull_request:
    paths: [env/**, skein.yaml]
permissions:
  contents: read
  pull-requests: write
jobs:
  skein:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0
        with:
          fetch-depth: 0
      - name: Read secrets from Vault
        uses: hashicorp/vault-action@4c06c5ccf5c0761b6029f56cfb1dcf5565918a3b # v3.4.0
        with:
          url: https://vault.example.com:8200
          method: token
          token: ${{ secrets.VAULT_TOKEN }}
          secrets: |
            secret/data/skein anthropic_api_key | ANTHROPIC_API_KEY ;
            secret/data/skein app_private_key | APP_PRIVATE_KEY
      - uses: wazag/skein@v0.1.0
        with:
          app-id: ${{ vars.SKEIN_APP_ID }}                # App ids are not secret: store as a variable
          app-private-key: ${{ env.APP_PRIVATE_KEY }}
          anthropic-api-key: ${{ env.ANTHROPIC_API_KEY }} # env var also read directly
```

`vault-action` exports each `path key | ENV_NAME` request as an environment variable
for the rest of the job (KV v2 paths are the full `secret/data/...` form). The
`ANTHROPIC_API_KEY` mapping is optional — Skein falls back to that env var on its own —
but `app-private-key` has no env fallback and must be mapped through `with:`.

### 3. AWS Secrets Manager

`.github/workflows/skein.yml` in full (secrets fetched over OIDC, no static AWS keys):

```yaml
name: skein
on:
  pull_request:
    paths: [env/**, skein.yaml]
permissions:
  id-token: write        # OIDC federation to AWS
  contents: read
  pull-requests: write
jobs:
  skein:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0
        with:
          fetch-depth: 0
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0
        with:
          role-to-assume: arn:aws:iam::123456789012:role/skein-secret-reader
          aws-region: us-east-1
      - name: Read secrets from AWS Secrets Manager
        uses: aws-actions/aws-secretsmanager-get-secrets@2297f9a879480a9e3af9b293ed15c70caf8e1c88 # v3.0.2
        with:
          secret-ids: |
            ANTHROPIC_API_KEY, prod/skein/anthropic-api-key
            APP_PRIVATE_KEY, prod/skein/app-private-key
      - uses: wazag/skein@v0.1.0
        with:
          app-id: ${{ vars.SKEIN_APP_ID }}
          app-private-key: ${{ env.APP_PRIVATE_KEY }}
          anthropic-api-key: ${{ env.ANTHROPIC_API_KEY }}
```

Each `secret-ids` line is `ENV_NAME, <secret-id>`; the step exports the retrieved
values under those names for the rest of the job. The IAM role only needs
`secretsmanager:GetSecretValue` on the two secret ARNs.

## Inputs

| input | default | meaning |
| --- | --- | --- |
| `mode` | `advisory` | `advisory` (comment only) or `enforcing` (exit 1 on unsafe) |
| `model` | `claude-sonnet-5` | Anthropic model id for claim extraction |
| `concurrency` | `4` | max parallel LLM calls (1–32, one per bumped repo) |
| `max-cost-usd` | `5.00` | hard abort when spend exceeds this (USD) |
| `config` | `skein.yaml` | path to the config, relative to values repo root |
| `github-token` | — | fine-grained PAT with read access to the service repos |
| `app-id` | — | GitHub App id (alternative to `github-token`) |
| `app-private-key` | — | GitHub App private key (pairs with `app-id`) |
| `anthropic-api-key` | — | Anthropic API key (falls back to `ANTHROPIC_API_KEY` env var) |

## Outputs

| output | shape |
| --- | --- |
| `verdict` | `pass` \| `fail` \| `error` |
| `required-bumps` | JSON array of `{service, from, to, reason}` |
| `missing-env` | JSON array of `{env, consumer, citation}` |
| `report` | full markdown report |
| `cost-usd` | actual spend this run |

## Exit semantics

`mode: advisory` never blocks a merge on the *verdict*; `mode: enforcing` does. Tool
**malfunctions always exit 1**, in both modes — a broken gate must never look green.

| situation | verdict output | exit (advisory) | exit (enforcing) |
| --- | --- | --- | --- |
| pins safe as-is, or co-bumps known and fixable | `pass` | 0 | 0 |
| missing env var, or requirement no provider tag can serve | `fail` | 0 | 1 |
| cost ceiling exceeded mid-run (partial report posted) | `error` | 0 | 1 |
| malfunction: bad config, missing tag, shallow checkout, LLM/API failure, no PR context | `error` | 1 | 1 |

## How verification works

1. **Pin read + bump detection.** Skein reads each values file from your checkout at
   the PR base and head SHAs and records every changed pin. Only changed pins are
   analyzed.
2. **Tag-to-tag diff.** Each bumped service's repo is cloned **blobless**
   (`--filter=blob:none` — only diff blobs are fetched, no compare-API truncation) and
   diffed old-tag→new-tag. A pinned tag that does not exist is a hard error.
3. **LLM extraction.** The diff (chunked at 1500 lines per call) goes to the Anthropic
   model with a schema-forced contract: every claim must carry a kind
   (`endpoint`/`env`/`queue`), a detail, and a `file:line` citation. Usage is costed
   per call against `max-cost-usd`.
4. **Citation verify (mechanical, always on).** Every claim's cited line must be an
   added line of the diff, or the cited line at the new tag must contain the claimed
   detail. Unverifiable claims are dropped and listed under **Confidence flags** in
   the report — they never influence the verdict.
5. **Deterministic fact harvest (no LLM).** For each candidate provider tag, Skein
   greps the code for served endpoints (multi-segment path literals), env-var reads,
   and task-queue names.
6. **Minimal-upgrade solver.** Requirements already served at the *deployed* (base)
   pins pass. Env vars must appear in the values files' text. The rest route to the
   first provider that has some tag serving them, and each provider is bumped to the
   **smallest single tag that serves all of its routed requirements** — one row per
   provider, reasons combined. Anything unsatisfiable becomes an **unmet** row and the
   verdict flips to `fail`.

### v1 limitations (honest list)

- **First-time pins contribute no requirements** — a service absent from the base
  snapshot has no old tag to diff against; it is skipped without a paid call.
- **No cross-provider search.** Requirements route to the first provider able to serve
  them; if no *single* tag of that provider covers all its routed requirements, they
  are reported unmet. v1 does not retry with the next provider.
- **No transitive (multi-hop) solving** — a co-bump's own new requirements are not
  re-solved. Planned for v2.
- **Values repo only (Mode A).** No early-warning runs on service-repo PRs (Mode B).
- **Deployed state = git pins.** Skein never talks to a cluster; there is no
  live-state verification.
- **Generic harvest, no per-framework route parsers.** Facts come from string-literal
  matching, and the harvest is direction-blind: a *caller's* own endpoint literal can
  register as a *served* endpoint. Sanity-check surprising co-bump rows.
- **No LLM retries.** A failed API call fails the run (exit 1 in both modes).

## Troubleshooting

**Every run fails with a "refuse to guess" error**, e.g.:

```
skein error: base ref 3f7a9c1… not present in the checkout — use fetch-depth: 0
(or fetch the base ref) in your workflow; refusing to guess
```

Your checkout step is shallow (the default `fetch-depth: 1`). Skein reads the PR base
snapshot — the pins the cluster *actually* runs — from your checkout; a shallow clone
does not contain the base ref, every base read would look like a first-time pin, and
the gate would silently PASS. Skein refuses. Fix:

```yaml
- uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0
  with:
    fetch-depth: 0
```

**Clone failures on every service repo** — `no GitHub credential supplied … The
default GITHUB_TOKEN cannot read sibling repos.` You passed no `github-token` and no
App pair, or the token cannot see the repos. See [Authentication](#authentication).

**`repo … has no tag 'x' — pin points nowhere; push the tag or fix skein.yaml/pins`** —
a values pin references a tag that does not exist in the service repo. Push the tag or
fix the pin.

**`skein: no pull_request context`** — Skein runs on `pull_request` (with a paths
filter), not `push`, `pull_request_target`, or `workflow_dispatch`.

**Cost abort** — `projected spend $… exceeded the cost ceiling (max-cost-usd $…)` —
raise `max-cost-usd`, narrow the `paths` filter, or shrink the diff. A partial report
with the spend so far is still posted.

## Dogfood

Skein gates its own PRs (`.github/workflows/dogfood.yml`): a self-referential
`skein.yaml` pins `wazag/skein` itself at the tag in `dogfood/values.yaml`. Any PR
touching the action surface boots the action end-to-end in real GitHub and upserts a
report comment (a no-bump run makes zero LLM calls); a PR bumping the self-pin runs
the full paid pipeline over this repo's own tag diff and needs the `ANTHROPIC_API_KEY`
repo secret. The workflow is complete but **dormant until the repository has a remote**
— it activates on the first push.

## Fixture rig (manual proof)

`scripts/bootstrap-fixtures.sh <org> [prefix]` creates three public fixture repos
(api `a1`/`a2`, orders `b3`/`b5`, worker `w1`/`w2` with a known-breaking env bump),
pushes the tagged history via `gh`, and prints the `skein.yaml` + values file to paste
into a values repo along with two demo PRs — one that surfaces a discovered co-bump
(pass) and one that trips the missing-env verdict (fail). No kind cluster is involved:
Skein reads git tags, never clusters.

## Development

```bash
npm ci
npm test            # vitest — golden pipeline tests, no network
npm run typecheck
npm run build       # esbuild → dist/index.js (committed; CI fails on stale dist)
```

Releasing: push a `v*` tag. `.github/workflows/release.yml` runs typecheck, tests,
build, a dist staleness check, and creates the GitHub release via `gh` — no
third-party release actions in the chain. `v0.1.0` is tagged locally and travels with
the first push.

## Marketplace

The action is Marketplace-ready (`action.yml` carries the name, description, and
branding). To publish once the repo is public and `v0.1.0` is released:

1. Ensure the repo is public and the `v0.1.0` tag + release exist (the release
   workflow creates the release).
2. Visit <https://github.com/marketplace/publish> and select the `skein` repository.
3. Confirm the listing details (name, description, branding come from `action.yml`);
   choose a category such as *Continuous integration*; publish as an action listing.
4. Optional: apply for GitHub's creator verification for the checkmark badge.

Users reference the action as `wazag/skein@v0.1.0` (tag) or the full commit SHA.

## License

[MIT](LICENSE) © 2026 Wassim
