# Nano reminder controller (TickTick <-> Faceclaw glasses)

Reminder timing and state for the Faceclaw assistant "Nano", built on the
OpenClaw platform — no separate daemon. The pieces:

- **TickTick** — source of truth for tasks (official MCP server, `mcp.ticktick.com`).
- **OpenClaw Automations** — the scheduler: persistence across restarts, catch-up,
  quiet hours (`activeHours`), retry backoff, self-paced re-checks (`nextCheck`).
- **`openclaw/reminder-scan.js`** — a *script payload*: deterministic logic, no LLM.
  Polls TickTick via MCP, keeps the notification ledger in the job's own `state`,
  and returns `{notify, wake:"now", state, nextCheck}` when a reminder is due.
- **Nano (the agent)** — courier only: shows `glasses.reminder_show` on the
  glasses with the exact arguments from the event, then applies the wearer's
  spoken answer to TickTick. Protocol in `openclaw/AGENTS.reminder.md`.
- **Faceclaw phone app** — the popup with tap-to-answer voice capture
  (`glasses.reminder_show` / `glasses.reminder_cancel`), lives in the faceclaw repo.

Flow: `scan -> REMINDER_EVENT -> Nano -> glasses.reminder_show (blocking) ->
voice answer classified on the phone -> Nano applies it to TickTick -> next
scan sees the new state`. Snooze and "done" are TickTick mutations, so the
ledger never stores them; it only tracks notification bookkeeping.

## Files

| Path | What |
|---|---|
| `openclaw/reminder-core.mjs` | pure ledger logic (unit-tested) |
| `openclaw/payload-wrapper.js` | the MCP-calling runtime part of the payload |
| `bin/build-payload.mjs` | assembles the two into `openclaw/reminder-scan.js` |
| `openclaw/reminder-scan.js` | **generated** — the file you deploy to the OpenClaw host |
| `bin/probe-tools.mjs` | lists the official MCP's real tool names/schemas; run once on the server |
| `openclaw/mcp-config.snippet.json5` | OpenClaw config for the TickTick MCP server |
| `openclaw/AGENTS.reminder.md` | standing-order section for Nano's AGENTS.md |
| `test/*.test.mjs` | `node --test test/` — no dependencies, Node >= 22 |

## Setup (one time, on the OpenClaw host)

1. **TickTick API token.** TickTick web app -> Settings -> Account -> *API Token*.
   Copy it; treat it as a password.
2. **MCP server.** Merge `openclaw/mcp-config.snippet.json5` into the OpenClaw
   config (server name must stay `ticktick` — the payload calls
   `MCP.ticktick.*`). `openclaw config validate && openclaw gateway restart`.
3. **Probe the tool names** (the payload is wired for `list_projects` /
   `get_project_with_undone_tasks`, verified against the live server on
   2026-11-08; re-check after any TickTick change and adjust
   `openclaw/payload-wrapper.js` TOOL_NAMES if they differ, then rebuild):
   ```sh
   TICKTICK_TOKEN=... node bin/probe-tools.mjs
   ```
4. **Deploy the payload.** Copy `openclaw/reminder-scan.js` to the host, e.g.
   `/srv/openclaw/scripts/reminder-scan.js` (chmod 600 not required; it holds
   no secrets — the token lives in the gateway config).
5. **Create the automation job** (script payload, main session so the notify
   lands as a system event Nano acts on):
   ```sh
   openclaw automations add \
     --name "nano-reminder-scan" \
     --every 5m \
     --script /srv/openclaw/scripts/reminder-scan.js \
     --session main \
     --tools "ticktick__*" \
     --pacing-min 1m --pacing-max 30m \
     --active-hours-start 08:00 --active-hours-end 22:30 --active-hours-timezone user \
     --no-deliver
   ```
   Notes: `--tools` must name the server exactly (`ticktick__*`) or the script
   gets no MCP namespace; pacing lets `nextCheck` self-pace between 1m and 30m
   (so a 10:07 deadline is caught at ~10:07, not on a 5-minute grid);
   `activeHours` is the quiet window — a due task inside quiet hours fires at
   the first tick after the window opens.
6. **Standing order.** Append `openclaw/AGENTS.reminder.md` to Nano's AGENTS.md.
7. **Faceclaw side.** The phone app must expose `glasses.reminder_show`
   (faceclaw repo, >= versionCode 812) with proactive calls enabled
   (Settings -> Assistant -> proactive actions).

## Verify

```sh
node --test test/                                  # logic + payload smoke
openclaw automations list --all                    # job exists, enabled
openclaw automations runs nano-reminder-scan       # recent runs ok, no errors
```
End-to-end: create a TickTick task due one minute out (inside active hours) ->
within ~`pacing-min` the glasses show the popup -> tap the temple -> say
"сделано" -> the task completes in TickTick. Then: "через 10 минут" -> the due
date moves ~10 minutes; "не сейчас" -> +30 minutes; silence -> re-nag after
5m, 15m, 60m, 4h, then quiet until the task changes.

## Tuning

Edit `SCAN_CONFIG` in `payload-wrapper.js` (project filter, note-list skip) or
`DEFAULTS` in `reminder-core.mjs` (lead time, backoff ladder, max repeats,
popup ttl), then `node bin/build-payload.mjs` and redeploy the generated file.
The ledger lives in the job's state (16 KB cap, oldest entries pruned past
`maxEntries`); deleting it is safe — it rebuilds from TickTick, at worst one
reminder cycle re-notifies.

## Known limits

- TickTick has no webhooks; everything is polled. Worst-case lateness of a
  reminder ≈ pacing-min (1m) + scan duration (a few seconds per project).
- One popup per scan tick; many simultaneous deadlines serialize ~1/minute.
- The blocking `glasses.reminder_show` call needs the MCP client's tool timeout
  to cover `ttl_ms + ~35s` (the phone tool declares this; OpenClaw's default
  tool timeout may need raising for this tool).
- Proactive calls are rate-limited on the phone (6/min); the controller fires
  at most one reminder per minute by construction, so it never trips it.
- Quiet hours gate the whole scan: a snooze into quiet hours fires when the
  window opens, not at the exact snooze instant.
