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

// The payload enforces quiet hours from its own config; tests pin the window
// open via trigger.quiet so they pass at any wall clock.
const OPEN = { enabled: false };

/** A window closed at the current wall clock, for the quiet-hours test. */
function closedWindowNow() {
  const hh = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", hour12: false })
    .format(new Date()));
  return {
    enabled: true, timezone: "UTC",
    activeStart: `${String((hh + 1) % 24).padStart(2, "0")}:00`,
    activeEnd: `${String((hh + 2) % 24).padStart(2, "0")}:00`,
  };
}

function fakeMcp(calls) {
  const due = new Date(Date.now() + 5 * 60_000).toISOString();
  return {
    ticktick: {
      async list_projects() {
        calls.push("list_projects");
        // The real server answers with newline-delimited JSON objects.
        return [
          { id: "p1", name: "Inbox", kind: "TASK" },
          { id: "p2", name: "Notes", kind: "NOTE" },
        ].map((p) => JSON.stringify(p)).join("\n");
      },
      async get_project_with_undone_tasks(args) {
        calls.push(`get_project_with_undone_tasks:${args.project_id}`);
        return JSON.stringify({
          id: args.project_id, name: "Inbox", kind: "TASK",
          tasks: [{ id: "t1", title: "Позвонить клиенту", dueDate: due, status: 0 }],
        });
      },
    },
  };
}

test("generated payload runs one scan and returns the contract object", async () => {
  const calls = [];
  const result = await run(fakeMcp(calls), { state: null, quiet: OPEN });
  assert.deepEqual(calls, ["list_projects", "get_project_with_undone_tasks:p1"]); // NOTE list skipped
  assert.equal(typeof result.nextCheck, "string");
  assert.match(result.nextCheck, /^\d+m$/);
  assert.equal(result.state.tasks.t1.status, "due");
  assert.equal(result.notify, undefined); // due in 5 minutes: nothing to fire yet
});

test("a due task makes the payload notify with the courier contract", async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const mcp = {
    ticktick: {
      async list_projects() { return JSON.stringify({ id: "p1", name: "Inbox", kind: "TASK" }); },
      async get_project_with_undone_tasks() {
        return JSON.stringify({ id: "p1", tasks: [{ id: "t9", title: "Купить хлеб", dueDate: past, status: 0 }] });
      },
    },
  };
  const result = await run(mcp, { state: null, quiet: OPEN });
  assert.equal(result.wake, "now");
  assert.match(result.notify, /REMINDER_EVENT v2/);
  assert.match(result.notify, /glasses\.reminder_show/);
  assert.match(result.notify, /"task_id":"t9"/);
  assert.equal(result.state.tasks.t9.status, "notified");
});

test("an unavailable MCP tool fails loudly, not silently", async () => {
  await assert.rejects(
    () => run({ ticktick: {} }, { state: null, quiet: OPEN }),
    /unavailable/,
  );
});

test("virtual Inbox with an empty scoped answer falls back to account-wide queries", async () => {
  const calls = [];
  const due = new Date(Date.now() - 60_000).toISOString();
  const mcp = {
    ticktick: {
      async list_projects() { calls.push("list_projects"); return JSON.stringify({ id: "inbox", name: "Inbox", kind: "TASK" }); },
      async get_project_with_undone_tasks() { calls.push("scoped"); return JSON.stringify({ project: null, tasks: [] }); },
      async list_undone_tasks_by_time_query(args) {
        calls.push(`wide:${args.query_command}`);
        if (args.query_command !== "last7day") return "[]";
        return JSON.stringify({ tasks: [{ id: "tI", title: "Тест напоминания", dueDate: due, status: 0 }] });
      },
    },
  };
  const result = await run(mcp, { state: null, quiet: OPEN });
  assert.match(result.notify, /"task_id":"tI"/);
  assert.ok(calls.includes("wide:last7day"));
});

test("the payload also resolves camelCased tool names (code-mode renames them)", async () => {
  const calls = [];
  const due = new Date(Date.now() - 60_000).toISOString();
  const camelMcp = {
    ticktick: {
      async listProjects() { calls.push("listProjects"); return JSON.stringify({ id: "p1", name: "Inbox", kind: "TASK" }); },
      async getProjectWithUndoneTasks(args) {
        calls.push(`getProjectWithUndoneTasks:${args.project_id}`);
        return JSON.stringify({ id: "p1", tasks: [{ id: "t5", title: "Camel", dueDate: due, status: 0 }] });
      },
    },
  };
  const result = await run(camelMcp, { state: null, quiet: OPEN });
  assert.deepEqual(calls, ["listProjects", "getProjectWithUndoneTasks:p1"]);
  assert.match(result.notify, /"task_id":"t5"/);
});

test("quiet hours: no MCP calls, no notify, ledger passed through, wake capped", async () => {
  const calls = [];
  const state = { version: 1, lastScanAt: 1, tasks: { t1: { title: "x", dueMs: Date.now() - 60_000, status: "due", repeat: 0, lastNotifiedAt: 0 } } };
  const result = await run(fakeMcp(calls), { state, quiet: closedWindowNow() });
  assert.equal(calls.length, 0); // no TickTick traffic while quiet
  assert.equal(result.notify, undefined);
  assert.deepEqual(result.state, state); // ledger survives untouched
  const mins = Number(/^(\d+)m$/.exec(result.nextCheck)[1]);
  assert.ok(mins >= 1 && mins <= 30, `wake ${result.nextCheck} must be 1..30m`);
});

test("tasks due beyond the week horizon are not scanned and never fire", async () => {
  const far = new Date(Date.now() + 30 * 86_400_000).toISOString(); // birthday month away
  const near = new Date(Date.now() - 60_000).toISOString();
  const mcp = {
    ticktick: {
      async list_projects() { return JSON.stringify({ id: "p1", name: "Inbox", kind: "TASK" }); },
      async get_project_with_undone_tasks() {
        return JSON.stringify({ id: "p1", tasks: [
          { id: "bday", title: "День рождения", dueDate: far, status: 0 },
          { id: "t2", title: "Просрочено", dueDate: near, status: 0 },
        ] });
      },
      async get_task_by_id(args) {
        return JSON.stringify({ id: args.task_id, title: "Просрочено", dueDate: near, status: 0 });
      },
    },
  };
  const result = await run(mcp, { state: null, quiet: OPEN });
  assert.ok(result.notify, "the overdue task still fires");
  assert.match(result.notify, /"task_id":"t2"/);
  assert.ok(!("bday" in result.state.tasks), "the far-future birthday never enters the ledger");
  assert.equal(result.state.diag.beyondHorizon, 1);
});

test("a candidate the task detail reports closed is dropped, not nagged", async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const mcp = {
    ticktick: {
      async list_projects() { return JSON.stringify({ id: "p1", name: "Inbox", kind: "TASK" }); },
      async get_project_with_undone_tasks() {
        // The stale-list bug: the project list still answers status 0.
        return JSON.stringify({ id: "p1", tasks: [{ id: "t3", title: "Тест просрочки", dueDate: past, status: 0 }] });
      },
      async get_task_by_id() {
        // The authoritative read: completed, with a completedTime.
        return JSON.stringify({ id: "t3", title: "Тест просрочки", dueDate: past, status: 2, completedTime: past });
      },
    },
  };
  const result = await run(mcp, { state: null, quiet: OPEN });
  assert.equal(result.notify, undefined, "no popup for a task closed elsewhere");
  assert.ok(!("t3" in result.state.tasks), "the ledger entry is dropped");
});

test("all-day and undated tasks are tracked quietly; a timed task still fires", async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const mcp = {
    ticktick: {
      async list_projects() { return JSON.stringify({ id: "p1", name: "Inbox", kind: "TASK" }); },
      async get_project_with_undone_tasks() {
        return JSON.stringify({ id: "p1", tasks: [
          // An overdue all-day task: TickTick carries a dueDate, the
          // controller must still never notify for it.
          { id: "ad", title: "День рождения мамы", dueDate: past, isAllDay: true, status: 0 },
          { id: "nd", title: "Когда-нибудь", status: 0 },
          { id: "tm", title: "Позвонить клиенту", dueDate: past, status: 0 },
        ] });
      },
      async get_task_by_id(args) {
        return JSON.stringify({ id: args.task_id, title: args.task_id, dueDate: past, status: 0 });
      },
    },
  };
  const result = await run(mcp, { state: null, quiet: OPEN });
  assert.match(result.notify, /"task_id":"tm"/, "the timed task fires");
  assert.doesNotMatch(result.notify, /"task_id":"ad"/, "the all-day task is not in the popup");
  assert.doesNotMatch(result.notify, /"task_id":"nd"/, "the undated task is not in the popup");
  // Both stay tracked quietly, with no wake time attached.
  assert.equal(result.state.tasks.ad.dueMs, null);
  assert.equal(result.state.tasks.nd.dueMs, null);
  assert.equal(result.state.diag.quiet, 2);
});

test("a group that loses members to the closure check degrades to a single popup", async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const mcp = {
    ticktick: {
      async list_projects() { return JSON.stringify({ id: "p1", name: "Inbox", kind: "TASK" }); },
      async get_project_with_undone_tasks() {
        return JSON.stringify({ id: "p1", tasks: [
          { id: "g1", title: "Живая", dueDate: past, status: 0 },
          { id: "g2", title: "Закрытая", dueDate: past, status: 0 },
        ] });
      },
      async get_task_by_id(args) {
        return JSON.stringify({ id: args.task_id, title: args.task_id, dueDate: past, status: args.task_id === "g2" ? 2 : 0 });
      },
    },
  };
  const result = await run(mcp, { state: null, quiet: OPEN });
  assert.match(result.notify, /"task_id":"g1"/, "single-popup shape");
  assert.doesNotMatch(result.notify, /free_text/, "no longer the grouped shape");
  assert.doesNotMatch(result.notify, /g2/);
});
