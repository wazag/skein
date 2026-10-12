const CODE_FILE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rb", ".java", ".kt", ".cs", ".rs"];
const NON_CODE_DIRS = ["node_modules/", "vendor/", "dist/", ".git/"];
// Endpoints need at least two path segments — a bare "/health" is too generic to be a fact.
const ENDPOINT_PATTERN = /["'`](\/[A-Za-z0-9:_-]+(?:\/[A-Za-z0-9:_-{}]+)+)["'`]/g;
const ENV_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /os\.environ(?:\.get)?[[(]["']([A-Z][A-Z0-9_]+)["'][\])]/g,
  /os\.getenv\(["']([A-Z][A-Z0-9_]+)["']\)/g,
  /ENV\[["']([A-Z][A-Z0-9_]+)["']\]/g,
];
// A queue fact is a queue-shaped string literal sharing a line with a taskQueue reference;
// the literal may sit before or after the reference (const q = "name"; taskQueue.register(q)).
const QUEUE_LINE_PATTERN = /task_?queue/i;
const QUEUE_NAME_PATTERN = /["'`]([a-z0-9-]{3,}-[a-z0-9-]*queue[a-z0-9-]*|[a-z0-9-]+-task-queue)["'`]/gi;

export type ProviderFacts = {
  endpoints: string[];
  envVars: string[];
  queueNames: string[];
  files: string[];
};

function uniqueCaptures(content: string, pattern: RegExp): string[] {
  const captured = new Set<string>();
  for (const match of content.matchAll(pattern)) {
    const firstGroup = match[1];
    if (firstGroup !== undefined) captured.add(firstGroup);
  }
  return [...captured];
}

function isCodeFile(file: string): boolean {
  return (
    CODE_FILE_EXTENSIONS.some((extension) => file.endsWith(extension)) &&
    !NON_CODE_DIRS.some((dir) => file.includes(dir))
  );
}

function queueNamesIn(content: string): string[] {
  const names = new Set<string>();
  for (const line of content.split("\n")) {
    if (!QUEUE_LINE_PATTERN.test(line)) continue;
    for (const name of uniqueCaptures(line, QUEUE_NAME_PATTERN)) names.add(name);
  }
  return [...names];
}

export async function harvestFacts(
  readFileAtRef: (file: string) => Promise<string>,
  listFiles: () => Promise<string[]>,
): Promise<ProviderFacts> {
  const codeFiles = (await listFiles()).filter(isCodeFile);
  const endpoints = new Set<string>();
  const envVars = new Set<string>();
  const queueNames = new Set<string>();
  for (const file of codeFiles) {
    const content = await readFileAtRef(file);
    for (const endpoint of uniqueCaptures(content, ENDPOINT_PATTERN)) endpoints.add(endpoint);
    for (const pattern of ENV_PATTERNS) {
      for (const envVar of uniqueCaptures(content, pattern)) envVars.add(envVar);
    }
    for (const queueName of queueNamesIn(content)) queueNames.add(queueName);
  }
  return { endpoints: [...endpoints], envVars: [...envVars], queueNames: [...queueNames], files: codeFiles };
}
