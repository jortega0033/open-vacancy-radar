# Follow-ups and follow-up drafts

Your own next steps on an application, with a due date or time, kept on this computer. Open **Follow-ups** on a row in
Applications. Nothing here sends a message, contacts anyone, reads email, writes to a calendar, runs in the background
or changes the application's status. Your **Next step** and **Notes** text stay exactly as you wrote them; the
follow-up summary is a separate line shown under Next step.

## A follow-up

Each one has a kind, a short title, how you will reach them, who or where, a note, and a due date or time. You can
mark it done, dismiss it (it stays in History) or move it to another time. Adding, viewing and changing follow-ups
works without an AI provider and without a network connection.

### When something is due

Every due moment names a **time zone** such as Europe/Amsterdam. Offsets and abbreviations (`+02:00`, `CET`) are not
accepted because they do not say how daylight saving behaves. This computer's zone is only what the form proposes.

- **Any time that day** is overdue only after that calendar day has ended in the zone you named.
- **At a set time** is read as the clock in that zone. A time the clocks skip (spring forward) is refused. A time that
  happens twice (clocks go back) is refused until you say which one you mean, "the first time" or "the second time".
- What is stored is the zone, the time you typed and the moment it means in UTC. Restarting the app, changing this
  computer's time zone or travelling never moves a follow-up. If the zone differs from yours, the same moment is also
  shown in your zone.
- Dates must be real calendar dates between 2000 and 2100.

Overdue and due-today labels are worked out while the Applications page is open. Nothing runs while the app is closed,
and no notification, scheduler or start-up item is added.

## When "Plan a follow-up" appears

Only on an application that is recorded as sent: this app saw the employer's confirmation, you told the app you
applied, or you set its status past Preparing yourself. It also has to still be at **Applied** (a recruiter screen or
interview means someone replied), not archived, with nothing already planned, and you have not turned suggestions off
for it.

It never appears for an application that is only a draft, being prepared, waiting for your review, failed or skipped,
or for one this app sent but could not confirm. Opening an employer page is not evidence of anything. There is **no
day count**: the app does not decide when you should chase. A quiet application is never treated as a rejection, and a
final outcome (offer, rejected, withdrawn) stops the prompt while keeping every follow-up and draft you made. You can
add a follow-up yourself on any application.

## Drafts

**Draft a message** writes one short message for you to read, edit and send yourself. It runs only when you press it,
once, in a separate no-network, no-tool session with Claude on this computer. If a submission was recorded for this
application, it uses that record (the CV and letter versions, and the recorded letter text); otherwise it uses your
current linked documents and says so on the draft. The model is not given your Notes or Next step text. A draft that
mentions a date, link or address the app does not hold is thrown away.

A cancelled, failed, out-of-date or reset run saves nothing and leaves earlier drafts untouched. Pressing the button
again after a failure is safe: one request makes at most one draft.

Two things are shown separately on every draft and never merged:

- **Review**: not reviewed, text approved by you, or discarded. Editing the text clears the approval.
- **Sent**: **Not sent**, or "You reported sending this". Only you can set this, with a confirmation, after sending the
  message yourself outside this app. Approving, copying or opening a draft never means it was sent, and reporting it
  does not complete the follow-up or change the application.

## Storage and deletion

See [privacy.md](privacy.md). Follow-ups, the per-application suggestion switch and drafts live in `workspace.db`
(tables `application_actions`, `application_action_prefs`, `application_follow_up_drafts`, migration 0040). They are
deleted with the application, and Settings > Advanced > Reset application data deletes all three.
