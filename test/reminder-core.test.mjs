import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS,
  normalizeTasks,
  normalizeProjects,
  planScan,
  computeNextCheck,
  renderEvent,
  nextCheckDuration,
} from "../openclaw/reminder-core.mjs";

const T0 = Date.parse("2026-11-09T10:00:00Z");
const min = (m) => m * 60_000;

function task(id, title, dueMs, extra = {}) {
  return { id, title, dueMs, closed: false, ...extra };
}

test("first scan: due task fires exactly one event and enters the ledger as notified", () => {
  const tasks = [task("a", "Позвонить клиенту", T0 - min(1))];
  const plan = planScan(null, tasks, T0);
  assert.equal(plan.events.length, 1);
  const ev = plan.events[0];
  assert.equal(ev.taskId, "a");
  assert.equal(ev.title, "Позвонить клиенту");
  assert.equal(ev.repeat, 1);
  assert.match(ev.reminderId, /^r-a-/);
  assert.equal(plan.state.tasks.a.status, "notified");
  assert.equal(plan.state.tasks.a.lastNotifiedAt, T0);
});

test("future deadline does not fire; nextCheck points at it", () => {
  const due = T0 + min(7);
  const plan = planScan(null, [task("a", "x", due)], T0);
  assert.equal(plan.events.length, 0);
  assert.equal(plan.state.tasks.a.status, "due");
  assert.equal(plan.nextCheckMs, due);
  assert.equal(nextCheckDuration(plan.nextCheckMs, T0), "7m");
});

test("nextCheck clamps to the configured maximum", () => {
  const due = T0 + min(120);
  const plan = planScan(null, [task("a", "x", due)], T0);
  assert.equal(nextCheckDuration(plan.nextCheckMs, T0), "30m");
});

test("re-notification follows the backoff ladder", () => {
  const due = T0 - min(1);
  const tasks = [task("a", "x", due)];
  let plan = planScan(null, tasks, T0); // fires #1 at T0
  // A tick right after: still inside the 5-minute backoff, nothing fires.
  let next = planScan(plan.state, tasks, T0 + min(2));
  assert.equal(next.events.length, 0);
  assert.equal(next.state.tasks.a.status, "notified");
  // After the first backoff step: fires #2.
  next = planScan(plan.state, tasks, T0 + min(6));
  assert.equal(next.events.length, 1);
  assert.equal(next.state.tasks.a.repeat, 2);
  // Second step is 15 minutes: quiet at +10 from fire #2, fires at +16.
  assert.equal(planScan(next.state, tasks, T0 + min(6) + min(10)).events.length, 0);
  assert.equal(planScan(next.state, tasks, T0 + min(6) + min(16)).events.length, 1);
});

test("too many repeats goes stale and stays quiet until the task changes", () => {
  const due = T0 - min(1);
  const tasks = [task("a", "x", due)];
  let state = null;
  let now = T0;
  for (let i = 0; i < DEFAULTS.maxRepeats; i++) {
    const plan = planScan(state, tasks, now);
    assert.equal(plan.events.length, 1, `firing #${i + 1}`);
    state = plan.state;
    now += min(600); // jump past any backoff step
  }
  // The 6th eligible evaluation flips it to stale (no event), then forever quiet.
  const stale = planScan(state, tasks, now);
  assert.equal(stale.events.length, 0);
  assert.equal(stale.state.tasks.a.status, "stale");
  const later = planScan(stale.state, tasks, now + min(10_000));
  assert.equal(later.events.length, 0);
  assert.equal(later.state.tasks.a.status, "stale");
  // A new due date revives it (in the future: revived, not instantly fired).
  const revived = planScan(stale.state, [task("a", "x", now + min(10))], now);
  assert.equal(revived.state.tasks.a.status, "due");
  assert.equal(revived.state.tasks.a.dueMs, now + min(10));
  assert.equal(revived.events.length, 0);
});

test("a changed due date resets the cycle; a closed task leaves the ledger", () => {
  const tasks = [task("a", "x", T0 - min(1))];
  const fired = planScan(null, tasks, T0);
  // Snoozed via TickTick: same task, later date, ledger resets to due.
  const moved = planScan(fired.state, [task("a", "x", T0 + min(10))], T0);
  assert.equal(moved.state.tasks.a.status, "due");
  assert.equal(moved.state.tasks.a.repeat, 0);
  // Completed elsewhere: entry gone, no events.
  const closed = planScan(moved.state, [{ id: "a", title: "x", dueMs: T0 + min(10), closed: true }], T0);
  assert.equal(closed.state.tasks.a, undefined);
  assert.equal(closed.events.length, 0);
});

test("one popup per tick, most overdue first; the rest wait", () => {
  const tasks = [
    task("b", "later", T0 - min(5)),
    task("c", "sooner", T0 - min(30)),
    task("d", "future", T0 + min(60)),
  ];
  const plan = planScan(null, tasks, T0);
  assert.equal(plan.events.length, 1);
  assert.equal(plan.events[0].taskId, "c");
  assert.equal(plan.state.tasks.b.status, "due");
  assert.equal(plan.state.tasks.d.status, "due");
});

test("reminderId is deterministic per task+due+attempt", () => {
  const tasks = [task("a", "x", T0 - min(1))];
  const p1 = planScan(null, tasks, T0);
  const p2 = planScan(null, tasks, T0);
  assert.equal(p1.events[0].reminderId, p2.events[0].reminderId);
  const p3 = planScan(p1.state, tasks, T0 + min(600));
  assert.notEqual(p3.events[0].reminderId, p1.events[0].reminderId);
});

test("tasks without a due date are tracked but never fire", () => {
  const plan = planScan(null, [task("a", "someday", null)], T0);
  assert.equal(plan.events.length, 0);
  assert.equal(plan.state.tasks.a.status, "due");
  assert.equal(plan.nextCheckMs, null);
});

test("normalizeTasks survives the field-name variants and marks closed", () => {
  const rows = normalizeTasks({
    tasks: [
      { id: "1", title: "a", dueDate: "2026-11-09T12:00:00.000+0000", status: 0 },
      { id: "2", title: "b", due: "2026-11-09T12:00:00Z", status: 2 },
      { taskId: "3", name: "c", completedTime: "2026-11-08T10:00:00Z" },
      { id: "4", title: "no date" },
      null,
      { title: "no id" },
    ],
  });
  assert.equal(rows.length, 4);
  assert.equal(rows[0].dueMs, Date.parse("2026-11-09T12:00:00.000+0000"));
  assert.equal(rows[1].closed, true);
  assert.equal(rows[2].closed, true);
  assert.equal(rows[2].id, "3");
  assert.equal(rows[3].dueMs, null);
});

test("normalizeProjects handles arrays and wrappers", () => {
  assert.deepEqual(
    normalizeProjects({ projects: [{ id: 7, name: "Inbox", kind: "TASK" }] }),
    [{ id: "7", name: "Inbox", kind: "TASK" }],
  );
  assert.deepEqual(normalizeProjects([]), []);
});

test("a task list past the cap keeps the freshest entries and revives stale on due change", () => {
  // 230 open tasks with due dates: the ledger caps at maxEntries.
  const tasks = [];
  for (let i = 0; i < DEFAULTS.maxEntries + 30; i++) tasks.push(task(`t${i}`, "x", T0 + min(i)));
  const plan = planScan(null, tasks, T0);
  assert.ok(Object.keys(plan.state.tasks).length <= DEFAULTS.maxEntries);
  // Stale is not terminal: a changed due date revives the cycle.
  const staleState = { tasks: { a: { title: "x", dueMs: T0 - min(1), status: "stale", repeat: 9, lastNotifiedAt: T0 } } };
  const revived = planScan(staleState, [task("a", "x", T0 + min(10))], T0);
  assert.equal(revived.state.tasks.a.status, "due");
  assert.equal(revived.state.tasks.a.repeat, 0);
});

test("renderEvent carries exact JSON arguments and the courier contract", () => {
  const text = renderEvent({
    reminderId: 'r-a-1"2', taskId: 'a\\b', title: 'Позвонить "клиенту"', dueMs: T0, ttlMs: 60_000, repeat: 1,
  });
  assert.match(text, /REMINDER_EVENT v1/);
  assert.match(text, /glasses\.reminder_show/);
  // The arguments line must be valid JSON even with quotes in the values.
  const line = text.split("\n").find((l) => l.trim().startsWith("{"));
  const args = JSON.parse(line);
  assert.equal(args.reminder_id, 'r-a-1"2');
  assert.equal(args.task_id, 'a\\b');
  assert.equal(args.text, 'Позвонить "клиенту"');
  assert.equal(args.ttl_ms, 60_000);
});

test("computeNextCheck ignores stale and null-due entries", () => {
  const state = {
    tasks: {
      a: { status: "stale", dueMs: T0, lastNotifiedAt: T0, repeat: 1 },
      b: { status: "due", dueMs: null, lastNotifiedAt: 0 },
      c: { status: "due", dueMs: T0 + min(3), lastNotifiedAt: 0 },
    },
  };
  assert.equal(computeNextCheck(state, T0), T0 + min(3));
});
