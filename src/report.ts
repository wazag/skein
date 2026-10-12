import { REPORT_MARKER } from "./comment";
import type { Claim } from "./extract";
import type { BumpRecommendation, SolverResult } from "./solve";

const VERDICT_BANNERS = {
  pass: "## 🪿 Skein — ✅ PASS",
  fail: "## 🪿 Skein — ❌ FAIL",
} as const;
const NO_CHANGED_PINS_LINE = "- none";
const COST_DECIMALS = 3;

export type ReportInput = {
  verdict: "pass" | "fail";
  bumps: BumpRecommendation[];
  missingEnv: SolverResult["missingEnv"];
  dropped: Array<{ claim: Claim; reason: string }>;
  unmet: SolverResult["unmet"];
  basePins: Record<string, string>;
  headPins: Record<string, string>;
  repoUrlFor: (service: string) => string;
  costUsd: number;
  totalClaims: number;
  verifiedClaims: number;
};

type PinChange = { service: string; from: string; to: string };
type DroppedClaim = { claim: Claim; reason: string };

function changedPins(basePins: Record<string, string>, headPins: Record<string, string>): PinChange[] {
  const changes: PinChange[] = [];
  for (const [service, to] of Object.entries(headPins)) {
    const from = basePins[service];
    // First-time pins have no base ref, so there is nothing to compare against — skipped.
    if (from === undefined || from === to) continue;
    changes.push({ service, from, to });
  }
  return changes;
}

function changedPinLines(
  basePins: Record<string, string>,
  headPins: Record<string, string>,
  repoUrlFor: (service: string) => string,
): string[] {
  const changes = changedPins(basePins, headPins);
  if (changes.length === 0) return [NO_CHANGED_PINS_LINE];
  return changes.map(({ service, from, to }) => {
    const compareUrl = `${repoUrlFor(service)}/compare/${from}...${to}`;
    return `- ${service}: ${from} → ${to} ([compare](${compareUrl}))`;
  });
}

function markdownTable(headerCells: string[], rows: string[]): string[] {
  const header = `| ${headerCells.join(" | ")} |`;
  const separator = `|${headerCells.map(() => "---").join("|")}|`;
  return [header, separator, ...rows];
}

function bumpRows(bumps: BumpRecommendation[]): string[] {
  return markdownTable(
    ["bump", "why"],
    bumps.map((bump) => `| ${bump.service}: ${bump.from} → ${bump.to} | ${bump.reason} |`),
  );
}

function missingEnvRows(missingEnv: SolverResult["missingEnv"]): string[] {
  return markdownTable(
    ["var", "consumer", "citation"],
    missingEnv.map(
      (missing) => `| \`${missing.env}\` | ${missing.consumer} | ${missing.citation.file}:${missing.citation.line} |`,
    ),
  );
}

function unmetRows(unmet: SolverResult["unmet"]): string[] {
  return markdownTable(
    ["requirement", "consumer", "citation", "status"],
    unmet.map(
      (requirement) =>
        `| ${requirement.kind} \`${requirement.detail}\` | ${requirement.service} | ${requirement.citation.file}:${requirement.citation.line} | ${requirement.reason} |`,
    ),
  );
}

function droppedFlagLines(dropped: DroppedClaim[]): string[] {
  return dropped.map(
    ({ claim, reason }) =>
      `- ⚠️ claim ${claim.kind} \`${claim.detail}\` (${claim.citation.file}:${claim.citation.line}) dropped — ${reason}`,
  );
}

function confidenceLine(input: ReportInput): string {
  if (input.totalClaims === input.verifiedClaims) {
    return `${input.verifiedClaims}/${input.totalClaims} claims verified`;
  }
  const droppedCount = input.dropped.length;
  const plural = droppedCount === 1 ? "" : "s";
  return `⚠️ ${droppedCount} claim${plural} dropped, ${input.verifiedClaims}/${input.totalClaims} verified`;
}

// Pure renderer: no GitHub calls — the caller posts the markdown via upsertComment (Task 11 wiring).
// Bump and unmet reason strings come from the solver (formats pinned in src/solve.ts) and are
// rendered as opaque text, never re-parsed.
export function renderReport(input: ReportInput): string {
  return [
    REPORT_MARKER,
    VERDICT_BANNERS[input.verdict],
    "",
    "**Changed pins**",
    ...changedPinLines(input.basePins, input.headPins, input.repoUrlFor),
    "",
    ...(input.bumps.length > 0 ? ["**Required co-bumps**", "", ...bumpRows(input.bumps), ""] : []),
    ...(input.missingEnv.length > 0 ? ["**Missing env vars**", "", ...missingEnvRows(input.missingEnv), ""] : []),
    ...(input.unmet.length > 0 ? ["**Unsatisfiable requirements**", "", ...unmetRows(input.unmet), ""] : []),
    ...(input.dropped.length > 0 ? ["**Confidence flags**", "", ...droppedFlagLines(input.dropped), ""] : []),
    "---",
    `🪶 ${confidenceLine(input)} · 💰 $${input.costUsd.toFixed(COST_DECIMALS)} · model extraction, mechanical verification`,
  ].join("\n");
}
