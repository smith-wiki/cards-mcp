#!/usr/bin/env node
// Smoke test of the deployed MCP Worker through Cloudflare Access with a service token.
// It has no side effects: create_card is only called with input that must be rejected.
//
//   export MCP_URL=https://cards-mcp.smith.wiki/mcp
//   read -rs CF_ACCESS_CLIENT_ID && export CF_ACCESS_CLIENT_ID
//   read -rs CF_ACCESS_CLIENT_SECRET && export CF_ACCESS_CLIENT_SECRET
//   node scripts/smoke.mjs
const url = process.env.MCP_URL ?? "https://cards-mcp.smith.wiki/mcp";
const clientId = process.env.CF_ACCESS_CLIENT_ID;
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (an Access service token).");
  process.exit(2);
}

const PROTOCOL = "2025-06-18";
let failed = false;

function report(ok, step, detail) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? `  ${detail}` : ""}`);
}

async function post(body, auth = true) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL,
      ...(auth ? { "cf-access-client-id": clientId, "cf-access-client-secret": clientSecret } : {}),
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  const text = await response.text();
  if (!response.ok) return { status: response.status, headers: response.headers, text };
  const json = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).at(-1)
    : text;
  return { status: response.status, headers: response.headers, message: JSON.parse(json) };
}

let id = 0;
const rpc = (method, params) => post({ jsonrpc: "2.0", id: ++id, method, params });
const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).message?.result;

// 1. Access sits in front of the Worker: no credentials -> Access 401 with OAuth discovery.
const anonymous = await post({ jsonrpc: "2.0", id: 0, method: "ping" }, false);
report(
  anonymous.status === 401 && Boolean(anonymous.headers.get("www-authenticate")),
  "Access challenges anonymous requests",
  `HTTP ${anonymous.status}, www-authenticate: ${anonymous.headers.get("www-authenticate") ?? "none (Access is not in front)"}`,
);
const metadata = await fetch(new URL("/.well-known/oauth-authorization-server", url));
report(metadata.ok, "OAuth authorization server metadata", `HTTP ${metadata.status}`);

// 2. Service token -> Access JWT -> Worker verifies it (ACCESS_TEAM_DOMAIN, ACCESS_AUD).
const init = await rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
report(Boolean(init.message?.result), "initialize", init.message ? init.message.result?.serverInfo?.name : `HTTP ${init.status} ${init.text?.slice(0, 200)}`);
if (!init.message) {
  console.log("Stop: the Worker rejected the Access JWT or Access rejected the service token. Check the Access policy (Service Auth) and ACCESS_TEAM_DOMAIN / ACCESS_AUD, then the Worker logs.");
  process.exit(1);
}

const tools = (await rpc("tools/list", {})).message?.result?.tools?.map((tool) => tool.name).sort() ?? [];
report(tools.join() === "create_card,get_cards,search_cards", "tools/list", tools.join(", "));

// 3. D1 (schema created on first request) and Workers AI + Vectorize.
const got = await call("get_cards", { ids: ["2222222222222"] });
report(!got?.isError && got?.structuredContent?.not_found?.length === 1, "get_cards (D1)", JSON.stringify(got?.structuredContent ?? got));
const found = await call("search_cards", { query: "smoke test" });
report(!found?.isError, "search_cards (Workers AI + Vectorize)", JSON.stringify(found?.structuredContent ?? found));

// 4. Validation rejects before any side effect.
const rejected = await call("create_card", { author: "operator", short_text: "Plain text without a parent." });
report(rejected?.isError === true, "create_card rejects an Operator Card without a parent", rejected?.content?.[0]?.text?.slice(0, 200));

process.exit(failed ? 1 : 0);
