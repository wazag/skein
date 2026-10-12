import type { ProviderFacts } from "./facts";
import type { Claim } from "./extract";

export type Requirement = { service: string; kind: Claim["kind"]; detail: string; citation: Claim["citation"] };
export type BumpRecommendation = { service: string; from: string; to: string; reason: string };
export type SolverResult = {
  verdict: "pass" | "fail";
  requiredBumps: BumpRecommendation[];
  missingEnv: Array<{ env: string; consumer: string; citation: Claim["citation"] }>;
  // Unmet requirements carry why they failed: routing failure or no-single-tag reduction failure.
  unmet: Array<Requirement & { reason: string }>;
};

export type SolverInput = {
  requirements: Requirement[];
  deployedPins: Record<string, string>;
  factsAtTag: (service: string, tag: string) => Promise<ProviderFacts>;
  tagsAscending: (service: string, current: string) => Promise<string[]>;
  valuesFilesText: string[];
};

// Pinned reason formats — the report (Task 9) renders these character-exact (em dash U+2014):
//   bump, one requirement:   `serves /v2/orders (needed by api-b — c.ts:2)`
//   bump, combined:          `serves <detail>, <detail> (needed by <consumer>, <consumer> — <file>:<line>, <file>:<line>)`
//                            lists are ", "-joined in requirement order, deduplicated;
//                            the one-requirement form is the exact degenerate case.
//   unmet, unroutable:       `no tag of any provider serves <detail>`
//   unmet, reduce failure:   `no single tag of <service> serves all routed requirements`

// Module-level memoization keyed by the injected function, then `${service}@${tag}` — repeated
// lookups (and repeated solves sharing one git-backed fetcher, Task 11) harvest a tag once.
// Keying by function identity keeps distinct injections (e.g. per-test fakes) from poisoning each other.
const factsAtTagCache = new WeakMap<SolverInput["factsAtTag"], Map<string, Promise<ProviderFacts>>>();
const tagsAscendingCache = new WeakMap<SolverInput["tagsAscending"], Map<string, Promise<string[]>>>();

function factsSatisfy(facts: ProviderFacts, requirement: Requirement): boolean {
  if (requirement.kind === "endpoint") return facts.endpoints.includes(requirement.detail);
  if (requirement.kind === "queue") return facts.queueNames.includes(requirement.detail);
  return false; // env handled separately against values text
}

async function factsAt(input: SolverInput, service: string, tag: string): Promise<ProviderFacts> {
  let byTag = factsAtTagCache.get(input.factsAtTag);
  if (byTag === undefined) {
    byTag = new Map();
    factsAtTagCache.set(input.factsAtTag, byTag);
  }
  const key = `${service}@${tag}`;
  let facts = byTag.get(key);
  if (facts === undefined) {
    facts = input.factsAtTag(service, tag);
    byTag.set(key, facts);
  }
  return facts;
}

async function tagsFrom(input: SolverInput, service: string, current: string): Promise<string[]> {
  let byCurrent = tagsAscendingCache.get(input.tagsAscending);
  if (byCurrent === undefined) {
    byCurrent = new Map();
    tagsAscendingCache.set(input.tagsAscending, byCurrent);
  }
  const key = `${service}@${current}`;
  let tags = byCurrent.get(key);
  if (tags === undefined) {
    tags = input.tagsAscending(service, current);
    byCurrent.set(key, tags);
  }
  return tags;
}

async function servedAtDeployedPins(input: SolverInput, requirement: Requirement): Promise<boolean> {
  for (const [service, tag] of Object.entries(input.deployedPins)) {
    if (factsSatisfy(await factsAt(input, service, tag), requirement)) return true;
  }
  return false;
}

async function canServeAtSomeTag(
  input: SolverInput,
  service: string,
  currentTag: string,
  requirement: Requirement,
): Promise<boolean> {
  for (const candidate of await tagsFrom(input, service, currentTag)) {
    if (candidate === currentTag) continue; // already checked and failed at the deployed pin
    if (factsSatisfy(await factsAt(input, service, candidate), requirement)) return true;
  }
  return false;
}

// Phase A routing: FIRST provider (deployedPins insertion order) able to serve it at some tag ≥ current.
async function firstProviderAbleToServe(input: SolverInput, requirement: Requirement): Promise<string | null> {
  for (const [service, currentTag] of Object.entries(input.deployedPins)) {
    if (await canServeAtSomeTag(input, service, currentTag, requirement)) return service;
  }
  return null;
}

// Phase B reduce: smallest tag ≥ current whose facts satisfy EVERY requirement routed to the provider.
async function smallestTagServingAll(
  input: SolverInput,
  service: string,
  currentTag: string,
  requirements: Requirement[],
): Promise<string | null> {
  for (const candidate of await tagsFrom(input, service, currentTag)) {
    if (candidate === currentTag) continue;
    const facts = await factsAt(input, service, candidate);
    if (requirements.every((requirement) => factsSatisfy(facts, requirement))) return candidate;
  }
  return null;
}

function bumpReason(requirements: Requirement[]): string {
  const details = [...new Set(requirements.map((requirement) => requirement.detail))];
  const consumers = [...new Set(requirements.map((requirement) => requirement.service))];
  const citations = [
    ...new Set(requirements.map((requirement) => `${requirement.citation.file}:${requirement.citation.line}`)),
  ];
  return `serves ${details.join(", ")} (needed by ${consumers.join(", ")} — ${citations.join(", ")})`;
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
  const unmet: SolverResult["unmet"] = [];
  const routed = new Map<string, Requirement[]>(); // insertion order = first-route order, deterministic

  // Phase A: satisfy against deployed pins / values text, else route to the first able provider.
  for (const requirement of input.requirements) {
    if (requirement.kind === "env") {
      const present = input.valuesFilesText.some((text) => text.includes(requirement.detail));
      if (present) continue;
      missingEnv.push({ env: requirement.detail, consumer: requirement.service, citation: requirement.citation });
      continue;
    }
    if (await servedAtDeployedPins(input, requirement)) continue;
    const provider = await firstProviderAbleToServe(input, requirement);
    if (provider === null) {
      unmet.push({ ...requirement, reason: `no tag of any provider serves ${requirement.detail}` });
      continue;
    }
    const bucket = routed.get(provider);
    if (bucket === undefined) routed.set(provider, [requirement]);
    else bucket.push(requirement);
  }

  // Phase B: one row per provider at the smallest tag serving all of its routed requirements —
  // never contradictory from-baselines; if no single tag serves them all, they all fail (v1: no re-routing).
  for (const [service, requirements] of routed) {
    const currentTag = input.deployedPins[service];
    if (currentTag === undefined) continue;
    const target = await smallestTagServingAll(input, service, currentTag, requirements);
    if (target === null) {
      const reason = `no single tag of ${service} serves all routed requirements`;
      for (const requirement of requirements) unmet.push({ ...requirement, reason });
      continue;
    }
    requiredBumps.push({ service, from: currentTag, to: target, reason: bumpReason(requirements) });
  }

  const verdict = unmet.length > 0 || missingEnv.length > 0 ? "fail" : "pass";
  return { verdict, requiredBumps: dedupeByServiceAndTo(requiredBumps), missingEnv, unmet };
}
