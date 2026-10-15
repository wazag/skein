// Fixture service for the Skein e2e rig. One image, behavior driven by env:
//   SERVE=/v1/orders            — endpoints this instance serves (comma list)
//   CALL=/v1/orders             — endpoints this instance requires upstream
//   UPSTREAM_URL=http://api-a:8080
//   REQUIRED_ENV_1=ORDERS_V2_URL — env vars whose absence kills the process at boot
// Health: /healthz returns 200 only when every CALL endpoint answers upstream;
// the /call/<name> handler proxies one upstream check for orchestration probes.
const http = require("node:http");

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const SERVED = (process.env.SERVE ?? "").split(",").filter(Boolean);
const CALLED = (process.env.CALL ?? "").split(",").filter(Boolean);
const UPSTREAM_URL = process.env.UPSTREAM_URL ?? "";
const REQUIRED_ENV_NAMES = (process.env.REQUIRED_ENV ?? "").split(",").filter(Boolean);

for (const name of REQUIRED_ENV_NAMES) {
  if (!process.env[name]) {
    console.error(`fixture: required env ${name} is missing — refusing to start`);
    process.exit(1);
  }
}

async function endpointReachable(path) {
  if (!UPSTREAM_URL) return false;
  try {
    const response = await fetch(`${UPSTREAM_URL}${path}`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

const server = http.createServer(async (request, response) => {
  const path = request.url ?? "/";
  if (path === "/healthz") {
    const results = await Promise.all(CALLED.map((endpoint) => endpointReachable(endpoint)));
    const healthy = SERVED.length > 0 && results.every(Boolean);
    response.statusCode = healthy ? 200 : 503;
    response.end(JSON.stringify({ healthy, served: SERVED, called: CALLED, results }));
    return;
  }
  if (path.startsWith("/call/")) {
    const endpoint = decodeURIComponent(path.slice("/call/".length));
    response.statusCode = (await endpointReachable(endpoint)) ? 200 : 502;
    response.end(endpoint);
    return;
  }
  if (SERVED.includes(path)) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ endpoint: path, served: true }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ endpoint: path, error: "not served by this version" }));
});

server.listen(PORT, () => console.log(`fixture: serving ${SERVED.join(", ") || "nothing"} on :${PORT}`));
