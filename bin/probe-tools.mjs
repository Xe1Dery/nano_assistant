#!/usr/bin/env node
/**
 * One-shot probe of the official TickTick MCP server: initialize, list tools,
 * print names + input schemas, and (optionally) call one tool to show the
 * response shape. Run this on the OpenClaw host before wiring the payload,
 * and again after any TickTick API change.
 *
 * Usage:
 *   TICKTICK_TOKEN=... node bin/probe-tools.mjs
 *   TICKTICK_TOKEN=... node bin/probe-tools.mjs --call get_project_tasks '{"project_id":"..."}'
 *
 * The token comes from TickTick web: Settings -> Account -> API Token.
 * It is read from the environment only; never put it in a file that syncs.
 */
const URL_ = process.env.TICKTICK_MCP_URL || "https://mcp.ticktick.com";
const TOKEN = process.env.TICKTICK_TOKEN;
if (!TOKEN) {
  console.error("Set TICKTICK_TOKEN (TickTick web -> Settings -> Account -> API Token).");
  process.exit(2);
}

let sessionId = null;

async function rpc(method, params, isNotification = false) {
  const body = isNotification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: 1, method, params };
  const res = await fetch(URL_, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const text = await res.text();
  if (isNotification) return null;
  // Streamable HTTP may answer with an SSE body; take the last data: line.
  const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
  const payload = dataLines.length ? dataLines.at(-1).slice(5).trim() : text;
  const parsed = JSON.parse(payload);
  if (parsed.error) throw new Error(`${method} -> ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

function toolText(result) {
  const content = result?.content ?? [];
  const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  try { return JSON.parse(text); } catch { return text || result?.structuredContent; }
}

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "nano-reminder-probe", version: "1.0" },
});
await rpc("notifications/initialized", {}, true);

const callIdx = process.argv.indexOf("--call");
if (callIdx !== -1) {
  const tool = process.argv[callIdx + 1];
  const args = JSON.parse(process.argv[callIdx + 2] ?? "{}");
  const result = await rpc("tools/call", { name: tool, arguments: args });
  console.log(JSON.stringify(toolText(result), null, 2));
} else {
  const { tools } = await rpc("tools/list", {});
  for (const t of tools) {
    console.log(`\n== ${t.name}`);
    console.log(`   ${t.description?.slice(0, 100) ?? ""}`);
    const props = t.inputSchema?.properties;
    if (props) console.log(`   args: ${Object.keys(props).join(", ")}`);
  }
  console.log(`\n${tools.length} tools. Wire the names you need into openclaw/payload-wrapper.js TOOL_NAMES, then run bin/build-payload.mjs.`);
}
