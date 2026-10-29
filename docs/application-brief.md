# Application brief

Issue #688. One compact decision record per job, shown inside two screens you already use: the **saved-job drawer**
(Saved jobs > Edit) and the **application drawer** (Applications > an application). It answers "why consider this job, what
backs it, what is missing, what do I still not know" in one place, and follows the job into preparation.

It is not a new score, a new page, a queue or a replacement for Search. The Apply page (#657) and its copy helpers (#660) do
not exist yet; the brief is a self-contained panel that page can show later.

## What it shows

| Section | Comes from | Needs AI? |
| --- | --- | --- |
| Why consider it | The Search scan's own score, fit dimensions, matching signals and score gaps, with the scan date. It says it does not compare your CV. | No |
| Can you take this job? | The scan's eligibility answers (work country, languages, visa sponsorship, Employer of Record, relocation), each with source, scope and date. | No |
| Strengths and gaps against your CV | The existing grounded requirement mapping (the "Compare with my CV" result), reused only when it was read against this exact posting text and this exact reviewed CV. | Only to create it |
| Your readiness | Whether you have a CV with reviewed source details, and how many requirements still need your review. | No |
| Posting and deadline | The stored posting check from #687, with its original check time and any deadline the posting itself states. | No |
| Company evidence | The stored #689 evidence for the application, with source, retrieval time and expiry. | No |
| Sent so far | What this app actually observed or what you reported, per application. | No |
| Where this came from | Every original source link and provider of this job. | No |
| What you knew when you started preparing | A frozen copy of the brief taken when "Get ready to apply" created the application. | No |

Relevance, readiness and submission evidence are separate headings on purpose. No section produces a number of its own and nothing
estimates a chance of being hired.

## Three states that are never merged

- **Known mismatch**: a source said no and it matters (you cannot work from where you are, a mandatory language you lack, a refused visa
  when you cannot work from where you are).
- **Not known yet**: no source said either way. This is not a mismatch.
- **Not assessed yet**: nothing has compared the posting with your CV. This is not a low fit and gets no score.

## One brief per requisition

A brief is keyed by the strongest identity the engine knows (an ATS requisition, else a specific posting address, else a company/title/
location fingerprint) plus an alias table of every way the same job was seen (each source copy's address and discovery key, the saved
jobs and applications that point at it). Two source copies of one requisition share one brief and list both sources; two requisitions at
the same employer never merge, even if a weaker alias collides. A job found through an aggregator and later through the employer's own board
keeps one brief.

## Versions and out-of-date sections

Each section records what it was derived under, and a section that no longer matches says so in plain words and keeps a note:

- **The posting text changed**: the assessment is marked out of date ("The job description changed on ..."), the earlier result stays visible
  and labelled as earlier.
- **Your reviewed CV changed** (or you now use another CV): the assessment is out of date. Assess selected jobs does not carry requirements
  read against the earlier CV forward; it skips that job without a request and points you at Compare with my CV in Search, where the existing
  "Your CV changed" step shows what changed and updates the assessment to your current CV.
- **The job left the latest scan**: the posting text the brief already holds stays the job's posting. The frozen copy an application took when
  preparation started is that application's own input; it only fills a brief that has no posting text yet and never replaces newer text or
  marks anything out of date.
- **A preference that changes a verdict changed** (target roles, skills, location or country, working languages, relocation, salary floor): the
  sections that read it are out of date and name the preference. Editing something the score never reads (your name) changes nothing.
- **A scan made under an older profile version**: reported as possibly out of date.

Relevance is not recomputed when a preference changes, because the engine scores during a scan. The brief says so and asks you to search
again. Correcting a preference from the brief (relocation, country, languages) changes **only your preference**: the employer's statements, the
stored scan facts, the assessment and everything you already sent stay exactly as they were.

## Assess selected jobs

On the Saved jobs page, tick up to **5** jobs and choose **Assess selected jobs**. Nothing starts until you confirm, and the confirmation names
what is sent and every limit:

- the posting text, your CV text (shortened to fit the request) and the roles, employers and projects from your reviewed CV details go to your
  chosen provider, one job at a time;
- at most **2** requests per job (**10** in total), each stopped after **4** minutes, and no new job starts after **15** minutes;
- jobs that cannot be assessed (no CV, CV details not reviewed, no posting text, already up to date, or an earlier assessment read against a
  different posting or an earlier CV) are skipped **without a request**;
- you can cancel at any time: the live request is stopped, the interrupted job saves nothing and every job that was not finished is left exactly
  as it was.

It uses the same prompt, the same response checks (a requirement must quote the posting) and the same merge as the Search assistant, and saves
through the main process, which refuses a result if the posting text, the reviewed CV or the case changed while the model was working. Each job ends
as **Assessed**, **Only partly read** (the request cap was reached or a later request failed; what was read is saved and labelled partial),
**Could not be assessed**, **Failed**, **Not finished** or **Result discarded**, and the summary line says "Finished" only when every selected job was
assessed. It never rescans, never applies a suggestion and never starts by itself.

## What is stored

`application_briefs`, `application_brief_aliases` and `application_brief_pins` in `workspace.db` (migration 0037). Public posting facts, derived
summaries, the posting text (cut at 80,000 characters) and short out-of-date notes. The assessment summary (in the brief and in its pinned copy)
keeps short labels derived from your CV for each strength: a role title and employer ("Senior Engineer at Redwood Software"), a project name, or
the first 80 characters of a statement you confirmed. It keeps no other CV text, and no notes or letters. The pinned copy is insert-only and
follows its application. Deleting the last saved job or application for a job removes its brief. Settings > Advanced > Reset application data
deletes all three tables with counts. See [privacy.md](privacy.md).

## Limits

- A desk evaluation on a fixed synthetic shortlist (reproduced by `test/application-brief-evaluation.test.ts`) counts where each decision fact lives
  before and after. Its "before" half is a reading of the earlier source, not a measurement, and includes the Fit check a person may have kept on
  a saved job. It is not a usability study and claims no time saving, decision quality or hiring gain.
- Company evidence and the posting check exist only once an application has been prepared for the job; before that the brief says so.
- A brief can only describe what it holds: a job with no scan result and no posting text has no score and cannot be assessed.
