/* ------------------------------------------------------------------ *
 * OpenClaw script-payload runtime for the reminder controller.
 * Generated into reminder-scan.js by bin/build-payload.mjs — do not
 * edit the generated file; edit reminder-core.mjs / this wrapper.
 *
 * Globals provided by the OpenClaw script-payload runtime:
 *   MCP.<server>.<tool>({...})  — configured MCP tool call (ticktick)
 *   trigger.state               — the state returned by the last good run
 * The returned object:
 *   { notify, wake:"now", state, nextCheck }  — deliver + rearm
 *   { state, nextCheck }                      — quiet tick
 * ------------------------------------------------------------------ */

// Tool names verified against mcp.ticktick.com (probe-tools.mjs, 2026-11-08).
// get_project_with_undone_tasks returns the project plus its open tasks in
// one call; closed tasks are absent, which the ledger treats as "leave".
const TOOL_NAMES = {
  listProjects: "list_projects",
  tasksOfProject: "get_project_with_undone_tasks",
  // Authoritative single-task read: the project list can answer with a
  // stale status 0 for a task the wearer already completed (seen
  // 2026-11-09), so popup candidates are re-checked through this.
  getTaskById: "get_task_by_id",
  // Account-wide fallback used for the virtual Inbox, whose list_projects id
  // ("inbox") may not resolve in project-scoped tools (real id is per-user,
  // e.g. "inbox128577262").
  undoneByTime: "list_undone_tasks_by_time_query",
};

const SCAN_CONFIG = {
  // Only remind about tasks in these project names (empty = all task lists).
  projects: [],
  // Skip projects of these kinds (TickTick has "note" lists alongside tasks).
  skipKinds: ["note"],
  // Only scan tasks due within this horizon (overdue included). The wearer's
  // list carries annual birthdays far in the future; loading them all just
  // churns the ledger cap. planScan drops ledger entries absent from the
  // scan, so a task re-enters with a fresh cycle when it nears the window.
  dueHorizonDays: 7,
  // Quiet hours, enforced inside the payload so the job needs no
  // --active-hours flags (older CLIs lack them). "system" = the server's own
  // clock; or set an IANA zone like "Europe/Moscow".
  quiet: { enabled: true, activeStart: "09:30", activeEnd: "22:30", timezone: "Europe/Moscow" },
};

/** snake_case -> camelCase: the code-mode runtime renames MCP tools. */
function toCamel(name) {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function mcpCall(tool, args) {
  // Literal `MCP.ticktick` on purpose: the payload runtime scans the script
  // text for server references to decide which MCP servers to start, and
  // optional chaining (MCP?.ticktick) may not match that scan.
  const server = typeof MCP === "object" && MCP ? MCP.ticktick : undefined;
  // The code-mode runtime exposes tools camelCased (list_projects ->
  // listProjects, verified 2026-11-09); try the exact name first, then the
  // camel form, so the payload works under either convention.
  const fn = server ? (server[tool] ?? server[toCamel(tool)]) : undefined;
  if (typeof fn !== "function") {
    // Dump the runtime shape: which servers exist, what kind of member the
    // tool is (function vs handle object), and a sample of its keys.
    const servers = MCP ? Object.keys(MCP) : [];
    const detail = server == null
      ? "server namespace absent"
      : typeof server !== "object"
        ? `namespace is ${typeof server}`
        : (() => {
            const keys = Object.keys(server);
            const member = server[tool];
            const memberType = typeof member;
            const memberKeys = member && typeof member === "object"
              ? Object.keys(member).slice(0, 12).join(",")
              : "";
            return `members(${keys.length})=[${keys.slice(0, 15).join(",")}] ${tool}:${memberType}${memberKeys ? ` keys=${memberKeys}` : ""}`;
          })();
    throw new Error(`MCP tool ticktick.${tool} unavailable; servers=[${servers.join(",")}] ${detail}`);
  }
  return fn(args ?? {});
}

/** Try an MCP call with each candidate argument shape; strict schemas
 * reject unknown keys, so the first shape that validates wins. */
async function mcpCallAny(tool, argShapes) {
  let lastError = null;
  for (const shape of argShapes) {
    try {
      return await mcpCall(tool, shape);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`ticktick.${tool} failed for every argument shape: ${lastError?.message ?? lastError}`);
}

async function main() {
  const nowMs = Date.now();
  // Quiet hours: the ledger keeps tracking, nothing fires, wake near the
  // window opening (capped so the job stays observable in run history).
  // trigger.quiet overrides SCAN_CONFIG — used by the test harness to pin the
  // window open; the production runtime never sets it.
  const window = activeWindow(nowMs, trigger?.quiet ?? SCAN_CONFIG.quiet);
  if (!window.active) {
    const wakeMs = Math.min(window.wakeMs, nowMs + 30 * 60_000);
    return {
      // Pass the ledger through untouched: re-running planScan with an empty
      // task list would prune every entry. The first active tick refreshes it.
      state: trigger?.state ?? { version: 1, lastScanAt: nowMs, tasks: {} },
      nextCheck: nextCheckDuration(wakeMs, nowMs),
    };
  }
  const projectsRaw = await mcpCall(TOOL_NAMES.listProjects, {});
  const skip = SCAN_CONFIG.skipKinds.map((k) => String(k).toUpperCase());
  let projects = normalizeProjects(projectsRaw)
    .filter((p) => p.closed !== true)
    .filter((p) => !skip.includes(String(p.kind).toUpperCase()));
  if (SCAN_CONFIG.projects.length) {
    const wanted = new Set(SCAN_CONFIG.projects);
    projects = projects.filter((p) => wanted.has(p.name));
  }
  const tasks = [];
  for (const project of projects) {
    const raw = await mcpCallAny(TOOL_NAMES.tasksOfProject, [
      { project_id: project.id },
      { projectId: project.id },
    ]);
    let rows = normalizeTasks(raw);
    // Virtual Inbox: the scoped call can answer empty for the "inbox" alias;
    // fall back to the account-wide undone-by-time queries (overdue window +
    // next week), deduped against everything already collected.
    const isInbox = /^inbox$/i.test(String(project.id)) || /inbox/i.test(String(project.name));
    if (!rows.length && isInbox) {
      const seen = new Set(tasks.map((t) => t.id));
      for (const q of ["last7day", "today", "next7day"]) {
        try {
          const wide = await mcpCallAny(TOOL_NAMES.undoneByTime, [
            { query_command: q },
            { queryCommand: q },
          ]);
          for (const t of normalizeTasks(wide)) {
            if (!seen.has(t.id)) { seen.add(t.id); tasks.push(t); }
          }
        } catch {
          /* one query shape failing must not kill the scan */
        }
      }
      continue;
    }
    tasks.push(...rows);
  }
  // Week horizon: keep everything without a date (tracked silently, cheap)
  // and anything due by the horizon; drop far-future dates (birthdays).
  const horizonMs = nowMs + SCAN_CONFIG.dueHorizonDays * 86_400_000;
  const scanned = tasks.filter((t) => t.dueMs === null || t.dueMs <= horizonMs);
  const plan = planScan(trigger?.state ?? null, scanned, nowMs);
  // Authoritative closure check before showing anything: drop popup
  // candidates get_task_by_id reports closed (the project list can keep
  // answering status 0 for them), and a group that lost members to the
  // check degrades to a single popup when one is left.
  if (plan.events.length) {
    const liveEvents = [];
    for (const event of plan.events) {
      const alive = [];
      for (const item of event.tasks ?? []) {
        let closed = false;
        try {
          const raw = await mcpCallAny(TOOL_NAMES.getTaskById, [
            { task_id: item.taskId },
            { taskId: item.taskId },
          ]);
          closed = normalizeTasks(raw).some((t) => t.id === String(item.taskId) && t.closed);
        } catch {
          // A failed check must not block the reminder: fail open.
        }
        if (closed) {
          delete plan.state.tasks[item.taskId];
          continue;
        }
        alive.push(item);
      }
      if (!alive.length) continue;
      liveEvents.push({ ...event, kind: alive.length === 1 ? "single" : event.kind, tasks: alive });
    }
    plan.events = liveEvents;
  }
  const nowIso = new Date(nowMs).toISOString();
  const result = {
    state: plan.state,
    nextCheck: nextCheckDuration(plan.nextCheckMs, nowMs),
  };
  // Self-observability: a compact scan summary rides along in the persisted
  // state (visible via `automations get`), so an empty scan is explainable
  // without redeploying anything.
  result.state.diag = {
    at: nowIso,
    projects: projects.map((p) => p.name),
    tasks: scanned.length,
    // Dates past the week horizon, hidden from the scan (mostly birthdays).
    beyondHorizon: tasks.length - scanned.length,
    withDue: scanned.filter((t) => t.dueMs).length,
    // Tracked quietly, never notified (no date, or all-day).
    quiet: scanned.filter((t) => !t.dueMs || t.allDay).length,
    closed: scanned.filter((t) => t.closed).length,
    events: plan.events.length,
    // Task titles the ledger gave up nagging about (status stale): visible
    // via `automations get` and carried into events for the courier.
    stale: Object.values(plan.state.tasks)
      .filter((e) => e.status === "stale")
      .map((e) => e.title)
      .slice(0, 10),
  };
  if (plan.events.length) {
    result.notify = renderEvent(plan.events[0]);
    result.wake = "now";
  }
  return result;
}

return await main();
