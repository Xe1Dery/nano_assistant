/**
 * Smoke test for the GENERATED payload (openclaw/reminder-scan.js): loads it
 * the way the OpenClaw script-payload runtime does — the file body inside an
 * async function, globals passed as parameters — and drives one full scan
 * with a fake MCP. Proves the generated artifact parses, calls the right
 * tools, and returns the contract object.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "openclaw", "reminder-scan.js"), "utf8");
const run = new Function("MCP", "trigger", `return (async () => { ${source} })()`);

function fakeMcp(calls) {
  const due = new Date(Date.now() + 5 * 60_000).toISOString();
  return {
    ticktick: {
      async list_projects() {
        calls.push("list_projects");
        return { projects: [{ id: "p1", name: "Inbox", kind: "TASK" }, { id: "p2", name: "Notes", kind: "NOTE" }] };
      },
      async get_project_tasks(args) {
        calls.push(`get_project_tasks:${args.project_id}`);
        return { tasks: [{ id: "t1", title: "Позвонить клиенту", dueDate: due, status: 0 }] };
      },
    },
  };
}

test("generated payload runs one scan and returns the contract object", async () => {
  const calls = [];
  const result = await run(fakeMcp(calls), { state: null });
  assert.deepEqual(calls, ["list_projects", "get_project_tasks:p1"]); // NOTE list skipped
  assert.equal(typeof result.nextCheck, "string");
  assert.match(result.nextCheck, /^\d+m$/);
  assert.equal(result.state.tasks.t1.status, "due");
  assert.equal(result.notify, undefined); // due in 5 minutes: nothing to fire yet
});

test("a due task makes the payload notify with the courier contract", async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const mcp = {
    ticktick: {
      async list_projects() { return [{ id: "p1", name: "Inbox", kind: "TASK" }]; },
      async get_project_tasks() { return { tasks: [{ id: "t9", title: "Купить хлеб", dueDate: past, status: 0 }] }; },
    },
  };
  const result = await run(mcp, { state: null });
  assert.equal(result.wake, "now");
  assert.match(result.notify, /REMINDER_EVENT v1/);
  assert.match(result.notify, /glasses\.reminder_show/);
  assert.match(result.notify, /"task_id":"t9"/);
  assert.equal(result.state.tasks.t9.status, "notified");
});

test("an unavailable MCP tool fails loudly, not silently", async () => {
  await assert.rejects(
    () => run({ ticktick: {} }, { state: null }),
    /unavailable/,
  );
});
