# Documents you sent and interview rounds

Issue #691. Extends "Prepare interview" (#358) on the Applications page. The prep pack is built from the documents
recorded for **this** application first, and from the interview rounds you recorded. Your current library CV and
letter are used only as a fallback, and the prompt and the drawer say so.

## What is recorded when you apply

When a submission is recorded for an application (this app saw a confirmation or a receipt reference, or you
pressed "I applied"), the same database write also stores a versioned record of what this app held for it:

- the requisition (employer key, requisition id or posting address key, company, role);
- the hash of the job description the documents were prepared against, and whether it was complete;
- the source CV hash and the hash of your reviewed CV evidence (from the #690 review when one ran, otherwise taken
  from the source CV when it still matches);
- for the CV and the letter: the #690 draft id, version and content hash, and the accepted file id and hash.

Each document carries one of four states, and they never merge:

| State | Meaning |
| --- | --- |
| Prepared only | This app prepared it. Nobody has said it was the file sent. Every generated, accepted or exported file starts here. |
| You confirmed | You said this version is what you sent, pasted the text you sent, or said your linked library document as it read then is what you sent. |
| Sent by this app | This app sent the application itself, its own form-fill record names this file as attached, and it then observed a receipt. The receipt confirms the application landed. It does not contain the file, and the app never says it proves the bytes. |
| Version unknown | You said you do not know which version you sent. |

A statement adds a new version of the record; earlier versions are kept. A statement cannot change a "Sent by this app"
document. Nothing is inferred: opening the employer page, accepting or exporting a file, or reaching the interview
stage records nothing about which document was sent.

## How the prep pack chooses its documents

Only the attempts linked to this Applications row are considered. The company name and the newest attempt at the
same employer are never used. A reapplication and a second role at the same employer each have their own row and
their own record. If one row holds several sent packages, the newer one in a reapplication chain is used; unrelated
ones are never guessed between, and "Generate prep pack" waits until you choose.

| Case | What the prep pack uses |
| --- | --- |
| A recorded package | The text of each recorded document (from the stored draft, checked against its hash, or the text you supplied), cited as [D1] CV and [D2] letter with version, fingerprint and state |
| Sent before this version | The same, from what this app still holds; labelled as an earlier record |
| A file whose text was never kept, or "Version unknown" | No text for that document; your current linked document is added for that slot only, labelled as current |
| An application you track by hand | Your current linked CV and letter, labelled as current, until you tell the app what you sent |

Library edits, replacements and deletions after you applied never change a record. If a stored file is later
deleted or changed on disk, the drawer says so; the text still comes from the stored draft, and PDFs are never
decoded for this.

## Interview rounds

A round has a type, an optional date, Planned or Done, your notes and topics you marked as still open. Rounds you
marked Done go to the next prep pack in their own block, cited [R1], [R2], described as your own notes that nobody
has checked. The prompt tells the model never to treat them as your experience, a CV fact, a fact about the employer,
or a sign of how the employer judged you. Saving a round never changes the application status, your notes, your CV or
any record above. Existing free notes are untouched; the migration creates no round from them.

Not included: email, calendar or mailbox access, recording or transcription, mock interviews, outreach, or any
automatic change to your CV or the application.

## Storage and deletion

See [privacy.md](privacy.md). Both tables live in `workspace.db`. Rounds and your statements on a hand-tracked row
are deleted with the Applications row; a document record is deleted with the attempt it belongs to; Settings >
Advanced > Reset application data deletes both tables.
