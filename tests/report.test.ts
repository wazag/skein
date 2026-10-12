import { describe, expect, it } from "vitest";
import { renderReport } from "../src/report";

describe("renderReport", () => {
  it("renders pass banner, tag links, cost, confidence", () => {
    const report = renderReport({
      verdict: "pass",
      bumps: [{ service: "api-a", from: "a1", to: "a2", reason: "serves /v2/orders (needed by api-b — c.ts:2)" }],
      missingEnv: [],
      dropped: [],
      unmet: [],
      basePins: { "api-a": "a1", "api-b": "b3" },
      headPins: { "api-a": "a1", "api-b": "b5" },
      repoUrlFor: (service) => `https://github.com/org/${service}`,
      costUsd: 0.042,
      totalClaims: 5,
      verifiedClaims: 5,
    });
    expect(report).toContain("<!-- skein-report:v1 -->");
    expect(report).toContain("✅");
    expect(report).toContain("api-b: b3 → b5");
    expect(report).toContain("https://github.com/org/api-b/compare/b3...b5");
    expect(report).toContain("api-a: a1 → a2");
    expect(report).toContain("$0.042");
    expect(report).toContain("5/5 claims verified");
  });

  it("renders fail banner with missing env and confidence flags when claims dropped", () => {
    const report = renderReport({
      verdict: "fail", bumps: [], totalClaims: 4, verifiedClaims: 3,
      missingEnv: [{ env: "ORDERS_V2_URL", consumer: "api-b", citation: { file: "c.ts", line: 3 } }],
      dropped: [{ claim: { kind: "endpoint", detail: "/v9/x", direction: "calls", citation: { file: "z.ts", line: 9 } }, reason: "dangling" }],
      unmet: [], basePins: {}, headPins: {}, repoUrlFor: () => "https://github.com/org/x", costUsd: 0.01,
    });
    expect(report).toContain("❌");
    expect(report).toContain("ORDERS_V2_URL");
    expect(report).toContain("⚠️ 1 claim");
    expect(report).toContain("⚠️ 1 claim dropped, 3/4 verified");
    expect(report).toContain("- ⚠️ claim endpoint `/v9/x` (z.ts:9) dropped — dangling");
  });

  it("fills the unmet table status column with the solver's reason string", () => {
    const report = renderReport({
      verdict: "fail",
      bumps: [],
      missingEnv: [],
      dropped: [],
      unmet: [
        {
          service: "api-b",
          kind: "endpoint",
          detail: "/v9/ghost",
          citation: { file: "c.ts", line: 9 },
          reason: "no tag of any provider serves /v9/ghost",
        },
      ],
      basePins: {},
      headPins: {},
      repoUrlFor: () => "https://github.com/org/x",
      costUsd: 0.007,
      totalClaims: 2,
      verifiedClaims: 2,
    });
    expect(report).toContain("Unsatisfiable requirements");
    expect(report).toContain("| requirement | consumer | citation | status |");
    expect(report).toContain("| endpoint `/v9/ghost` | api-b | c.ts:9 | no tag of any provider serves /v9/ghost |");
  });
});
