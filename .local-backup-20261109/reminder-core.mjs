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
 *
 * Popup policy (variant 2): one due task fires a classic single popup whose
 * voice answer is classified on the phone; two or more fire one grouped popup
 * whose answer is free text for the agent to interpret. Grouped candidates
 * share one fixed 5-minute retry ladder and one repeat budget.
 */

export const DEFAULTS = {
  /** Fire this many ms before the due date (0 = at the deadline). */
  leadMs: 0,
  /** Re-nag ladder after the first notification, in ms (single popups). */
  backoff: [5 * 60_000],
  /** Grouped popups always retry after this fixed delay, in ms. */
  groupBackoffMs: 5 * 60_000,
  /** After this many notifications without an answer, go stale. */
  maxRepeats: 5,
  /** Max task lines listed on one grouped popup; the rest are counted as "+N". */
  maxGroupItems: 5,
  /** Popup lifetime handed to glasses.reminder_show. */
  ttlMs: 60_000,
  /** nextCheck bounds, as durations the OpenClaw scheduler understands. */
  minNextCheck: "1m",
  maxNextCheck: "5m",
  /** Ledger cap; oldest stale/notified entries are pruned past it. */
  maxEntries: 100,
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
      const retryAt = entry.retryAtMs ?? entry.lastNotifiedAt + retryWait(entry, cfg);
      if (entry.repeat >= cfg.maxRepeats) {
        entry.status = "stale"; // nagged enough; wait for a task change
      } else if (nowMs >= retryAt) {
        entry.status = "due";
        if (fire) candidates.push({ task: entry, id: task.id });
      }
    }
  }

  // One popup per tick. Variant 2: a lone candidate fires a classic single
  // popup (the phone classifies its voice answer); two or more fire one
  // grouped popup whose answer is free text for the agent to interpret.
  // All grouped candidates are marked notified together and share the fixed
  // 5-minute group retry; each carries its own repeat counter, so the repeat
  // budget is effectively per group.
  if (candidates.length) {
    candidates.sort((a, b) => a.task.dueMs - b.task.dueMs);
    const group = candidates.length >= 2;
    const repeats = [];
    for (const c of candidates) {
      const entry = next.tasks[c.id];
      entry.status = "notified";
      entry.repeat += 1;
      entry.lastNotifiedAt = nowMs;
      entry.retryAtMs = group ? nowMs + cfg.groupBackoffMs : nowMs + retryWait(entry, cfg);
      repeats.push(entry.repeat);
    }
    const repeat = Math.max(...repeats);
    const items = candidates.map((c) => ({
      taskId: c.id,
      // The popup gets the untruncated title; the ledger keeps the clipped one.
      title: fullTitles.get(c.id) ?? c.task.title,
      dueMs: c.task.dueMs,
    }));
    // Deterministic ids: the same members and dues at the same attempt yield
    // the same id, so a retried delivery reuses the phone's open popup
    // instead of stacking a second one.
    const reminderId = group
      ? `g-${groupFingerprint(candidates)}-${repeat}`
      : `r-${candidates[0].id}-${candidates[0].task.dueMs}-${repeat}`;
    events.push({
      kind: group ? "group" : "single",
      reminderId,
      tasks: items,
      repeat,
      ttlMs: cfg.ttlMs,
    });
  }

  pruneLedger(next, cfg);
  fitStateBudget(next, cfg);
  // Stale = nagged out until the task itself changes. Invisible to the model
  // unless we say so: ride the list along in every event (free — it is code)
  // so the courier can ask about them in chat after the popup. Collected
  // after eviction so it matches what the ledger actually retains.
  const stale = [];
  for (const [id, entry] of Object.entries(next.tasks)) {
    if (entry.status === "stale") stale.push({ taskId: id, title: entry.title });
  }
  if (events.length) events[0].stale = stale;
  // Wake planning: the ledger's own retry times (single ladder or the fixed
  // group wait), plus every scanned deadline — including tasks the ledger
  // cap evicted, whose due time must still pull the next scan in.
  return {
    events,
    state: next,
    nextCheckMs: mergeWake(
      computeNextCheck(next, nowMs, cfg),
      soonestWake(wakeTimes, nowMs),
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
      when = entry.retryAtMs ?? entry.lastNotifiedAt + retryWait(entry, cfg);
    }
    if (when !== null && when > nowMs && (soonest === null || when < soonest)) soonest = when;
  }
  return soonest;
}

/** Single-popup retry delay for the attempt that was just made. */
function retryWait(entry, cfg) {
  return cfg.backoff[Math.min(entry.repeat - 1, cfg.backoff.length - 1)];
}

/** Stable short hash of the group members (ids+dues), for group reminder ids. */
function groupFingerprint(candidates) {
  const key = candidates
    .map((c) => `${c.id}:${c.task.dueMs}`)
    .sort()
    .join("|");
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Ledger eviction rank: lower = droppable first (stale, then old notified, then due). */
function ledgerRank(e) {
  // Drop plain "due" entries first: re-creating one costs nothing, while losing a
  // "notified" entry resets its repeat budget and losing a "stale" tombstone makes
  // the task resurrect and nag forever.
  const cls = e.status === "due" ? 0 : e.status === "notified" ? 1 : 2;
  return cls * 1e13 + (e.lastNotifiedAt || e.dueMs || 0);
}

function pruneLedger(state, cfg) {
  const ids = Object.keys(state.tasks);
  if (ids.length <= cfg.maxEntries) return;
  const rank = ledgerRank;
  const droppable = ids.sort((a, b) => rank(state.tasks[a]) - rank(state.tasks[b]));
  for (const id of droppable.slice(0, ids.length - cfg.maxEntries)) delete state.tasks[id];
}

/**
 * Render the system-event text for one event (v2). The skeleton is a machine
 * contract — tool name, ids, ttl, and the answer table are fixed. The one
 * thing the courier authors himself is the popup wording: the task titles
 * below are source material, and he renders them in his own voice (the
 * wearer asked for that) while keeping every task and its meaning intact.
 */
export function renderEvent(event, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const items = event.tasks ?? [];
  const single = event.kind !== "group";
  const out = [];
  out.push("REMINDER_EVENT v2 (courier script; the wording is yours, the procedure is not)");
  if (single) {
    out.push(
      `Call glasses.reminder_show with exactly these arguments (write "text" yourself, see rules):`,
      `{"reminder_id":${JSON.stringify(event.reminderId)},"task_id":${JSON.stringify(items[0].taskId)},"ttl_ms":${event.ttlMs}}`,
      `Source title: ${JSON.stringify(items[0].title)}; due ${new Date(items[0].dueMs).toISOString()}.`,
      `"text": rephrase the source title in your own voice (max 90 chars). Keep the task recognizable; never change, drop, or invent details.`,
      "Then process the JSON result:",
      `- action "done": complete the task in TickTick (complete_task).`,
      `- action "snooze" with minutes > 0: move the due date to now + minutes (update_task).`,
      `- action "snooze" with minutes 0 ("not now"): move the due date to now + 30 minutes.`,
      `- action "postpone": move the due date to tomorrow 09:00 local.`,
      `- action "other": the wearer's words are in "text"; act on them sensibly, TickTick is the source of truth.`,
      `- action "dismissed" / "expired" / "cancelled": do nothing; the controller re-notifies with backoff.`,
    );
  } else {
    const listed = items.slice(0, cfg.maxGroupItems);
    const extra = items.length - listed.length;
    out.push(
      `${items.length} tasks are due together. Call glasses.reminder_show with exactly these arguments (you compose "text", see rules):`,
      `{"reminder_id":${JSON.stringify(event.reminderId)},"free_text":true,"ttl_ms":${event.ttlMs}}`,
      `"text": one short intro line in your own voice + a numbered list of these tasks (keep each recognizable, max ~60 chars per line):`,
      ...listed.map((t, i) => `  ${i + 1}. ${t.title} (due ${new Date(t.dueMs).toISOString()})`),
      ...(extra > 0 ? [`  (+${extra} more due, not listed)`] : []),
      "The popup collects a free-spoken answer (no command classification on glasses). Then process the JSON result:",
      `- action "other" with the wearer's words in "text": map them onto the listed tasks and act in TickTick (complete_task / update_task). If the answer is ambiguous, ask one clarifying question in chat, never on the glasses.`,
      `- action "dismissed" / "expired" / "cancelled": do nothing; the controller re-notifies the group in ${Math.round(cfg.groupBackoffMs / 60_000)} minutes.`,
      "Task ids, in list order: " + items.map((t) => t.taskId).join(", ") + ".",
    );
  }
  const stale = event.stale ?? [];
  if (stale.length) {
    out.push(
      `STALE (nagged to the limit, quiet until the wearer decides): ${stale
        .slice(0, cfg.maxGroupItems)
        .map((t, i) => `${i + 1}. ${t.title}`)
        .join(" ")}` + (stale.length > cfg.maxGroupItems ? ` (+${stale.length - cfg.maxGroupItems} more)` : ""),
      "If this list is non-empty: after processing the popup answer, ask in chat once what to do with these tasks (complete / reschedule / delete). One question per event; if the wearer declines or ignores it, do not bring this set up again.",
    );
  }
  out.push("Do not call any other glasses tool in this turn.");
  return out.join("\n");
}

/** nextCheckMs -> the nearest scheduler duration string within bounds. */
export function nextCheckDuration(nextCheckMs, nowMs, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  if (nextCheckMs === null) return cfg.maxNextCheck;
  const minutes = Math.max(1, Math.round((nextCheckMs - nowMs) / 60_000));
  const maxMinutes = /m$/.test(cfg.maxNextCheck) ? parseInt(cfg.maxNextCheck, 10) : 30;
  return `${Math.min(minutes, maxMinutes)}m`;
}
