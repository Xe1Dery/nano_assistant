/**
 * Reminder controller core — pure, deterministic logic, no I/O.
 *
 * The TickTick task list is the source of truth for what exists and when it
 * is due. This module owns only the *notification ledger*: which task was
 * notified when, how many times, and when it may nag again. It decides, for
 * one scan of the task list, which single reminder (if any) to fire now and
 * what the next useful scan time is.
 *
 * Statuses per task:
 *   due       — deadline reached (or passed), not yet notified this cycle
 *   notified  — popup was shown; repeats follow the backoff ladder
 *   stale     — repeated too many times with no answer; quiet until the task
 *               itself changes (a new due date resets it to due)
 * A closed or vanished task simply loses its ledger entry.
 */

export const DEFAULTS = {
  /** Fire this many ms before the due date (0 = at the deadline). */
  leadMs: 0,
  /** Re-nag ladder after the first notification, in ms. */
  backoff: [5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 3600_000],
  /** After this many notifications without an answer, go stale. */
  maxRepeats: 5,
  /** Popup lifetime handed to glasses.reminder_show. */
  ttlMs: 60_000,
  /** nextCheck bounds, as durations the OpenClaw scheduler understands. */
  minNextCheck: "1m",
  maxNextCheck: "30m",
  /** Ledger cap; oldest stale/notified entries are pruned past it. */
  maxEntries: 200,
};

/**
 * Normalize the MCP tool response for one project's tasks into the ledger's
 * shape. Defensive about field names: the official server's payloads have
 * varied across versions, so every plausible spelling is tried.
 */
export function normalizeTasks(raw) {
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw?.tasks) ? raw.tasks
    : Array.isArray(raw?.result) ? raw.result
    : Array.isArray(raw?.data) ? raw.data
    : [];
  const out = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const id = t.id ?? t.taskId ?? t.uid;
    if (id === undefined || id === null) continue;
    const status = t.status ?? t.state ?? 0;
    const closed = status === 2 || status === "completed" || status === "done"
      || t.completed === true || Boolean(t.completedTime);
    const dueRaw = t.dueDate ?? t.due ?? t.dueAt ?? t.due_time ?? null;
    const dueMs = dueRaw ? Date.parse(dueRaw) : NaN;
    out.push({
      id: String(id),
      title: String(t.title ?? t.name ?? t.content ?? "(task)"),
      dueMs: Number.isFinite(dueMs) ? dueMs : null,
      closed,
    });
  }
  return out;
}

/** Same for list_projects. */
export function normalizeProjects(raw) {
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw?.projects) ? raw.projects
    : Array.isArray(raw?.result) ? raw.result
    : Array.isArray(raw?.data) ? raw.data
    : [];
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const id = p.id ?? p.projectId ?? p.name;
    if (id === undefined || id === null) continue;
    out.push({ id: String(id), name: String(p.name ?? p.title ?? id), kind: p.kind ?? p.type ?? "tasks" });
  }
  return out;
}

/**
 * Plan one scan.
 *  state  — previous ledger ({tasks:{...}}) or null on first run
 *  tasks  — normalized open+closed tasks from normalizeTasks (open only is fine)
 *  nowMs  — current epoch ms
 * Returns { events, state, nextCheckMs|null }:
 *  events      — 0..1 reminders to deliver now: {reminderId, taskId, title, dueMs, repeat}
 *  state       — the new ledger to persist
 *  nextCheckMs — when the next scan has work; null = nothing pending
 */
export function planScan(state, tasks, nowMs, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const prev = state?.tasks ?? {};
  const next = { version: 1, lastScanAt: nowMs, tasks: {} };
  const events = [];
  const candidates = [];

  for (const task of tasks) {
    const old = prev[task.id];
    let entry;
    if (task.closed) continue; // closed elsewhere: ledger entry simply gone
    if (!task.dueMs) {
      // Deadline removed: keep tracking quietly, no reminder without a date.
      entry = { title: task.title, dueMs: null, status: "due", repeat: 0, lastNotifiedAt: 0 };
      next.tasks[task.id] = entry;
      continue;
    }
    const dueChanged = !old || old.dueMs !== task.dueMs;
    if (dueChanged) {
      entry = { title: task.title, dueMs: task.dueMs, status: "due", repeat: 0, lastNotifiedAt: 0 };
    } else {
      entry = { ...old, title: task.title };
    }
    next.tasks[task.id] = entry;

    const fireAt = entry.dueMs - cfg.leadMs;
    if (entry.status === "due" && nowMs >= fireAt) {
      candidates.push({ task: entry, id: task.id });
    } else if (entry.status === "notified") {
      const wait = cfg.backoff[Math.min(entry.repeat - 1, cfg.backoff.length - 1)];
      const retryAt = entry.lastNotifiedAt + wait;
      if (entry.repeat >= cfg.maxRepeats) {
        entry.status = "stale"; // nagged enough; wait for a task change
      } else if (nowMs >= retryAt) {
        entry.status = "due";
        candidates.push({ task: entry, id: task.id });
      }
    }
  }

  // One popup per tick, the most overdue first; the rest wait for the next scan.
  if (candidates.length) {
    candidates.sort((a, b) => a.task.dueMs - b.task.dueMs);
    const pick = candidates[0];
    const entry = next.tasks[pick.id];
    entry.status = "notified";
    entry.repeat += 1;
    entry.lastNotifiedAt = nowMs;
    // Deterministic id: same task+due+attempt => same id, so a retried
    // delivery reuses the phone's open popup instead of stacking a second.
    const reminderId = `r-${pick.id}-${entry.dueMs}-${entry.repeat}`;
    events.push({
      reminderId,
      taskId: pick.id,
      title: entry.title,
      dueMs: entry.dueMs,
      repeat: entry.repeat,
      ttlMs: cfg.ttlMs,
    });
  }

  pruneLedger(next, cfg);
  return { events, state: next, nextCheckMs: computeNextCheck(next, nowMs, cfg) };
}

/** Earliest moment any ledger entry wants attention, or null. */
export function computeNextCheck(state, nowMs, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  let soonest = null;
  for (const entry of Object.values(state.tasks)) {
    let when = null;
    if (entry.status === "due" && entry.dueMs) when = entry.dueMs - cfg.leadMs;
    else if (entry.status === "notified") {
      const wait = cfg.backoff[Math.min(entry.repeat - 1, cfg.backoff.length - 1)];
      when = entry.lastNotifiedAt + wait;
    }
    if (when !== null && when > nowMs && (soonest === null || when < soonest)) soonest = when;
  }
  return soonest;
}

function pruneLedger(state, cfg) {
  const ids = Object.keys(state.tasks);
  if (ids.length <= cfg.maxEntries) return;
  const rank = (e) =>
    (e.status === "stale" ? 0 : e.status === "notified" ? 1 : 2) * 1e13
    + (e.lastNotifiedAt || e.dueMs || 0);
  const droppable = ids.sort((a, b) => rank(state.tasks[a]) - rank(state.tasks[b]));
  for (const id of droppable.slice(0, ids.length - cfg.maxEntries)) delete state.tasks[id];
}

/**
 * Render the system-event text for one event. This is a machine instruction
 * for the agent-courier: exact tool, exact arguments, and the fixed table of
 * what to do with the answer. The agent must not improvise any of it.
 */
export function renderEvent(event) {
  const due = new Date(event.dueMs).toISOString();
  return [
    "REMINDER_EVENT v1 (deterministic; you are a courier, do not improvise)",
    `Call the Faceclaw tool glasses.reminder_show with EXACTLY these arguments:`,
    `{"reminder_id":${JSON.stringify(event.reminderId)},"task_id":${JSON.stringify(event.taskId)},"text":${JSON.stringify(event.title)},"ttl_ms":${event.ttlMs}}`,
    "Then process the JSON result it returns:",
    `- action "done": mark the task completed in TickTick (complete_task).`,
    `- action "snooze" with minutes > 0: update the task's due date to now + minutes (update_task).`,
    `- action "snooze" with minutes 0 (the wearer said "not now"): update the due date to now + 30 minutes.`,
    `- action "postpone": update the due date to tomorrow 09:00 local time.`,
    `- action "other": the wearer's words are in "text"; act on them sensibly (reschedule, complete, or just acknowledge).`,
    `- action "dismissed" / "expired" / "cancelled": do nothing; the controller will re-notify with backoff.`,
    `Task due at ${due}. Do not rephrase the reminder text. Do not call any other glasses tool.`,
  ].join("\n");
}

/** nextCheckMs -> the nearest scheduler duration string within bounds. */
export function nextCheckDuration(nextCheckMs, nowMs, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  if (nextCheckMs === null) return cfg.maxNextCheck;
  const minutes = Math.max(1, Math.round((nextCheckMs - nowMs) / 60_000));
  const maxMinutes = /m$/.test(cfg.maxNextCheck) ? parseInt(cfg.maxNextCheck, 10) : 30;
  return `${Math.min(minutes, maxMinutes)}m`;
}
