import { describe, expect, it } from "vitest";
import { SkeinConfigError } from "../src/config";
import { detectBumps, extractPins, getAtPath } from "../src/pins";

describe("getAtPath", () => {
  const values = { restApi: { image: { tag: "a1" } }, images: [{ tag: "b3" }, { tag: "c2" }] };

  it("resolves dotted paths", () => {
    expect(getAtPath(values, "restApi.image.tag")).toBe("a1");
  });
  it("resolves array indices", () => {
    expect(getAtPath(values, "images[1].tag")).toBe("c2");
  });
  it("throws naming file and path when key missing", () => {
    expect(() => getAtPath(values, "restApi.missing.tag", "env/prod/a.yaml")).toThrow(
      "env/prod/a.yaml#restApi.missing.tag"
    );
  });
});

describe("extractPins + detectBumps", () => {
  const entries = {
    "api-a": { repo: "org/api-a", file: "env/prod/a.yaml", path: "tag" },
    "api-b": { repo: "org/api-b", file: "env/prod/b.yaml", path: "tag" },
  };
  const files: Record<string, Record<string, string>> = {
    "env/prod/a.yaml": { tag: "a1" },
    "env/prod/b.yaml": { tag: "b3" },
  };
  const headFiles = { ...files, "env/prod/b.yaml": { tag: "b5" } };
  const readFileAtRef = (table: Record<string, Record<string, string>>) =>
    (file: string, ref: string) => {
      void ref;
      const content = table[file];
      if (!content) throw new Error(`file not found: ${file}`);
      return JSON.stringify(content); // yaml is a JSON superset — parseable by yaml lib
    };

  it("extracts one pin per service", () => {
    expect(extractPins(entries, readFileAtRef(files), "HEAD")).toEqual({ "api-a": "a1", "api-b": "b3" });
  });
  it("detects only the bumped service", () => {
    const bumps = detectBumps(
      extractPins(entries, readFileAtRef(files), "BASE"),
      extractPins(entries, readFileAtRef(headFiles), "HEAD")
    );
    expect(bumps).toEqual([{ service: "api-b", from: "b3", to: "b5" }]);
  });
  it("returns empty when nothing changed", () => {
    const snapshot = extractPins(entries, readFileAtRef(files), "BASE");
    expect(detectBumps(snapshot, snapshot)).toEqual([]);
  });
});
