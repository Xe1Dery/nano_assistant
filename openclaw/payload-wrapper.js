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
};

const SCAN_CONFIG = {
  // Only remind about tasks in these project names (empty = all task lists).
  projects: [],
  // Skip projects of these kinds (TickTick has "note" lists alongside tasks).
  skipKinds: ["note"],
};

function mcpCall(tool, args) {
  const fn = MCP?.ticktick?.[tool];
  if (typeof fn !== "function") {
    throw new Error(`MCP tool ticktick.${tool} unavailable; check the job's --tools and the probe output`);
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
    tasks.push(...normalizeTasks(raw));
  }
  const plan = planScan(trigger?.state ?? null, tasks, nowMs);
  const result = {
    state: plan.state,
    nextCheck: nextCheckDuration(plan.nextCheckMs, nowMs),
  };
  if (plan.events.length) {
    result.notify = renderEvent(plan.events[0]);
    result.wake = "now";
  }
  return result;
}

return await main();
