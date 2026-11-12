## Hybrid TickTick reminders (Nano + Faceclaw)

TickTick owns routine reminder delivery. Its Android notification reaches
Faceclaw through the phone's Notification Listener and Faceclaw supplies the
Even G2 window and controls. Do not reproduce those notifications from Nano.

Standing rules:

1. Never poll TickTick on a schedule to discover due, overdue, all-day or
   undated tasks. Do not create or enable `nano-reminder-scan`, and do not ask
   periodic questions about today's tasks or tasks without a time.
2. Never call `glasses.reminder_show` merely because a TickTick task became
   due. TickTick has already delivered that reminder. A second delivery would
   duplicate it on the glasses.
3. Treat legacy `REMINDER_EVENT` system events as obsolete. Do not show a
   popup and do not mutate TickTick from such an event. The old automation
   must be disabled by the operator.
4. Keep the TickTick MCP tools available. Use them normally for conversational
   requests to create, list, complete, reschedule, edit or delete tasks. Always
   resolve task ids from a fresh TickTick list/get call; never invent an id.

### Commands coming from a TickTick notification

Faceclaw handles unambiguous commands locally: completing the task and
snoozing the Android notification for an explicit interval. Nano is not
called for those actions.

A complex or ambiguous spoken command arrives as an ordinary user message in
the active chat, in this form:

`По задаче TickTick «<title>»: <spoken command>`

Handle it as the wearer's current request. Find the matching active task with
the TickTick MCP tools and apply the requested change. If more than one task
matches, the time is ambiguous, or an important detail is missing, ask one
short clarification in the same chat. Continue the normal conversation there;
do not open another reminder popup or proactive dialog for the same command.

### Allowed agent-created reminders

The removal of routine scanning does not remove Nano's ability to remind the
wearer. A one-shot reminder is allowed when:

- the wearer explicitly asks Nano to remind them; or
- the wearer makes a concrete promise or commitment and the current assistant
  policy calls for a follow-up.

Create a one-shot OpenClaw automation for the requested time. It must delete
itself after it runs and must not scan TickTick. When that event fires, Nano may
call `glasses.reminder_show` once (or `glasses.show_alert` when no response is
needed). Do not also create a TickTick reminder for the same commitment unless
the wearer explicitly asks for both channels.

If `glasses.reminder_show` fails, retry at most once. Never mark a task done or
change its date merely because delivery failed or the wearer did not answer.

`glasses.dialog_open` remains a discussion primitive, not a routine delivery
channel. Use it only when an explicit request or an active conversation needs
a spoken answer. Do not schedule daily check-ins with it.
