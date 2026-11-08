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
  maxNextCheck: "5m",
  /** Ledger cap; oldest stale/notified entries are pruned past it. */
  maxEntries: 60,
  /** Hard budget for the persisted state (OpenClaw caps it at 16 KB). */
  stateBudgetBytes: 14_000,
  /** Ledger titles are clipped to this length (the popup keeps the full one). */
  maxTitleChars: 60,
};

/**
 * Parse an MCP tool payload. The official TickTick server returns either a
 * structured object/array or plain text holding newline-delimited JSON
 * objects (one record per line, verified against mcp.ticktick.com), and the
 * MCP envelope may wrap either. Every shape seen so far funnels through here.
 */
/**
 * Extract top-level JSON objects/arrays from a text blob by brace matching
 * (string- and escape-aware). Handles the real server's shapes: one pretty-
 * printed object, several pretty-printed objects concatenated (list_projects),
 * or single-line JSONL. Returns [] when nothing parses.
 */
function extractJsonValues(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; continue; }
    if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          /* not JSON after all; keep scanning */
        }
        start = -1;
      } else if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }
  return out;
}

export function parseToolPayload(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Whole-string JSON first: pretty-printed multi-line JSON must survive.
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        /* multiple concatenated values; fall through to extraction */
      }
    }
    const rows = extractJsonValues(trimmed);
    if (!rows.length) return null;
    return rows.length === 1 ? rows[0] : rows;
  }
  if (typeof value !== "object") return null;
  // MCP result envelope: { content: [{type:"text",text}], structuredContent }
  if (Array.isArray(value.content) || value.structuredContent !== undefined) {
    const texts = (value.content ?? [])
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text);
    if (texts.length) return parseToolPayload(texts.join("\n"));
    return value.structuredContent ?? null;
  }
  return value;
}

/** Unwrap a project-detail payload: tasks may sit under project.tasks or tasks. */
function taskRows(payload) {
  const parsed = parseToolPayload(payload);
  if (Array.isArray(parsed)) {
    // Rows may be project-detail objects (expand their tasks) or bare tasks.
    if (parsed.some((item) => item && Array.isArray(item.tasks))) {
      return parsed.flatMap((item) => taskRows(item) ?? []);
    }
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.tasks)) return parsed.tasks;
    if (parsed.project && Array.isArray(parsed.project.tasks)) return parsed.project.tasks;
    // Envelope wrappers: {result:{tasks:[...]}}, {data:{tasks:[...]}}.
    for (const key of ["result", "data"]) {
      const inner = parsed[key];
      if (inner && typeof inner === "object") {
        const rows = taskRows(inner);
        if (rows) return rows;
      }
    }
    // A bare task object as the whole answer.
    if (parsed.id !== undefined && (parsed.title !== undefined || parsed.content !== undefined)) {
      return [parsed];
    }
  }
  return null;
}

function projectRows(payload) {
  const parsed = parseToolPayload(payload);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const key of ["projects", "result", "data"]) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
    // A single project object (one JSONL line, or the whole answer).
    if (parsed.id !== undefined || parsed.name !== undefined) return [parsed];
  }
  return [];
}

/**
 * Normalize the MCP tool response for one project's tasks into the ledger's
 * shape. Defensive about field names: the official server's payloads have
 * varied across versions, so every plausible spelling is tried.
 */
export function normalizeTasks(raw) {
  const list = taskRows(raw) ?? [];
  const out = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const id = t.id ?? t.taskId ?? t.uid;
    if (id === undefined || id === null) continue;
    const status = t.status ?? t.state ?? 0;
    // Only explicit closed markers count. A stale completedTime must NOT
      // close a task: TickTick keeps it on some open tasks, and a false
      // "closed" silently deletes the ledger entry (missed reminders).
    const closed = status === 2 || status === "completed" || status === "done" || t.completed === true;
    const dueRaw = t.dueDate ?? t.due ?? t.dueAt ?? t.due_time ?? null;
    const dueMs = dueRaw ? Date.parse(dueRaw) : NaN;
    const fullTitle = String(t.title ?? t.name ?? t.content ?? "(task)");
    out.push({
      id: String(id),
      title: fullTitle,
      dueMs: Number.isFinite(dueMs) ? dueMs : null,
      closed,
    });
  }
  return out;
}

/** Same for list_projects. */
export function normalizeProjects(raw) {
  const list = projectRows(raw);
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
  // fire === false: quiet hours. The ledger updates normally, but nothing is
  // queued for notification and nothing is marked notified.
  const fire = cfg.fire !== false;
  const prev = state?.tasks ?? {};
  const next = { version: 1, lastScanAt: nowMs, tasks: {} };
  const events = [];
  const candidates = [];
  const fullTitles = new Map();
  // Wake times for every tracked deadline, independent of ledger eviction:
  // a task dropped from the ledger by the cap/budget must still pull the next
  // scan toward its due time, or the popup would arrive late.
  const wakeTimes = [];

  for (const task of tasks) {
    const old = prev[task.id];
    let entry;
    if (task.closed) continue; // closed elsewhere: ledger entry simply gone
    fullTitles.set(task.id, task.title);
    if (task.dueMs) wakeTimes.push(task.dueMs - cfg.leadMs);
    if (!task.dueMs) {
      // Deadline removed: keep tracking quietly, no reminder without a date.
      entry = { title: clipTitle(task.title, cfg.maxTitleChars), dueMs: null, status: "due", repeat: 0, lastNotifiedAt: 0 };
      next.tasks[task.id] = entry;
      continue;
    }
    const dueChanged = !old || old.dueMs !== task.dueMs;
    if (dueChanged) {
      entry = { title: clipTitle(task.title, cfg.maxTitleChars), dueMs: task.dueMs, status: "due", repeat: 0, lastNotifiedAt: 0 };
    } else {
      entry = { ...old, title: clipTitle(task.title, cfg.maxTitleChars) };
    }
    next.tasks[task.id] = entry;

    const fireAt = entry.dueMs - cfg.leadMs;
    if (fire && entry.status === "due" && nowMs >= fireAt) {
      candidates.push({ task: entry, id: task.id });
    } else if (entry.status === "notified") {
      const wait = cfg.backoff[Math.min(entry.repeat - 1, cfg.backoff.length - 1)];
      const retryAt = entry.lastNotifiedAt + wait;
      if (entry.repeat >= cfg.maxRepeats) {
        entry.status = "stale"; // nagged enough; wait for a task change
      } else if (nowMs >= retryAt) {
        entry.status = "due";
        if (fire) candidates.push({ task: entry, id: task.id });
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
      // The popup gets the untruncated title; the ledger keeps the clipped one.
      title: fullTitles.get(pick.id) ?? entry.title,
      dueMs: entry.dueMs,
      repeat: entry.repeat,
      ttlMs: cfg.ttlMs,
    });
  }

  pruneLedger(next, cfg);
  fitStateBudget(next, cfg);
  // Candidates left in the queue (one popup per tick, most overdue first) or
  // a fired popup whose repeats ride the backoff ladder must pull the next
  // scan in early; task deadlines the ledger could not hold still count too.
  const queueWake = candidates.length > (events.length ? 1 : 0)
    ? nowMs + parseDurationMs(cfg.minNextCheck, 60_000)
    : null;
  return {
    events,
    state: next,
    nextCheckMs: mergeWake(
      mergeWake(
        computeNextCheck(next, nowMs, cfg),
        soonestWake(wakeTimes, nowMs),
      ),
      queueWake,
    ),
  };
}

/** "15m" / "4h" -> ms; anything unparseable falls back to the default. */
function parseDurationMs(value, fallbackMs) {
  const m = /^(\d+)([mh])$/.exec(String(value ?? ""));
  if (!m) return fallbackMs;
  return Number(m[1]) * (m[2] === "h" ? 3_600_000 : 60_000);
}

/** The earliest wake time strictly after now, or null. */
function soonestWake(times, nowMs) {
  let soonest = null;
  for (const t of times) {
    if (t > nowMs && (soonest === null || t < soonest)) soonest = t;
  }
  return soonest;
}

function mergeWake(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function clipTitle(title, max) {
  return title.length > max ? `${title.slice(0, Math.max(1, max - 1))}…` : title;
}

const utf8Encoder = new TextEncoder();
function stateBytes(state) {
  return utf8Encoder.encode(JSON.stringify(state)).length;
}

/**
 * Hard cap on the persisted state (OpenClaw rejects >16 KB). Entries are
 * dropped lowest-rank first — the freshest due/notified ones survive, so a
 * huge task list degrades to "remind about what matters" instead of failing
 * the whole run.
 */
function fitStateBudget(state, cfg) {
  const rank = ledgerRank;
  while (stateBytes(state) > cfg.stateBudgetBytes) {
    const ids = Object.keys(state.tasks);
    if (!ids.length) break;
    ids.sort((a, b) => rank(state.tasks[a]) - rank(state.tasks[b]));
    delete state.tasks[ids[0]];
  }
}

/** Minutes since local midnight for `nowMs` in IANA zone `tz`. */
export function localDayMinutes(nowMs, tz) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(nowMs));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Quiet-window gate: reminders may fire between activeStart and activeEnd
 * (local wall clock in `timezone`). Returns { active: true } or
 * { active: false, wakeMs } with wakeMs = the next window opening. A
 * malformed config opens the window (fail-open: silence is worse than noise).
 */
export function activeWindow(nowMs, quiet) {
  if (!quiet?.enabled) return { active: true };
  const start = parseClock(quiet.activeStart);
  const end = parseClock(quiet.activeEnd);
  if (start === null || end === null || start >= end) return { active: true };
  const tz = quiet.timezone && quiet.timezone !== "system"
    ? quiet.timezone
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = localDayMinutes(nowMs, tz);
  if (now >= start && now < end) return { active: true };
  // Local midnight instant, then jump to the next activeStart. DST shift days
  // can be off by an hour; the next tick re-evaluates, so it self-corrects.
  const midnight = nowMs - now * 60_000;
  let wakeMs = midnight + start * 60_000;
  if (wakeMs <= nowMs) wakeMs += 86_400_000;
  return { active: false, wakeMs };
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

/** Ledger eviction rank: lower = droppable first (stale, then old notified, then due). */
function ledgerRank(e) {
  return (e.status === "stale" ? 0 : e.status === "notified" ? 1 : 2) * 1e13
    + (e.lastNotifiedAt || e.dueMs || 0);
}

function pruneLedger(state, cfg) {
  const ids = Object.keys(state.tasks);
  if (ids.length <= cfg.maxEntries) return;
  const rank = ledgerRank;
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
