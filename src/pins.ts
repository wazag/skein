import { parse as parseYaml } from "yaml";
import { SkeinConfigError, type ServiceEntry } from "./config";

const PATH_TOKEN_PATTERN = /^([A-Za-z0-9_-]+)((?:\[\d+\])*)$/;
const INDEX_PATTERN = /\[\d+\]/g;
const MEMORY_SOURCE_LABEL = "<memory>";
const ABSENT_PIN_LABEL = "<none>";

function sourceContext(sourceFile: string | undefined, path: string): string {
  return `${sourceFile ?? MEMORY_SOURCE_LABEL}#${path}`;
}

export function getAtPath(root: unknown, path: string, sourceFile?: string): string {
  let current: unknown = root;
  for (const rawToken of path.split(".")) {
    const match = PATH_TOKEN_PATTERN.exec(rawToken);
    if (!match) throw new SkeinConfigError(`bad path token '${rawToken}' in ${sourceContext(sourceFile, path)}`);
    const key = match[1];
    if (key === undefined) {
      throw new SkeinConfigError(`bad path token '${rawToken}' in ${sourceContext(sourceFile, path)}`);
    }
    if (typeof current !== "object" || current === null || !(key in current)) {
      throw new SkeinConfigError(`path not found: ${sourceContext(sourceFile, path)} (missing key '${key}')`);
    }
    current = (current as Record<string, unknown>)[key];
    const bracketedIndices = match[2] ?? "";
    for (const bracket of bracketedIndices.match(INDEX_PATTERN) ?? []) {
      const index = Number.parseInt(bracket.slice(1, -1), 10);
      if (!Array.isArray(current) || current[index] === undefined) {
        throw new SkeinConfigError(`path not found: ${sourceContext(sourceFile, path)} (bad index [${index}])`);
      }
      current = current[index];
    }
  }
  if (typeof current !== "string" && typeof current !== "number") {
    throw new SkeinConfigError(`path not found: ${sourceContext(sourceFile, path)} (value is not a scalar)`);
  }
  return String(current);
}

export type PinSnapshot = Record<string, string>;

export function extractPins(
  serviceEntries: Record<string, ServiceEntry>,
  readFileAtRef: (file: string, ref: string) => string,
  ref: string
): PinSnapshot {
  const snapshot: PinSnapshot = {};
  for (const [service, entry] of Object.entries(serviceEntries)) {
    snapshot[service] = getAtPath(parseYaml(readFileAtRef(entry.file, ref)), entry.path, entry.file);
  }
  return snapshot;
}

export function detectBumps(base: PinSnapshot, head: PinSnapshot): Array<{ service: string; from: string; to: string }> {
  return Object.keys(head)
    .filter((service) => base[service] !== head[service])
    .map((service) => ({ service, from: base[service] ?? ABSENT_PIN_LABEL, to: head[service] ?? ABSENT_PIN_LABEL }));
}
