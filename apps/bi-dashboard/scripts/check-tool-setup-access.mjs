import assert from "node:assert/strict";

const origin = process.env.TOOL_SETUP_TEST_ORIGIN || "http://localhost:3000";
const workspace = "ac8ef5d8-1bf0-4936-994d-414ef0154698";
for (const [path, method, body] of [
  [`/api/workspaces/${workspace}/tool-setup`, "GET"],
  [
    `/api/workspaces/${workspace}/tool-setup`,
    "POST",
    { action: "databases", serverId: "00000000-0000-4000-8000-000000000000" },
  ],
  [
    `/api/workspaces/${workspace}/tools/mcp`,
    "POST",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
  ],
]) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(
    response.status,
    403,
    "Unauthenticated requests must be denied before source access.",
  );
  const data = await response.json();
  assert.ok(!data.servers && !data.sources && !data.tools);
  console.log(
    `${method} ${path.split("/").slice(-2).join("/")} rejects unauthenticated access.`,
  );
}
const response = await fetch(
  `${origin}/api/workspaces/${workspace}/tool-setup`,
  {
    method: "POST",
    headers: {
      origin: "https://untrusted.example",
      "content-type": "application/json",
    },
    body: "{}",
  },
);
assert.equal(response.status, 403);
console.log("Cross-origin setup mutation rejected.");
