# Nano + TickTick hybrid reminders

Routine reminders now use the Android notification that TickTick posts itself.
Faceclaw mirrors that notification to Even G2 and handles deterministic
controls locally. Nano joins only when a spoken command needs TickTick MCP or a
conversation.

The old polling controller is retained in this repository for history and
rollback, but must not be deployed or enabled for the hybrid setup.

## Runtime ownership

- **TickTick Android app** — schedules and posts ordinary task notifications.
- **Faceclaw** — recognizes TickTick notifications, shows the custom G2
  window, completes via TickTick's notification action, snoozes through
  Android, and captures speech with the configured local streaming STT.
- **Nano** — handles complex/ambiguous commands delivered as a normal chat
  message and uses the official TickTick MCP tools to change tasks.
- **OpenClaw Automations** — may still run explicit one-shot reminders created
  for a user request or a concrete promise. They do not scan TickTick.

This prevents the old duplicate path:

`TickTick notification + nano-reminder-scan -> REMINDER_EVENT -> second popup`

## Files

| Path | Status |
|---|---|
| `openclaw/AGENTS.reminder.md` | Current standing policy; append/merge it into Nano's AGENTS.md |
| `openclaw/mcp-config.snippet.json5` | Current TickTick MCP configuration; keep it enabled |
| `openclaw/reminder-core.mjs` | Legacy polling controller; do not deploy for hybrid mode |
| `openclaw/payload-wrapper.js` | Legacy polling wrapper; do not deploy for hybrid mode |
| `openclaw/reminder-scan.js` | Legacy generated payload; disable its automation |
| `bin/build-payload.mjs` | Legacy payload builder, kept only for rollback/history |
| `test/*.test.mjs` | Tests for the retained legacy controller |

## Migrate an existing OpenClaw host

### 1. Disable routine scanning

Find the stored job, then disable it by id:

```sh
openclaw automations list --all
openclaw automations disable <job-id-of-nano-reminder-scan>
openclaw automations show <job-id-of-nano-reminder-scan>
```

`show` must report the job as disabled. Disabling is preferred for the first
rollout because it preserves an easy rollback. After the hybrid path has been
accepted, it is safe to remove the obsolete job:

```sh
openclaw automations remove <job-id-of-nano-reminder-scan>
```

Do not deploy `openclaw/reminder-scan.js` again. A Gateway restart is not
required merely to disable a stored automation.

### 2. Replace the old Nano standing order

Remove the previous `REMINDER_EVENT v2` courier section from Nano's live
AGENTS.md. Append or merge the current `openclaw/AGENTS.reminder.md` instead.
There must be no remaining instruction to:

- poll TickTick periodically;
- call `glasses.reminder_show` for every due TickTick task;
- ask about today's undated/all-day tasks;
- process stale-ledger or grouped scan events.

Restart/reload the agent only if your OpenClaw deployment requires it after an
AGENTS.md edit.

### 3. Keep TickTick MCP

Do not remove the `ticktick` MCP server or its token. Nano still needs it for
voice-created tasks, listing, editing, completion, rescheduling and complex
commands forwarded by Faceclaw. `openclaw/mcp-config.snippet.json5` remains the
reference configuration.

### 4. Keep explicit one-shot reminders

Nano may create a one-shot automation when the wearer asks to be reminded or a
concrete promise needs a follow-up. A CLI equivalent is:

```sh
openclaw automations create "2026-12-01T16:00:00Z" \
  --name "One-shot reminder" \
  --session main \
  --system-event "Remind the wearer about the explicitly requested commitment" \
  --wake now \
  --delete-after-run
```

The agent's automation tool may create the same job directly. The event may
call `glasses.reminder_show` once. It must not enumerate TickTick or become a
recurring job.

## Acceptance checklist

1. `openclaw automations list --all` shows `nano-reminder-scan` disabled or
   absent.
2. A TickTick task with a due reminder produces exactly one Android
   notification and one G2 window.
3. Completing or snoozing it locally does not start a Nano turn.
4. A complex voice command opens the ordinary Faceclaw chat and Nano resolves
   the task through TickTick MCP, asking for clarification when necessary.
5. Conversational TickTick creation/list/edit still works.
6. An explicitly requested one-shot Nano reminder still fires once and then
   deletes its automation.

## Legacy controller tests

The retained scanner remains testable for rollback integrity, although it is
not part of the hybrid runtime:

```sh
node --test test/
```
