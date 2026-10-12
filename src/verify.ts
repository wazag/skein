import type { Claim } from "./extract";

export type VerificationResult = { verified: Claim[]; dropped: Array<{ claim: Claim; reason: string }> };

const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_FILE_HEADER_PATTERN = /^diff --git a\/(.+) b\/(.+)$/;

function addedLineNumbersByFile(diff: string): Map<string, Set<number>> {
  const addedLines = new Map<string, Set<number>>();
  let currentFile = "";
  let insideHunk = false;
  let newFileLine = 0;
  for (const line of diff.split("\n")) {
    const fileHeader = DIFF_FILE_HEADER_PATTERN.exec(line);
    if (fileHeader) {
      currentFile = fileHeader[2] ?? "";
      insideHunk = false;
      continue;
    }
    const hunkHeader = HUNK_HEADER_PATTERN.exec(line);
    if (hunkHeader) {
      newFileLine = Number.parseInt(hunkHeader[1] ?? "0", 10);
      insideHunk = true;
      continue;
    }
    // Only hunk bodies carry +/-/space content lines. Header metadata such as '+++ b/file' starts
    // with '+' too; counting it would credit a stale line number carried over from the previous file.
    if (!insideHunk) continue;
    if (line.startsWith("+")) {
      const addedInFile = addedLines.get(currentFile) ?? new Set<number>();
      addedInFile.add(newFileLine);
      addedLines.set(currentFile, addedInFile);
      newFileLine += 1;
    } else if (line.startsWith("-")) {
      // removed lines exist only on the old side and do not advance the new-file counter
    } else if (line.startsWith(" ")) {
      newFileLine += 1;
    }
  }
  return addedLines;
}

export async function verifyClaims(
  claims: Claim[],
  diff: string,
  readFile: (file: string) => Promise<string | undefined>,
): Promise<VerificationResult> {
  const addedLines = addedLineNumbersByFile(diff);
  const verified: Claim[] = [];
  const dropped: Array<{ claim: Claim; reason: string }> = [];
  for (const claim of claims) {
    const addedAtCitation = addedLines.get(claim.citation.file)?.has(claim.citation.line) ?? false;
    if (addedAtCitation) {
      verified.push(claim);
      continue;
    }
    const repoLine = (await readFile(claim.citation.file))?.split("\n")[claim.citation.line - 1];
    const citedFragment = claim.detail.split(" ").pop() ?? claim.detail;
    if (repoLine !== undefined && repoLine.includes(citedFragment)) {
      verified.push(claim);
      continue;
    }
    dropped.push({
      claim,
      reason: `citation ${claim.citation.file}:${claim.citation.line} not found in diff or repo at tag`,
    });
  }
  return { verified, dropped };
}
