import type { ProviderFacts } from "./facts";
import type { Claim } from "./extract";

export type Requirement = { service: string; kind: Claim["kind"]; detail: string; citation: Claim["citation"] };
export type BumpRecommendation = { service: string; from: string; to: string; reason: string };
export type SolverResult = {
  verdict: "pass" | "fail";
  requiredBumps: BumpRecommendation[];
  missingEnv: Array<{ env: string; consumer: string; citation: Claim["citation"] }>;
  unmet: Requirement[];
};

export type SolverInput = {
  requirements: Requirement[];
  deployedPins: Record<string, string>;
  factsAtTag: (service: string, tag: string) => Promise<ProviderFacts>;
  tagsAscending: (service: string, current: string) => Promise<string[]>;
  valuesFilesText: string[];
};

function factsSatisfy(facts: ProviderFacts, requirement: Requirement): boolean {
  if (requirement.kind === "endpoint") return facts.endpoints.includes(requirement.detail);
  if (requirement.kind === "queue") return facts.queueNames.includes(requirement.detail);
  return false; // env handled separately against values text
}

function dedupeByServiceAndTo(bumps: BumpRecommendation[]): BumpRecommendation[] {
  const seen = new Map<string, BumpRecommendation>();
  for (const bump of bumps) {
    const key = `${bump.service}:${bump.to}`;
    if (!seen.has(key)) seen.set(key, bump);
  }
  return [...seen.values()];
}

export async function solveMinimumUpgrades(input: SolverInput): Promise<SolverResult> {
  const requiredBumps: BumpRecommendation[] = [];
  const missingEnv: SolverResult["missingEnv"] = [];
  const unmet: Requirement[] = [];

  for (const requirement of input.requirements) {
    if (requirement.kind === "env") {
      const present = input.valuesFilesText.some((text) => text.includes(requirement.detail));
      if (present) continue;
      missingEnv.push({ env: requirement.detail, consumer: requirement.service, citation: requirement.citation });
      continue;
    }
    // endpoint / queue: find which provider serves it — try every service's deployed facts
    let provider: string | null = null;
    for (const [service, tag] of Object.entries(input.deployedPins)) {
      if (factsSatisfy(await input.factsAtTag(service, tag), requirement)) {
        provider = service;
        break;
      }
    }
    if (provider) continue; // already served at deployed pins
    // hunt smallest sufficient tag across providers
    let resolved = false;
    for (const [service, currentTag] of Object.entries(input.deployedPins)) {
      const candidates = await input.tagsAscending(service, currentTag);
      for (const candidate of candidates) {
        if (candidate === currentTag) continue;
        if (factsSatisfy(await input.factsAtTag(service, candidate), requirement)) {
          requiredBumps.push({
            service,
            from: currentTag,
            to: candidate,
            reason: `serves ${requirement.detail} (needed by ${requirement.service} — ${requirement.citation.file}:${requirement.citation.line})`,
          });
          resolved = true;
          break;
        }
      }
      if (resolved) break;
    }
    if (!resolved) unmet.push(requirement);
  }

  const verdict = unmet.length > 0 || missingEnv.length > 0 ? "fail" : "pass";
  return { verdict, requiredBumps: dedupeByServiceAndTo(requiredBumps), missingEnv, unmet };
}
