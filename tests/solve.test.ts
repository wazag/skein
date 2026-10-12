import { describe, expect, it } from "vitest";
import { solveMinimumUpgrades, type Requirement } from "../src/solve";
import type { ProviderFacts } from "../src/facts";

const emptyFacts: ProviderFacts = { endpoints: [], envVars: [], queueNames: [], files: [] };
const factsWithTag: Record<string, ProviderFacts> = {
  "api-a@a1": { ...emptyFacts, endpoints: ["/v1/orders"] },
  "api-a@a2": { ...emptyFacts, endpoints: ["/v1/orders", "/v2/orders"] },
  "api-a@a3": { ...emptyFacts, endpoints: ["/v1/orders", "/v2/orders", "/v3/orders"] },
};
// Non-monotone facts: a2 serves /v2/orders only, a3 serves /v3/orders only — no single tag serves both.
const nonMonotoneFacts: Record<string, ProviderFacts> = {
  "api-a@a2": { ...emptyFacts, endpoints: ["/v2/orders"] },
  "api-a@a3": { ...emptyFacts, endpoints: ["/v3/orders"] },
};
const ordersV2AndV3: Requirement[] = [
  { service: "api-b", kind: "endpoint", detail: "/v2/orders", citation: { file: "c.ts", line: 2 } },
  { service: "api-b", kind: "endpoint", detail: "/v3/orders", citation: { file: "c.ts", line: 3 } },
];

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
    expect(result.unmet[0]?.reason).toBe("no tag of any provider serves /v9/ghost");
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

  it("reduces two same-provider requirements into one bump at the smallest tag serving both", async () => {
    const result = await solveMinimumUpgrades({ ...baseInput, requirements: ordersV2AndV3 });
    expect(result.verdict).toBe("pass");
    expect(result.requiredBumps).toEqual([
      {
        service: "api-a",
        from: "a1",
        to: "a3", // a2 serves /v2/orders only — the row must jump straight to the first tag serving both
        reason: "serves /v2/orders, /v3/orders (needed by api-b — c.ts:2, c.ts:3)",
      },
    ]);
  });

  it("fails with every requirement unmet when non-monotone facts leave no single serving tag", async () => {
    const result = await solveMinimumUpgrades({
      ...baseInput,
      factsAtTag: (service: string, tag: string) =>
        Promise.resolve(nonMonotoneFacts[`${service}@${tag}`] ?? emptyFacts),
      requirements: ordersV2AndV3,
    });
    expect(result.verdict).toBe("fail");
    expect(result.requiredBumps).toEqual([]);
    expect(result.unmet).toEqual([
      {
        service: "api-b",
        kind: "endpoint",
        detail: "/v2/orders",
        citation: { file: "c.ts", line: 2 },
        reason: "no single tag of api-a serves all routed requirements",
      },
      {
        service: "api-b",
        kind: "endpoint",
        detail: "/v3/orders",
        citation: { file: "c.ts", line: 3 },
        reason: "no single tag of api-a serves all routed requirements",
      },
    ]);
  });

  it("pins the combined reason format across multiple consumers (consumed character-exact by the report)", async () => {
    const result = await solveMinimumUpgrades({
      ...baseInput,
      requirements: [
        { service: "api-b", kind: "endpoint", detail: "/v2/orders", citation: { file: "c.ts", line: 2 } },
        { service: "api-c", kind: "endpoint", detail: "/v3/orders", citation: { file: "d.ts", line: 7 } },
      ],
    });
    expect(result.requiredBumps).toHaveLength(1);
    expect(result.requiredBumps[0]?.reason).toBe(
      "serves /v2/orders, /v3/orders (needed by api-b, api-c — c.ts:2, d.ts:7)",
    );
  });
});
