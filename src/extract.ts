import { z } from "zod";
import { runCostTracker, type ModelPrice } from "./cost";

const MAX_LINES_PER_CALL = 1500;
const MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_MODEL_PRICE: ModelPrice = { input: 3, output: 15 }; // claude-sonnet-5 list price, USD per 1M tokens
const EXTRACTION_PROMPT = `You analyze a git diff of a service in a multi-repo system. Extract ONLY new outbound cross-repo requirements introduced by this diff:
- endpoints this service now CALLS (kind "endpoint", direction "calls")
- environment variables this service now READS (kind "env", direction "reads")
- temporal task-queue names now used (kind "queue", direction "reads")
Every claim MUST cite the file and line number in the diff where it appears. Uncited claims will be discarded. Return JSON: an array of claims, nothing else.`;

export const claimSchema = z.object({
  kind: z.enum(["endpoint", "env", "queue"]),
  detail: z.string().min(1),
  direction: z.enum(["calls", "serves", "reads"]),
  citation: z.object({ file: z.string().min(1), line: z.number().int().nonnegative() }),
});
export type Claim = z.infer<typeof claimSchema>;
export const claimArraySchema = z.array(claimSchema);

// Minimal so Task 11's adapter over the real SDK is a thin shim:
// response.content[].text and response.usage already match this shape.
export type AnthropicClient = {
  createMessage(input: unknown): Promise<{
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
  }>;
};

function chunkDiff(diff: string): string[] {
  const fileSections = diff.split(/(?=^diff --git )/m).filter(Boolean);
  const chunks: string[] = [];
  let currentBatch: string[] = [];
  let batchLineCount = 0;
  for (const section of fileSections) {
    const sectionLineCount = section.split("\n").length;
    if (batchLineCount + sectionLineCount > MAX_LINES_PER_CALL && currentBatch.length > 0) {
      chunks.push(currentBatch.join("\n"));
      currentBatch = [];
      batchLineCount = 0;
    }
    currentBatch.push(section);
    batchLineCount += sectionLineCount;
  }
  if (currentBatch.length > 0) chunks.push(currentBatch.join("\n"));
  return chunks.length > 0 ? chunks : [diff];
}

function schemaValidClaimsFrom(candidate: unknown): Claim[] {
  if (!Array.isArray(candidate)) return [];
  const claims: Claim[] = [];
  for (const entry of candidate) {
    const result = claimSchema.safeParse(entry);
    if (result.success) claims.push(result.data);
  }
  return claims;
}

// Models differ in JSON habits: Claude returns the bare array; others wrap it
// in markdown fences or lead with prose. Tolerate fences and leading/trailing
// noise by slicing the outermost [...] span before parsing.
function claimsFromResponseText(text: string | undefined): Claim[] {
  const raw = (text ?? "").trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const candidates = [unfenced];
  const arraySpan = /\[[\s\S]*\]/.exec(unfenced);
  if (arraySpan) candidates.push(arraySpan[0]);
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) return schemaValidClaimsFrom(parsed);
    } catch {
      // try the next, more aggressive extraction
    }
  }
  return [];
}

export async function extractClaims(
  model: string,
  diff: string,
  serviceName: string,
  anthropic: AnthropicClient,
  tracker = runCostTracker(),
  price: ModelPrice = DEFAULT_MODEL_PRICE,
): Promise<Claim[]> {
  const claims: Claim[] = [];
  for (const chunk of chunkDiff(diff)) {
    const response = await anthropic.createMessage({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: EXTRACTION_PROMPT,
      messages: [{ role: "user", content: `<service>${serviceName}</service>\n<diff>\n${chunk}\n</diff>` }],
    });
    tracker.add(response.usage, price);
    const text = response.content.find((part) => part.type === "text")?.text;
    claims.push(...claimsFromResponseText(text));
  }
  return claims;
}
