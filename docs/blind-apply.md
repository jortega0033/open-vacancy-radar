# Blind Apply (#722)

Blind Apply is an explicit, opt-in mode for frontend roles. After one confirmation it checks, prepares and
sends supported applications without asking about each one, and records what happened. The normal reviewed
flow is unchanged and stays available.

## What the person does

1. Settings > Blind Apply > **Turn on…**. The app shows its own native dialog listing the role family, the
   hard filters from the search profile, the CV it will use and where it can send. **Cancel is the default.**
   That one confirmation is all there is: no per-job approval, no number of applications, no schedule.
2. Applications shows one activity feed. States are **Submitted**, **Could not submit**, **Sent? Couldn't
   confirm**, **Needs one answer**, **Needs you**, **Apply yourself**, **Stopped**. Evidence (the receipt the
   page showed, document fingerprints, which answers were used and from where, the history) is behind
   **Details**.
3. **Stop Blind Apply** is one control. It is immediate.

There is **no daily limit**, per-employer rule, expiry or artificial wait, by the owner's explicit choice on
2026-10-30. The schema has no column that could hold one, and a test fails if one appears.

## What it does and does not do

- **Supported sites only.** It sends only through a compiled target policy that the terms register
  (`application-target-evidence.md`) has cleared for automation and that allows `submit`. **In this build the
  only such policy is the local test form, so Blind Apply submits to zero real employers.** The UI says so.
  Every other target is **Apply yourself**: no tailoring is spent on it, it is never reported as submitted,
  and **Open** starts the existing reviewed flow.
- **Order of checks, all before any tailoring:** the authorization is active and the CV and profile are unchanged
  since it was confirmed; the role family is confirmed (frontend); the hard filters pass (`unknown` does not
  pass); the apply link is verified; the role is not a duplicate (an attempt in progress or sent, a Blind
  item, or a row tracked by hand); a policy permits unattended sending; the posting is confirmed open now.
- **Truthful answers, deterministically.** A field is filled only when its whole label equals a known label for
  a value already in the CV/profile, or exactly matches a question the person answered and chose to remember.
  The executor labels a field by `aria-label`, `placeholder`, `name` or `id`, so camelCase, snake_case and
  spaced forms are read as the same label. No model chooses a submitted value and no job-description text is
  an input. A remembered select answer is tied to the exact option list.
- **Never done for the person:** ticking a consent box, signing in, entering a verification code, passing a
  bot check, answering a demographic question from the CV. These stop that one application as **Needs you**
  (or **Needs one answer** for a demographic question the person may answer). Other applications continue.
- **Receipt proof.** Only an observed confirmation (or printed reference) makes an item Submitted. No
  confirmation is "Sent? Couldn't confirm" and is never retried.
- **Stop.** Writing the stop is synchronous; every unsent item becomes Stopped; the click is guarded by a last
  check immediately before the attempt moves to `submitting`. A send already past that point is never
  interrupted, and completed records and receipts are never written to by Stop.
- **Crash recovery.** An attempt found mid-send becomes `submission_unknown` with a receipt row and is never
  resent (this also fixes a gap that predated Blind Apply). A prepared item that lost its page is prepared
  again. Nothing resumes under a stopped authorization.

## Local record

`blind_apply_authorizations`, `blind_apply_items`, `blind_apply_events` (append-only) and
`blind_apply_answers` in `workspace.db` (migration `0041`). Answer values are not copied into events: the
attempt's prepared fields hold them. A full personal-data reset clears all four.

## Not in scope

No real employer policy (Workable and others stay manual until a separate, human-reviewed policy PR with
applicant-side terms evidence and a non-submitting capture), no CAPTCHA/login/OTP bypass, no private ATS
APIs, no browser extension, no automatic reapply, no change to the reviewed flow or to the reviewed
automatic-submission grants.
