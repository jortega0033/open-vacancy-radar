# Open Vacancy Radar — implementation handoff

Prototype: `Open Vacancy Radar.dc.html` (canonical UX reference). Previous iteration kept at `IND Job Radar.dc.html`.

## Pages / routes
- `/search` (default, unless Settings → Start page changes it) — market-agnostic search, master/detail
- `/saved` — Saved Jobs table, full CRUD via right drawer
- `/applications` — pipeline table (Active/Archived/All), full CRUD, inline status select
- `/cv` — CV library (upload PDF/DOCX, manual profiles), parsed-profile inspection & editing
- `/letters/new` — generator (job + CV + type/tone/length + instructions → editable document)
- `/letters` — letters library (open/duplicate/delete)
- `/runtime` — AgentDock provider cards (Claude Code / Codex), verify CLI
- `/settings` — fully functional, auto-saved with toasts

## Shell
- Sidebar: expanded 236px, collapsed 64px; collapsed nav buttons 44×44 with aria-label + title tooltip + active state; toggle persists (localStorage), Settings can force start state.
- Workspace header 52px: page title/sub left; runtime status right.
- Theme: Light/Dark/System via CSS custom properties on `[data-ovr]`; density Comfortable/Compact via `--rowpad` on `[data-dens]`.

## Market model
- Core is market-agnostic: `Market` selector (NL, DE, BE, FR, UK, US, Other); currency follows market.
- Netherlands-only features render conditionally: "IND-recognized sponsors only" filter, IND sponsorship card, registry verification details (IND Public Register), work-permit-fit hint.
- Non-NL: `Employer Verification: Not available` + honest explanation. Never invent registries for other countries. "Not found" ≠ "Not recognized" (legal entity may differ).
- Verification statuses: Recognized / Possible match / Needs review / Not verified / Not found / Not available.

## Entities & relationships (persisted to localStorage key `ovr-proto-v1`)
- Vacancy (static demo data per market), SavedJob (may link vacId), Application (may link savedId, cvId, letterId), CVDocument (one isDefault), Letter (links vacId, cvId), UserSettings, provider.
- Deleting a CV/letter clears references on applications (with confirm warning); deleting a saved job detaches applications; deleting the default CV promotes another.
- Deletes: confirm dialog (danger button) + undo toast. Application delete confirm is a setting.

## Settings → effects
theme/density → whole app · start page → initial nav · sidebar pref → shell · default market/location/arrangement/employment/posted → Search state · sponsor-only default → NL searches · source toggles → results + filter options · IND toggle → verification state on NL vacancies · default CV → match cards + letter generator · doc defaults → generator · autosave → letters library · app default status / confirm-delete / auto-archive-rejected → Applications · export/import (JSON) / clear history / restore demo / reset settings / reset all.

## Electron boundaries (renderer never gets shell/fs access; fixed-capability IPC to main)
- Launch at login → `app.setLoginItemSettings`
- Open Job / repository → `shell.openExternal`
- CV upload & original download, data export/import → native dialogs
- CLI detect/verify + AgentDock runs → main-process service. AgentDock never reads/stores CLI credentials.

## Reusable components (suggested)
AppSidebar, SidebarNavItem, WorkspaceHeader, MarketSelector, SearchFilterBar, VacancyResultRow, VacancyDetail, EmployerVerification, CVMatchAnalysis, DataTable, EntityEditorDrawer, ConfirmDialog, Toast (with undo), EmptyState, StatusBadge, CVEditor, LetterEditor, ProviderCard, SettingsSection, SettingsRow, ThemeSelector, ToggleSwitch.

## Visual tokens (light / dark)
bg #fff / #181818 · panel #fafafa / #1e1e1e · text #141414 / #ececec · secondary #555 / #b0b0b0 · borders #e7e7e7→#f4f4f4 / #2e2e2e→#232323 · primary = black↔white inversion · ok #15803d / #4cae6e · warn #b45309 / #cf8b2e · danger #b91c1c / #e05252 · radius 5–8px · row padding 11px (compact 7px) · body 13–14px, metadata 11–12.5px.

## Demo states (Tweaks)
`demoCodexState`: ready / unauthenticated / notinstalled / unknown · `demoSearchError`: search failure state.
