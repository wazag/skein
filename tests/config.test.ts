import { describe, expect, it } from "vitest";
import { SkeinConfigError, loadRunSettings, parseSkeinYaml } from "../src/config";

const validYaml = `
services:
  api-a:
    repo: org/api-a
    file: env/prod/a.yaml
    path: restApi.image.tag
  worker-x:
    repo: org/worker-x
    file: env/prod/wx.yaml
    path: images[0].tag
    hints:
      type: temporal
`;

describe("parseSkeinYaml", () => {
  it("parses services with repo, file, path, optional hints", () => {
    const config = parseSkeinYaml(validYaml);
    expect(config.services["api-a"]).toEqual({
      repo: "org/api-a",
      file: "env/prod/a.yaml",
      path: "restApi.image.tag",
    });
    expect(config.services["worker-x"]?.hints).toEqual({ type: "temporal" });
  });

  it("rejects a service missing path with an error naming the service and field", () => {
    expect(() => parseSkeinYaml("services:\n  api-a:\n    repo: org/a\n    file: f.yaml\n"))
      .toThrow(SkeinConfigError);
    try {
      parseSkeinYaml("services:\n  api-a:\n    repo: org/a\n    file: f.yaml\n");
    } catch (error) {
      expect((error as Error).message).toContain("api-a");
      expect((error as Error).message).toContain("path");
      expect((error as Error).message).toContain("(service 'api-a')");
    }
  });

  it("rejects empty services map", () => {
    expect(() => parseSkeinYaml("services: {}")).toThrow(/at least one service/);
  });
});

describe("loadRunSettings", () => {
  const defaults = { mode: "advisory", model: "claude-sonnet-5", concurrency: "4", "max-cost-usd": "5.00", config: "skein.yaml" };
  const fakeGet = (overrides: Record<string, string> = {}) =>
    (name: string) => overrides[name] ?? defaults[name as keyof typeof defaults] ?? "";

  it("applies documented defaults", () => {
    expect(loadRunSettings(fakeGet())).toEqual({
      mode: "advisory", model: "claude-sonnet-5", concurrency: 4, maxCostUsd: 5, configPath: "skein.yaml",
    });
  });

  it("overrides via inputs and rejects unknown mode", () => {
    expect(loadRunSettings(fakeGet({ mode: "enforcing" })).mode).toBe("enforcing");
    expect(() => loadRunSettings(fakeGet({ mode: "yolo" }))).toThrow(/mode/);
  });
});
