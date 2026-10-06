# UX references and the bar to beat

Ticket: #643. Epic: #644. Date checked for every source: 2026-10-06.

These are references for patterns, flows and quality bars only. No copying of visuals, wording, trade dress or code. Public pages only (product pages, public help docs, public marketing pages); no login, no non-public material, no block bypassed. No screenshots are stored in the repo.

## How to read this

- "Verified" means the point was in the text of a public page fetched on the date above. Page text was read through a summarizing fetch, so wording is paraphrased and screen layouts were not seen.
- Step counts are the steps the public page itself lists. Click and screen counts that no page states are marked unverified. Nothing here was measured in a running product.
- "Unverified" means not confirmed on a public page. Teal could not be reached (403 on tealhq.com), so every Teal entry is unverified.
- A "Bar to beat" is a target for OVR, not a fact about the reference.

## Access log

| Source | Result |
|---|---|
| help.welcometothejungle.com (get started, filters) | Read |
| indeed.com help (resume upload) and career-advice search guide | Read |
| linkedin.com/help/linkedin/answer/a1462281 and the LinkedIn blog post on How you match | Read |
| linkedin.com/help/linkedin/answer/a1344205 | Read, but about unsubscribing, not job match; unused |
| help.huntr.co (saving jobs), huntr.co/product/job-tracker | Read |
| docs.ashbyhq.com/job-board-configuring-your-setup | Read (setup doc, not a candidate-side flow) |
| ashbyhq.com/blog/resume-autofill | 404, unused |
| simplify.jobs/copilot, simplify.jobs/autofill, help.simplify.jobs | Read (marketing level, little step detail) |
| tealhq.com, tealhq.com/tools/resume-builder | 403, not reachable, Teal unverified |

## 1. First-run onboarding and profile setup

Products: Welcome to the Jungle (WTTJ), Indeed.

**WTTJ flow** (4 steps, stated as about 5 minutes; [help](https://help.welcometothejungle.com/en/how-to-get-started-on-welcome-to-the-jungle-as-a-candidate)):
1. Create an account (Google, LinkedIn or email).
2. Upload a PDF resume (size limit 5 MB); the product extracts key information and skills.
3. Set preferences: search status, role, location, contract, salary, company traits.
4. See matches ranked by relevance.

Screens and clicks: unverified.

**Indeed flow** ([help](https://www.indeed.com/help/job-seekers/articles/4408783727629-uploading-a-resume-file-to-your-profile?hl=en&co=US)): 4 steps: choose upload, pick a file, review a preview, save. Preferences are a separate area; the page does not say whether the upload fills them (treated as the contrast case, unverified).

What makes it work:
- The CV is the first real input, and extracted data is editable afterward.
- A preview before save (Indeed) lets the user catch a bad parse early.
- WTTJ states the total time up front.

**Bar to beat:** From dropping a CV to a reviewed profile in one review screen and under 60 seconds, with no preference form before the first search.

Applies to: #634, #635, #628, #636, #640, #540.

## 2. Job search and filters

Products: Indeed, WTTJ.

**Indeed flow** ([guide](https://www.indeed.com/career-advice/finding-a-job/guide-using-indeed.com-job-search)):
1. Enter what (title) and where in two boxes.
2. Press enter; narrow with filters (job type, distance, salary, location, company, experience).
3. Optional: save jobs, set alerts, track from My Jobs (needs a free account).

Two fields and one submit to first results (derived from the guide; screen count unverified).

**WTTJ flow** ([help](https://help.welcometothejungle.com/en/filter-your-job-search-on-welcome-to-the-jungle)):
1. Criteria live in the candidate space: up to five locations, remote modes, contract, role, industry, level, minimum salary, company size, benefits.
2. Change any criterion; results refresh automatically.

The help doc also says fewer, more relevant results are preferred over volume.

What makes it work:
- Two fields are enough to start; everything else is optional and comes after results.
- Changing a filter updates results with no extra "apply" step (WTTJ).

**Bar to beat:** First ranked results after one click on a pre-filled "Search for <role>" (role taken from the CV), and every filter change updates results without a second button.

Applies to: #636, #635, #641, #540.

## 3. Ranked results and match explanation

Products: LinkedIn How you match, Simplify, Teal.

**LinkedIn** ([help](https://www.linkedin.com/help/linkedin/answer/a1462281), [blog](https://www.linkedin.com/blog/member/career/introducing-how-you-match-on-linkedin-jobs)):
1. Open a job in search or on its job page.
2. See a checklist comparing your profile with the job: skills, experience, title, education, plus relevant items missing from your profile.
3. Applicant ranking and the full view are for Premium subscribers (per the help page).

Clicks: 1 (open the job) after results; screens unverified.

**Simplify:** the public pages fetched describe autofill and tracking only. No match explanation was seen: unverified.

**Teal:** match score with matched and missing keywords is a claim from review sites only: unverified (403).

What makes it work:
- The explanation sits on the job itself, as met versus missing criteria, not as a bare score.
- Missing items point to an action (update the profile).

**Bar to beat:** Every ranked result shows, without a click, at most 3 plain reasons (met and missing) of under 12 words each, and the job detail lists all met and missing criteria on one screen.

Applies to: #628, #634, #635, #636.

## 4. Saved jobs

Products: Huntr, Indeed My Jobs, Teal.

**Huntr** ([help](https://help.huntr.co/en/articles/11479680-saving-jobs-to-huntr)): extension flow in 4 steps:
1. Install the extension and open a job page.
2. Open the widget and confirm the company.
3. Fields (title, keywords, skills, location, description) are captured automatically on supported sites; copy and paste otherwise.
4. Pick board and stage, click Save to Board.

Manual path: Create, then Job, enter details, pick board and list, save. After saving, a card editor opens for salary and deadline.

**Indeed** ([guide](https://www.indeed.com/career-advice/finding-a-job/guide-using-indeed.com-job-search)): saved jobs from results appear on My Jobs. Click count to save: unverified.

**Teal:** unverified.

What makes it work:
- Capture is automatic; the user only chooses where it goes.
- Saving and tracking share one place (Indeed My Jobs, Huntr board).
- Stage can be chosen at save time, so jobs already in progress fit.

**Bar to beat:** Save a job in 1 click from results or detail with no dialog, landing in a single list that doubles as the tracker.

Applies to: #639, #631.

## 5. Application tracker

Products: Huntr, Simplify, Teal.

**Huntr** ([product page](https://huntr.co/product/job-tracker)): a drag and drop board by stage with a timeline from applying to offer; holds contacts, salary, documents, and several resumes and letters per application. Stage names: unverified.

**Simplify** ([Copilot](https://simplify.jobs/copilot)): the extension records every application submitted through it in a built-in tracker, with no manual "I applied" step (marketing page, details unverified).

**Teal:** unverified.

What makes it work:
- Tracking is a side effect of applying, not a chore.
- The board view shows status at a glance and keeps documents with the application.

**Bar to beat:** An application appears in the tracker with the right status and documents attached with 0 manual entries, and every status is readable on one screen of up to 20 rows.

Applies to: #631, #639, #629, #630.

## 6. CV management and autofill

Products: Ashby, WTTJ, Simplify.

**Ashby** ([docs](https://docs.ashbyhq.com/job-board-configuring-your-setup)): when the employer enables it, an "Autofill from resume" option sits at the top of the details section of the application; uploading the resume fills the fields. Step count, field review and confidence indicators: unverified (setup doc only).

**WTTJ** ([help](https://help.welcometothejungle.com/en/how-to-get-started-on-welcome-to-the-jungle-as-a-candidate)): profile generated from the uploaded PDF, editable later from the candidate space.

**Simplify** ([Copilot](https://simplify.jobs/copilot)): one action fills forms on many employer career sites (the page claims 100,000+; unverified). How the stored profile is built: unverified.

What makes it work:
- Upload is the only input; fields are filled, not asked for.
- The user can still edit afterward.
- Autofill is offered at the point of need (top of the form).

**Bar to beat:** Adding, replacing or defaulting a CV fills at least 6 profile fields (name, role, skills, seniority, location, languages) in under 10 seconds and shows exactly which fields were filled, with 1 click to correct each.

Applies to: #634, #628, #640, #639.

## 7. Tailored documents to apply

Products: Simplify, Teal.

**Simplify** ([help center](https://help.simplify.jobs/), [Copilot](https://simplify.jobs/copilot)): the help center lists resume tailoring and cover letter tailoring with keyword scoring, and autofill that logs the application. The page only lists titles; the flow, screens and clicks are unverified.

**Teal:** unverified (403).

What makes it work (verified part only):
- Tailoring, autofill and tracking are presented as one connected path.

**Bar to beat:** From "documents ready" to the employer page in 1 screen and 2 clicks (review, then open employer page), with the application tracked automatically. Today it is about 3 screens and 4 or more clicks (epic #644).

Applies to: #631, #639, #540.

## Cross-area summary

| Area | Verified references | Unverified |
|---|---|---|
| Onboarding | WTTJ, Indeed | screen and click counts |
| Search and filters | Indeed, WTTJ | click counts |
| Ranked results | LinkedIn | Simplify, Teal |
| Saved jobs | Huntr, Indeed | Teal, Indeed click count |
| Tracker | Huntr, Simplify (marketing level) | Teal, stage names |
| CV and autofill | Ashby (setup doc), WTTJ | Simplify profile build, Ashby field review |
| Tailored documents | Simplify (titles only) | flow details, Teal |

Visual direction is out of scope here; see #541.
