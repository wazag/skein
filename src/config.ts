import { z } from "zod";
import { parse as parseYaml } from "yaml";

const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const DEFAULT_MODE = "advisory";
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_COST_USD = 5;
const DEFAULT_CONFIG_PATH = "skein.yaml";

export class SkeinConfigError extends Error {}

const serviceEntrySchema = z.object({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must look like owner/repo"),
  file: z.string().min(1),
  path: z.string().min(1),
  hints: z.object({ type: z.string().optional() }).optional(),
});

export type ServiceEntry = z.infer<typeof serviceEntrySchema>;
export type SkeinConfig = { services: Record<string, ServiceEntry> };

export function parseSkeinYaml(rawYaml: string): SkeinConfig {
  const parsed: unknown = parseYaml(rawYaml);
  const root = z.object({ services: z.record(z.string(), serviceEntrySchema) })
    .refine((value) => Object.keys(value.services).length > 0, { message: "at least one service is required" })
    .safeParse(parsed);
  if (!root.success) {
    const [issue] = root.error.issues;
    if (!issue) {
      throw new SkeinConfigError("skein.yaml invalid: unknown validation failure");
    }
    const serviceContext = issue.path.length > 1 ? ` (service '${String(issue.path[0])}')` : "";
    throw new SkeinConfigError(`skein.yaml invalid${serviceContext}: ${issue.path.join(".") || "root"} — ${issue.message}`);
  }
  for (const [name, entry] of Object.entries(root.data.services)) {
    if (!SERVICE_NAME_PATTERN.test(name)) {
      throw new SkeinConfigError(`skein.yaml: service name '${name}' must match ${SERVICE_NAME_PATTERN}`);
    }
    void entry;
  }
  return { services: root.data.services };
}

export type RunSettings = {
  mode: "advisory" | "enforcing";
  model: string;
  concurrency: number;
  maxCostUsd: number;
  configPath: string;
};

export function loadRunSettings(getInput: (name: string) => string): RunSettings {
  const modeInput = getInput("mode") || DEFAULT_MODE;
  if (modeInput !== "advisory" && modeInput !== "enforcing") {
    throw new SkeinConfigError(`mode must be 'advisory' or 'enforcing', got '${modeInput}'`);
  }
  const concurrency = Number.parseInt(getInput("concurrency") || String(DEFAULT_CONCURRENCY), 10);
  if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new SkeinConfigError(`concurrency must be an integer 1-32, got '${getInput("concurrency")}'`);
  }
  return {
    mode: modeInput,
    model: getInput("model") || DEFAULT_MODEL,
    concurrency,
    maxCostUsd: Number.parseFloat(getInput("max-cost-usd") || String(DEFAULT_MAX_COST_USD)),
    configPath: getInput("config") || DEFAULT_CONFIG_PATH,
  };
}
