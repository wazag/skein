import { describe, expect, it } from "vitest";
import { solveMinimumUpgrades } from "../src/solve";
import type { ProviderFacts } from "../src/facts";

const emptyFacts: ProviderFacts = { endpoints: [], envVars: [], queueNames: [], files: [] };
const factsWithTag: Record<string, ProviderFacts> = {
  "api-a@a1": { ...emptyFacts, endpoints: ["/v1/orders"] },
  "api-a@a2": { ...emptyFacts, endpoints: ["/v1/orders", "/v2/orders"] },
  "api-a@a3": { ...emptyFacts, endpoints: ["/v1/orders", "/v2/orders", "/v3/orders"] },
};

const baseInput = {
  deployedPins: { "api-a": "a1", "api-b": "b3" },
  factsAtTag: (service: string, tag: string) => Promise.resolve(factsWithTag[`${service}@${tag}`] ?? emptyFacts),
  tagsAscending: (service: string, current: string) =>
    Promise.resolve(service === "api-a" ? ["a1", "a2", "a3"].slice(["a1", "a2", "a3"].indexOf(current)) : [current]),
  valuesFilesText: ["replicas: 2\n"],
};

describe("solveMinimumUpgrades", () => {
  it("passes when deployed provider already serves the requirement", async () => {
    const result = await solveMinimumUpgrades({
      ...baseInput,
      requirements: [{ service: "api-b", kind: "endpoint", detail: "/v1/orders", citation: { file: "c.ts", line: 1 } }],
    });
    expect(result.verdict).toBe("pass");
    expect(result.requiredBumps).toEqual([]);
  });

  it("recommends the smallest sufficient provider tag", async () => {
    const result = await solveMinimumUpgrades({
      ...baseInput,
      requirements: [{ service: "api-b", kind: "endpoint", detail: "/v2/orders", citation: { file: "c.ts", line: 2 } }],
    });
    expect(result.verdict).toBe("pass");
    expect(result.requiredBumps).toEqual([
      { service: "api-a", from: "a1", to: "a2", reason: "serves /v2/orders (needed by api-b — c.ts:2)" },
    ]);
  });

  it("fails with unmet requirement when no tag serves it", async () => {
    const result = await solveMinimumUpgrades({
      ...baseInput,
      requirements: [{ service: "api-b", kind: "endpoint", detail: "/v9/ghost", citation: { file: "c.ts", line: 9 } }],
    });
    expect(result.verdict).toBe("fail");
    expect(result.unmet[0]?.detail).toBe("/v9/ghost");
  });

  it("reports missing env vars not present in any values file", async () => {
    const result = await solveMinimumUpgrades({
      ...baseInput,
      valuesFilesText: ["existing: YES\n"],
      requirements: [{ service: "api-b", kind: "env", detail: "ORDERS_V2_URL", citation: { file: "c.ts", line: 3 } }],
    });
    expect(result.missingEnv).toEqual([
      { env: "ORDERS_V2_URL", consumer: "api-b", citation: { file: "c.ts", line: 3 } },
    ]);
    expect(result.verdict).toBe("fail");
  });
});
