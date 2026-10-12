// src/pipeline.ts — orchestration only. Every environment I/O (settings, config bytes, git
// remotes, LLM, PR comments) arrives via PipelineDeps. The values-repo reads and the temp
// workdir lifecycle (mkdtemp → clone → rm -rf in finally) are owned here: cloned workdirs
// carry the access token in .git/config, so cleanup is a security requirement.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkeinYaml, SkeinConfigError, type RunSettings, type ServiceEntry } from "./config";
import { detectBumps, extractPins, type PinSnapshot } from "./pins";
import { GitRepoError, valuesFileAtRef, type GitWorkdir } from "./git";
import { harvestFacts } from "./facts";
import { extractClaims, type AnthropicClient, type Claim } from "./extract";
import { CostCeilingExceeded, runCostTracker } from "./cost";
import { verifyClaims } from "./verify";
import {
  solveMinimumUpgrades,
  type BumpRecommendation,
  type Requirement,
  type SolverInput,
  type SolverResult,
} from "./solve";
import { renderReport } from "./report";
import { REPORT_MARKER, upsertComment, type CommentApi } from "./comment";

const ERROR_BANNER = "## 🪿 Skein — ⚠️ run failed";
const COST_ABORT_BANNER = "## 🪿 Skein — ⚠️ run aborted: cost ceiling";

export type PipelineDeps = {
  settings: RunSettings;
  gitToken: string;
  readConfigFile: () => Promise<string>;
  valuesDir: string;
  baseSha: string;
  headSha: string;
  prNumber: number;
  repoUrlFor: (repoSpec: string) => string;
  cloneFactory: (repoUrl: string, token: string, targetDir: string) => Promise<GitWorkdir>;
  anthropicFactory: () => AnthropicClient;
  commentApi: CommentApi;
};

// detail/bumps/missingEnv/costUsd are additive optional fields over the brief's shape: the
// merged action.yml declares required-bumps/missing-env/cost-usd outputs, and error paths
// need a message-safe detail for setFailed (message only — never the error object).
export type PipelineOutcome = {
  verdict: "pass" | "fail" | "error";
  exitCode: number;
  report: string;
  detail?: string;
  bumps?: BumpRecommendation[];
  missingEnv?: SolverResult["missingEnv"];
  costUsd?: number;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorReport(banner: string, message: string): string {
  return [REPORT_MARKER, banner, "", message, "", "---"].join("\n");
}

// The verdict/exit code is the contract; a failed comment post degrades to a note appended
// to the returned report instead of failing an otherwise-successful run.
async function postReport(deps: PipelineDeps, report: string): Promise<string> {
  try {
    await upsertComment(deps.commentApi, deps.prNumber, report);
    return report;
  } catch (error) {
    return `${report}\n\n⚠️ report comment could not be posted: ${messageOf(error)}`;
  }
}

async function errorOutcome(
  deps: PipelineDeps,
  banner: string,
  message: string,
  costAbort: boolean,
): Promise<PipelineOutcome> {
  const exitCode = costAbort && deps.settings.mode === "advisory" ? 0 : 1;
  return { verdict: "error", exitCode, report: await postReport(deps, errorReport(banner, message)), detail: message };
}

// Bounded promise pool: at most `limit` workers in flight, results in input order, and no
// worker starts once one has failed (the first error is rethrown after all runners settle,
// so a shared cost-tracker throw can never become an unhandled rejection).
async function runPool<TItem, TResult>(
  items: TItem[],
  limit: number,
  worker: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  let firstError: { error: unknown } | undefined;
  const claimNext = (): { index: number; item: TItem } | undefined => {
    if (firstError !== undefined || nextIndex >= items.length) return undefined;
    const index = nextIndex;
    nextIndex += 1;
    const item = items[index];
    return item === undefined ? undefined : { index, item };
  };
  const runner = async (): Promise<void> => {
    for (let claimed = claimNext(); claimed !== undefined; claimed = claimNext()) {
      try {
        results[claimed.index] = await worker(claimed.item);
      } catch (error) {
        if (firstError === undefined) firstError = { error };
        return;
      }
    }
  };
  const runnerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: runnerCount }, () => runner()));
  if (firstError !== undefined) throw firstError.error;
  return results;
}

type ValuesSnapshot = { pins: PinSnapshot; filesText: string[] };

// extractPins wants a synchronous reader, so the (async) values-repo reads are prefetched
// per unique file and bridged through a map. At the base ref a missing file or missing
// pinned path means a first-time pin, not a malfunction — the service is simply absent
// from the base snapshot; the head read enforces real config errors either way.
async function readValuesSnapshot(
  deps: PipelineDeps,
  serviceEntries: Record<string, ServiceEntry>,
  ref: string,
  allowMissing: boolean,
): Promise<ValuesSnapshot> {
  const contents = new Map<string, string>();
  const readable: Record<string, ServiceEntry> = {};
  for (const [service, entry] of Object.entries(serviceEntries)) {
    try {
      contents.set(entry.file, await valuesFileAtRef(deps.valuesDir, entry.file, ref));
    } catch (error) {
      if (!allowMissing || !(error instanceof GitRepoError || error instanceof SkeinConfigError)) throw error;
      continue;
    }
    readable[service] = entry;
  }
  const readFileAtRef = (file: string): string => {
    const content = contents.get(file);
    if (content === undefined) throw new SkeinConfigError(`values file '${file}' not readable at ${ref}`);
    return content;
  };
  return { pins: extractPins(readable, readFileAtRef, ref), filesText: [...contents.values()] };
}

type ServiceAnalysis = {
  service: string;
  verified: Claim[];
  dropped: Array<{ claim: Claim; reason: string }>;
};

export async function runPipeline(deps: PipelineDeps): Promise<PipelineOutcome> {
  const maxCostUsd = deps.settings.maxCostUsd;
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    return errorOutcome(deps, ERROR_BANNER, `max-cost-usd must be a positive finite number, got '${maxCostUsd}'`, false);
  }
  const tracker = runCostTracker(maxCostUsd);
  const tempDirs: string[] = [];
  try {
    const config = parseSkeinYaml(await deps.readConfigFile());
    const baseSnapshot = await readValuesSnapshot(deps, config.services, deps.baseSha, true);
    const headSnapshot = await readValuesSnapshot(deps, config.services, deps.headSha, false);
    const bumps = detectBumps(baseSnapshot.pins, headSnapshot.pins);

    // One blobless clone per unique service repo, shared by diffing, claim verification and
    // the solver's fact harvests. Each clone lands in a registered mkdtemp dir.
    const workdirByRepo = new Map<string, Promise<GitWorkdir>>();
    const workdirFor = async (repoSpec: string): Promise<GitWorkdir> => {
      const existing = workdirByRepo.get(repoSpec);
      if (existing !== undefined) return existing;
      const targetDir = mkdtempSync(join(tmpdir(), "skein-clone-"));
      tempDirs.push(targetDir);
      const clone = deps.cloneFactory(deps.repoUrlFor(repoSpec), deps.gitToken, targetDir);
      workdirByRepo.set(repoSpec, clone);
      return clone;
    };
    const entryFor = (service: string): ServiceEntry => {
      const entry = config.services[service];
      if (entry === undefined) throw new SkeinConfigError(`service '${service}' missing from skein.yaml`);
      return entry;
    };

    const analyses = await runPool(bumps, deps.settings.concurrency, async (bump): Promise<ServiceAnalysis> => {
      const workdir = await workdirFor(entryFor(bump.service).repo);
      const newlyPinned = baseSnapshot.pins[bump.service] === undefined;
      // Empty diff (identical trees, or a first-time pin with no base tag): skip the paid
      // call entirely — an empty diff must never trigger an LLM request.
      const diff = newlyPinned ? "" : await workdir.diffTags(bump.from, bump.to);
      if (diff.trim().length === 0) return { service: bump.service, verified: [], dropped: [] };
      const claims = await extractClaims(deps.settings.model, diff, bump.service, deps.anthropicFactory(), tracker);
      const { verified, dropped } = await verifyClaims(claims, diff, (file) =>
        workdir.readFile(bump.to, file).catch(() => undefined),
      );
      return { service: bump.service, verified, dropped };
    });

    const requirements: Requirement[] = analyses.flatMap((analysis) =>
      analysis.verified.map((claim) => ({
        service: analysis.service,
        kind: claim.kind,
        detail: claim.detail,
        citation: claim.citation,
      })),
    );

    // Stable single identities for the whole solve — solve.ts memoizes per function identity
    // and then per service@tag, so each provider tag is harvested exactly once per run.
    const factsAtTag: SolverInput["factsAtTag"] = async (service, tag) => {
      const workdir = await workdirFor(entryFor(service).repo);
      return harvestFacts((file) => workdir.readFile(tag, file), () => workdir.listFiles(tag));
    };
    const tagsAscending: SolverInput["tagsAscending"] = async (service, current) => {
      const workdir = await workdirFor(entryFor(service).repo);
      return workdir.listTagsAsc(current);
    };

    // Providers deploy at their pre-PR (base) pins — services this PR does not bump keep
    // running those tags — so satisfiability is judged against the base snapshot.
    const solverResult = await solveMinimumUpgrades({
      requirements,
      deployedPins: baseSnapshot.pins,
      factsAtTag,
      tagsAscending,
      valuesFilesText: headSnapshot.filesText,
    });

    const totalClaims = analyses.reduce(
      (sum, analysis) => sum + analysis.verified.length + analysis.dropped.length,
      0,
    );
    const verifiedClaims = analyses.reduce((sum, analysis) => sum + analysis.verified.length, 0);
    const report = renderReport({
      verdict: solverResult.verdict,
      bumps: solverResult.requiredBumps,
      missingEnv: solverResult.missingEnv,
      dropped: analyses.flatMap((analysis) => analysis.dropped),
      unmet: solverResult.unmet,
      basePins: baseSnapshot.pins,
      headPins: headSnapshot.pins,
      repoUrlFor: (service) => {
        const entry = config.services[service];
        return deps.repoUrlFor(entry === undefined ? service : entry.repo);
      },
      costUsd: tracker.spentUsd(),
      totalClaims,
      verifiedClaims,
    });
    return {
      verdict: solverResult.verdict,
      exitCode: solverResult.verdict === "pass" ? 0 : deps.settings.mode === "enforcing" ? 1 : 0,
      report: await postReport(deps, report),
      bumps: solverResult.requiredBumps,
      missingEnv: solverResult.missingEnv,
      costUsd: tracker.spentUsd(),
    };
  } catch (error) {
    if (error instanceof CostCeilingExceeded) {
      return errorOutcome(
        deps,
        COST_ABORT_BANNER,
        `projected spend $${error.spentUsd.toFixed(4)} exceeded the cost ceiling (max-cost-usd $${maxCostUsd}) — run aborted before further LLM calls`,
        true,
      );
    }
    // Malfunction: SkeinConfigError, raw YAMLParseError escaping skein.yaml parsing,
    // GitRepoError, LLM/API failures — anything. Always verdict "error", exit 1.
    return errorOutcome(deps, ERROR_BANNER, messageOf(error), false);
  } finally {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  }
}
