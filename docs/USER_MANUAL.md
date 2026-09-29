# TMMS User Manual

Transmission Asset Management System (TMMS)
Operator and field user guide

---

## About this manual

This manual explains how to use the TMMS web console to manage electrical
transmission infrastructure: regions, substations, transmission lines, towers
and assets, then plan, dispatch, execute and verify the maintenance and
inspection work that keeps them reliable.

It is written for the people who use the system day to day:

- Executives and directors who monitor performance and compliance.
- Region, transmission, substation and relay/SCADA managers who plan and
  approve work.
- Planners and dispatchers who create tasks and assign crews.
- Crew leads and crew members who perform work in the field.
- Auditors who review evidence.

No software installation is required. TMMS runs in a web browser.

---

## Table of contents

1. Introduction
2. Getting started
3. Roles and permissions
4. Home and Dashboard
5. Infrastructure
6. Tasks
7. Crews and dispatch
8. Maintenance schedules
9. Checklists
10. GPS validation and geofences
11. Certifications
12. Reports and documents
13. Value and cost
14. Organization
15. Settings and administration
16. Map
17. Glossary
18. Frequently asked questions

---

## 1. Introduction

TMMS is a geographic, asset-centric maintenance management platform. It keeps
one authoritative record of every asset and location, and it drives each piece
of work through a closed loop:

Plan -> Dispatch -> Execute -> Document -> Verify

The main building blocks are:

| Concept | What it is |
|---|---|
| Region | A geographic and organizational unit. |
| Substation | A node where voltage is transformed or switched. |
| Transmission line | A high-voltage corridor linking substations. |
| Tower | A structure that carries a transmission line. |
| Asset | A specific piece of equipment (transformer, breaker, tower part, insulator, and so on). |
| Task | A work order for inspection, maintenance, repair or testing. |
| Crew | A field team with members, skills and certifications. |
| Schedule | A recurring plan that generates tasks automatically. |
| Checklist | A standardized procedure executed step by step in the field. |
| Certification | A qualification held by a person, with an expiry date. |
| GPS validation | A check that a recorded location matches the real world. |
| Report | An operational, compliance or financial output. |

Key principles:

- One source of truth for every asset, task and location.
- Everything is georeferenced; coordinates are verified before they are trusted.
- Every field action records who did it, when and what the result was.
- Recurring work is automated, and nothing disappears without a record.

---

## 2. Getting started

### 2.1 Signing in

1. Open the TMMS address in your browser. The public landing page appears.
2. Choose the persona that matches your role, or click "Sign in" to go directly
   to the login page.
3. On the login page, enter your username and password, then submit.
4. On success you are taken to your Home page.

Session notes:

- Your session lasts 12 hours. When it expires, or when you sign out, you are
  returned to the login page.
- If your session ends while you are working, the next action sends you back to
  login. Sign in again and continue.
- Use "Sign out" from the user menu in the top-right corner when you finish on a
  shared device.

The landing page offers these personas: Field Crew, Director / Manager,
Executive, Planner / Dispatcher, Auditor and General sign-in. Selecting a
persona only filters which demo accounts are shown; it does not change your
permissions.

### 2.2 Demo accounts

For demonstration and training environments, the login page lists ready-made
accounts. Click an account chip to fill the form, then sign in.

| Username | Password | Role |
|---|---|---|
| admin | Admin@123 | ADMIN |
| ceo | Executive@123 | EXECUTIVE |
| exec.tbu | Executive@123 | EXECUTIVE |
| exec.tso | Executive@123 | EXECUTIVE |
| dir.rc | Executive@123 | EXECUTIVE |
| dir.ot | Executive@123 | REGION_MANAGER |
| dir.c1 | Region@123 | REGION_DIRECTOR |
| mgr.c1.som | Manager@123 | SUBSTATION_MANAGER |
| mgr.c1.tlom | Manager@123 | TRANSMISSION_MANAGER |
| mgr.c1.rs | Manager@123 | RELAY_SCADA_MANAGER |
| crew.c1 | Crew@123 | CREW_LEAD |
| crew.otrly.lead | Crew@123 | CREW_LEAD |
| crew.c1special.lead | Crew@123 | CREW_LEAD |
| crew.c1tlom.lead | Crew@123 | CREW_LEAD |
| crew.c1som.m3 | Member@123 | CREW_MEMBER |
| crew.c1tlom.m4 | Member@123 | CREW_MEMBER |

These credentials are for the seeded demo database only. Production
environments issue individual accounts.

### 2.3 The interface

After signing in, the screen is split into:

- A left sidebar with navigation grouped by area: Overview, Infrastructure,
  Operations, Validation and Compliance, Management and Governance.
- A top bar with global search, the language selector, and your user menu
  (name, role, region scope and "Sign out").

Field crew users see a reduced menu with only Home and Map, so the field
experience stays simple.

Global search scans infrastructure and work records and takes you straight to
the matching record.

### 2.4 Language and units

Use the language selector in the top bar to switch between English, Español,
中文 and አማርኛ (Amharic). Changing the language reloads the page. Selecting
Amharic renders the entire interface in Amharic, including navigation, page
titles, buttons, table headers, statuses, form labels and report templates.
You can also choose the default language in Settings.

Displayed units (metric or imperial), time zone and date format are controlled
in Settings. Ask an administrator to change the default for your organization.

---

## 3. Roles and permissions

Your role determines what you can see and do. Managers are additionally limited
to the part of the organization they are responsible for (their scope).

| Role | In practice |
|---|---|
| ADMIN | Full access to everything, including users and global settings. |
| EXECUTIVE | Read all data, see dashboards and reports, follow work; cannot modify field records. |
| VIEWER | Read-only access to registers, tasks and maps. |
| AUDITOR | Read all data, produce and export reports, and review the audit log. |
| REGION_DIRECTOR | Manage work across their region: schedule, assign, verify, plan. |
| REGION_MANAGER | Same as a director, and can also execute tasks and capture GPS and attachments. |
| SUBSTATION_MANAGER | Manage substation maintenance work within scope. |
| TRANSMISSION_MANAGER | Manage transmission line and tower work within scope. |
| RELAY_SCADA_MANAGER | Manage relay, SCADA and telecom work within scope. |
| SUPERVISOR | Oversee and drive work within scope. |
| PLANNER | Create tasks and schedules, run schedule generation, bulk-edit tasks. |
| DISPATCHER | Create tasks and assign crews. |
| CREW_LEAD | Run field work for the crew: start, execute, hold, resume, submit; capture GPS and photos. |
| CREW_MEMBER | Execute assigned work and capture evidence; cannot drive workflow. |

Notes:

- If a button is missing, your role does not allow that action. This is by
  design; ask a manager or administrator if you believe you should have access.
- Crew users can only act on tasks assigned to their own crew.
- Managers only see crews, tasks and people inside their command scope.

---

## 4. Home and Dashboard

### 4.1 Home

Home is your personal work list. It has two sections:

- "Waiting on you" lists items that need your attention now.
- "History" lists items you have already handled.

Use the "Mine" and "In my area" tabs to switch between work assigned to you
personally and work in the area you manage. Each item has an action that opens
the relevant task, schedule or record.

### 4.2 Dashboard (Overview)

The Dashboard summarizes the state of the network:

- Open Task Mix: open tasks "By Status" and "Open Tasks by Type".
- Asset Condition: the distribution of asset health.
- Regional Activity: workload by region.
- Recent Tasks: the latest work items.

Use it to spot backlog, overdue work and unhealthy assets before they become
outages. Click through to the underlying records to act.

---

## 5. Infrastructure

All infrastructure registers live under "Infrastructure" in the sidebar.
Regions, substations, transmission lines and towers are managed inside the
Infrastructure page using its manage modes; "Assets" is a separate register.

### 5.1 Regions

Regions are the top geographic grouping.

To add a region:

1. Open Infrastructure and choose the Regions manage mode.
2. Click "+ Add Region".
3. Fill in code, name, type, centre latitude/longitude and, if needed, draw the
   region boundary on the map using the polygon editor.
4. Set status, manager, contact phone, contact email, time zone and notes.
5. Save.

Click "View" for a summary, or "Edit" to change the record. A region summary
shows its substations, lines, asset mix and condition.

### 5.2 Substations

To add a substation:

1. Open the Substations manage mode.
2. Click "+ Add Substation".
3. Enter the substation ID, name and region.
4. Enter latitude/longitude (or pick the point on the map), elevation, voltage
   levels (comma separated), type, operational status and commissioned date.
5. Enter owner, bay count and fence radius, and mark whether GPS is validated.
6. Save.

Substation detail shows connected lines, the bay count and the assets in the
substation. "Import substations" supports loading many records at once.

### 5.3 Transmission lines

To add a line:

1. Open the Lines manage mode.
2. Click "+ Add Line".
3. Enter from/to substations, voltage (kV), line type, length, conductor,
   number of circuits, key dates, rating and status.
4. Draw the route on the map (waypoints) or import a route file.
5. Save.

From a line record you can:

- "Generate towers from route" to create tower positions along the route.
- View the tower list and the line assets.
- Open the "Line Detail Document" for a printable summary.
- Reset the route if it needs to be redrawn.

### 5.4 Towers and the line map workspace

Towers can be added manually or in bulk.

To import towers:

1. Open the Towers manage mode.
2. Click "Download template" to get the expected columns.
3. Click "Import (Excel/CSV)" and choose your file.
4. Review the result and fix any rejected rows.

Switch between Table and Cards views, and page through large tower lists.
Tower detail lists its parts; you can add a part, edit a part, or "Reset parts
to standard" to restore the default component set. Component fields include
tower type (SUSPENSION, TENSION, ANGLE, TERMINAL, TRANSITION, DEAD_END),
material (LATTICE_STEEL, TUBULAR_STEEL, CONCRETE, WOOD, COMPOSITE), foundation
(PAD, RAFT, PILE, ROCK_ANCHOR, GRILLAGE, MICRO_PILE) and component status
(INSTALLED, SPARE, DEFECT_REPORTED, REPLACED, REMOVED).

The Line Map Workspace is a focused editor for one line:

- "Draw route" then "Save route" to set the alignment.
- "Apply" auto-spacing to distribute towers evenly.
- Bulk tower edits: set type, set material/foundation, reset parts to standard.
- "Export CSV" to take the tower list with you.

### 5.5 Assets

Assets is the equipment register. Each asset can belong to a substation, a
line, or a tower.

To add an asset:

1. Open Assets.
2. Click "+ Add Asset".
3. Enter the asset ID, type, its location (substation, line or tower), name,
   manufacturer, model and serial number.
4. Enter installation and commissioning dates, latitude/longitude, condition
   rating (1-10), criticality (CRITICAL, HIGH, MEDIUM, LOW), lifecycle and
   operational status.
5. Set metadata, bay, location type and (optionally) a default crew.
6. Save.

Assets supports Register, Table and Cards views, plus "Import KMZ/KML" for
bulk loading georeferenced assets. Asset detail includes open tasks,
maintenance history, GPS validations and a discussion thread. From the history
you can "+ Add maintenance event" and "Save event". "Generate document" produces
a printable asset report.

### 5.6 Data validation

The Data Validation tool ("Reconcile counts & mirrors") compares recorded
counts against related records and flags mismatches for lines, non-standard
towers and substation bays. Use it after bulk imports to confirm that towers,
bays and assets agree with the parent records.

---

## 6. Tasks

A task is a work order. Tasks move through a controlled lifecycle so that work
is planned, executed and independently verified.

### 6.1 Task lifecycle

| Status | Meaning |
|---|---|
| DRAFT | Created but not yet scheduled. |
| SCHEDULED | Has a due date and is ready to be assigned. |
| ASSIGNED | A crew is responsible. |
| IN_PROGRESS | Field work is under way. |
| ON_HOLD | Work is paused (blocked). |
| PENDING_VERIFICATION | Field work submitted; awaiting verification. |
| COMPLETED | Verified and closed. |
| CANCELLED | Cancelled before completion. |
| FAILED | Completed with a failing result. |

Actions and the states they connect:

- "Schedule": DRAFT -> SCHEDULED.
- "Assign": DRAFT or SCHEDULED -> ASSIGNED (choose a crew).
- "Start work": ASSIGNED -> IN_PROGRESS (a crew must be assigned first).
- "Hold (blocked)": IN_PROGRESS -> ON_HOLD.
- "Resume work": ON_HOLD -> IN_PROGRESS.
- "Submit for verification": IN_PROGRESS -> PENDING_VERIFICATION.
- "Reopen (rework)": PENDING_VERIFICATION -> IN_PROGRESS.
- "Verify & complete": PENDING_VERIFICATION -> COMPLETED.
- "Cancel task": any open state -> CANCELLED.

Rules that protect data quality:

- A task with a checklist cannot be submitted or verified until every required
  checklist item is graded.
- If the checklist requires GPS confirmation, a GPS validation must exist
  before the task can be verified.
- The person who executed the checklist cannot also verify the same task
  (segregation of duties).
- Verifying records a result: PASS, FAIL, PARTIAL or DEFERRED. Cost can be
  recorded against the maintenance event at the same time.

### 6.2 Creating a task

1. Open Tasks and click "+ Add Task".
2. Enter a title and description.
3. Choose the task type: PREVENTIVE, CORRECTIVE, EMERGENCY, INSPECTION,
   REPLACEMENT, TESTING or REPAIR.
4. Choose the priority: CRITICAL, HIGH, MEDIUM or LOW, and a priority reason if
   needed.
5. Set the due date (defaults to 14 days out) and, optionally, scheduled start
   and end.
6. Pick the location: region, substation, line, tower and/or asset.
7. Attach a checklist template if the work has a procedure.
8. Indicate whether a permit is required and whether the work is energized.
9. Save.

After saving, you can schedule and assign the task from the list or from Task
Detail. When you assign a crew, TMMS shows a non-blocking dispatch advisory
(see section 7).

### 6.3 Finding, filtering and bulk work

The Tasks list shows KPI tiles and filters for status, task type, "Overdue
only", line, tower, asset, substation and crew. "Export CSV" downloads the
current view.

Bulk mode lets you select multiple tasks and apply one change at a time:
assign a crew, change priority, change due date, or change scheduled start.
Choose the action, set the value, then "Apply"; "Clear" resets the selection.

### 6.4 Task Detail

Task Detail is the working page for a single task. It contains:

- The workflow card with the action appropriate to the current status.
- The dispatch advisory for the task's checklist and crew.
- A GPS recorder to start/stop capture during field work.
- The checklist run flow (see section 9).
- "Field log - findings & photos": record findings and attach photos.
- "Checklist Executions": the history of each run.
- "Work items": per-item progress (a supervisor can patch an item).
- "Task document": generate a printable task report.
- "Follow-up work": raised and recommended follow-up tasks.
- "Discussion": a comment thread.

Typical field flow:

1. Planner schedules the task and assigns a crew.
2. Crew lead opens Task Detail, clicks "Start work".
3. Crew lead clicks "Run checklist", completes each step, then "Submit
   execution".
4. Crew lead clicks "Submit for verification".
5. A different authorized user reviews and clicks "Verify & complete",
   entering the result and any cost.

### 6.5 Follow-up work

When a checklist fails, or a critical finding or GPS failure is recorded, TMMS
raises a follow-up corrective task automatically:

- Failures above a threshold, critical findings and GPS failures raise an
  EMERGENCY corrective task.
- Other failures can raise a recommended follow-up that a manager can accept
  and create.

Follow-up tasks carry a link back to the task that raised them and never spawn
further automatic follow-ups, so the chain stays controlled.

---

## 7. Crews and dispatch

### 7.1 Managing crews

Open Crews to see the roster. Use "+ Add Crew" to create one, or "View"/"Edit"
to inspect or change it. A crew has:

- A name, type, region and status.
- A leader and members. Members have a role (CREW_LEADER, LINEMAN, TECHNICIAN,
  SAFETY_OFFICER, INSPECTOR, APPRENTICE) and a skill level (JUNIOR,
  INTERMEDIATE, SENIOR, MASTER). Use the member controls to add members and to
  reorder them.
- Certifications per member (see section 11).
- Its task history.

Crew status is normally derived from its workload: a crew with active field
work is shown as ON_TASK; otherwise it is AVAILABLE. You can override the
status to OFF_DUTY or UNAVAILABLE when a crew is not usable.

### 7.2 Dispatch eligibility check

The Crews page includes a "Dispatch Eligibility Check". This is decision
support: it recommends the best crew and warns about gaps. It never blocks a
dispatch.

1. Choose a region, task type, checklist and/or task.
2. Click "Check".
3. If you chose a task, TMMS evaluates only the crew that task relates to:
   the assigned crew, otherwise the target asset's default crew, otherwise the
   responsible crew on the raising schedule. The panel tells you which.
   If you chose only a checklist, TMMS evaluates the crews whose type the
   checklist requires.
4. Read the results table:

| Column | Meaning |
|---|---|
| Crew | The crew evaluated. |
| Status | Current crew status. |
| Active | Number of open tasks. |
| Eligible | Whether the crew covers the skills, certifications and team size. |
| Score | Ranking score (certifications, current load and skills). |
| Missing skills | Skills the checklist calls for that no member or the crew type matches. |
| Missing certs | Required certifications the crew does not currently hold. |
| Certs to obtain | Every unmet certification, marked "required" or "recommended". |
| Equipment to secure | Materials and test equipment the checklist calls for (advisory). |

Crews that are OFF_DUTY or UNAVAILABLE cannot be selected.

### 7.3 How dispatch matching works

TMMS reads the checklist's team and skill text (for example
"Team: 2 Linemen + 1 Engineer. Skill: Lineman, Transmission Engineer.") and
matches it against each crew's type, member roles, skill levels and valid
certifications. It also computes the minimum team size from the checklist.

Certification requirements are derived from the checklist itself, so a crew is
only asked for a certification that the work actually needs:

- SF6 handling only appears when the checklist mentions SF6.
- HV testing only appears when a test instrument or diagnostic procedure is
  present.
- Height work and tower climbing appear for line and tower work.
- Switching authority appears for isolation, lock-out/tag-out or permitted work.
- Live-line appears for energized work.
- First aid is always recommended for field work.

Required certifications affect eligibility; recommended certifications are
shown as advice. When you assign a crew, the same advisory appears as a
dismissible banner on the Tasks page and in Task Detail, so you can decide
before committing. If a warning is acceptable, proceed; nothing is blocked.

---

## 8. Maintenance schedules

Schedules automate recurring work. Instead of creating the same task every
month, you define the plan once and TMMS generates tasks on time.

### 8.1 Creating a schedule

1. Open Schedules and click "+ Add Schedule".
2. Enter a name and code.
3. Choose the scope type: ASSET_CLASS, ASSET, SUBSTATION, LINE, LINE_TOWERS,
   TOWER or REGION, and pick the target.
4. Choose the task type, priority and, if the work has a procedure, a checklist
   template.
5. Choose the responsible crew and add instructions.
6. Set the next due date and build the recurrence rule.
7. Save.

### 8.2 Recurrence rules

You can use a simple frequency (DAILY, WEEKLY, BIWEEKLY, MONTHLY, QUARTERLY,
SEMI_ANNUAL, ANNUAL, BIENNIAL) or a custom rule:

- INTERVAL_DAYS: repeat every N days.
- WEEKLY: repeat on chosen weekdays (Monday to Sunday).
- MONTHLY_DAY: repeat on a chosen day of the month.
- MONTHLY_NTH: repeat on the first, second, third, fourth, fifth or last chosen
  weekday of the month.

A rule can also end on a date or after a number of occurrences.

### 8.3 Previewing and generating

- "Preview" shows how many targets the schedule will create tasks for, and the
  next few occurrence dates. Use it before you commit.
- "Run generation" creates tasks for every schedule that is due and has no
  open generated task yet. Each generated task is SCHEDULED and marked as
  coming from the schedule.

Task generation also runs automatically at startup and periodically, so due
work appears even if nobody clicks the button.

---

## 9. Checklists

Checklists turn procedures into structured, gradable field steps.

### 9.1 Templates and steps

Open Checklists. The "Templates" tab lists every checklist template with its
status. To create one:

1. Click "+ Add Template".
2. Enter the name, code, category, asset type and task type.
3. Enter applicable voltage, estimated minutes, safety notes, materials and
   required personnel.
4. Choose whether the template is mandatory, requires supervisor
   verification, and requires GPS confirmation.
5. Save.

A new template starts in DRAFT. Add steps under "Procedure Steps": each step
has an instruction, a section, a response type, whether it is required, whether
it is a critical step, pass criteria and any test equipment. Then click
"Activate template" to make it usable on tasks.

Response types:

| Type | How it is graded |
|---|---|
| PASS_FAIL | Pass or fail. |
| YES_NO | Yes or no. |
| SELECT | The selected value must be in the allowed pass set. |
| NUMERIC | The value must fall within the inclusive minimum and maximum. |
| TEXT | Free text, recorded as evidence. |
| PHOTO | A photo is attached as evidence. |
| GPS_POINT | The captured point must fall inside the geofence. |

A template that is in use by a task cannot be deleted. Edit it and the change
applies to future runs.

### 9.2 Running a checklist

1. Open the task in Task Detail.
2. Click "Run checklist". A run modal opens with every step.
3. Complete each step and attach photos or GPS points where required.
4. Click "Submit execution".

On submission, TMMS grades the run: any missing required item leaves it
INCOMPLETE; a failed critical step or a failed GPS point makes the overall
result FAIL; other failures also produce FAIL; otherwise the run is PASS. The
task then moves to PENDING_VERIFICATION.

The "Executions" tab lists every run with its template, task and PASS/FAIL
counts, so you can audit exactly what was checked.

---

## 10. GPS validation and geofences

### 10.1 Recording a validation

1. Open GPS and click "+ Record Validation".
2. Choose the target type (REGION, SUBSTATION, LINE, TOWER or ASSET) and the
   target.
3. Click "Use device GPS" to capture your current position, or enter the
   measured coordinates and accuracy manually.
4. Add the method and notes, then save.

TMMS compares the measured position to the expected position. Within the
tolerance (default 500 m) the result is PASS and the target is marked GPS
validated; otherwise the result is FAIL.

### 10.2 Reviewing violations

The "Violations" panel surfaces every GPS violation so it is never missed.
Possible violation types are OUTSIDE_REGION_BOUNDARY,
OUTSIDE_SUBSTATION_BOUNDARY, OUTSIDE_GEOFENCE and OUT_OF_TOLERANCE. Each
violation has a review status: OPEN, ACKNOWLEDGED, RESOLVED, REJECTED or
NOT_REQUIRED. Available actions are:

- "Reject (false alarm)" when the reading is wrong.
- "Acknowledge" to take ownership.
- "Resolve" once the issue is handled.

"Correct" opens a correction dialog. "Apply & re-validate" updates the target
coordinates and re-runs the check, which is useful when the recorded location
was wrong but the equipment is in the right place.

### 10.3 Geofences

Geofences define allowed areas:

1. In the Geofences panel, click "+ New Geofence".
2. Choose a circle, polygon or route-corridor shape.
3. Draw it on the map and set the radius and tolerance where applicable.
4. Save.

Active geofences are enforced during GPS checks and checklist GPS steps.
Deactivate a fence instead of deleting it when it is temporarily not needed.

---

## 11. Certifications

Open Certifications to manage qualifications. Certifications are grouped by
region, crew and person, and each is marked VALID or EXPIRED; certificates
approaching expiry (within 90 days) are highlighted as expiring.

The supported certification types are:

- LIVE_LINE
- HEIGHT_WORK
- FIRST_AID
- SWITCHING_AUTHORITY
- SF6_HANDLING
- HVDC_QUALIFIED
- CONFINED_SPACE
- HV_TESTING
- TOWER_CLIMBING
- DIGGER_OPERATOR

Each certification records the person, the type, the issuing body, the issue
date and the expiry date. Only valid, unexpired certifications count toward
dispatch eligibility, so keep expiry dates current. The Crews page also shows
a "Certifications Expiring / Expired" list so managers can act before a
qualification lapses.

---

## 12. Reports and documents

### 12.1 Reports

Open Reports to generate and read outputs.

1. Click "+ Generate Report".
2. Choose the report type and the period (start and end dates).
3. Optionally scope it to a region.
4. Generate, then "View" it. Use print for a paper or PDF copy.

Seeded analytical templates include MAINTENANCE_COMPLETION, ASSET_CONDITION,
CREW_UTILIZATION, OUTAGE_INCIDENT, COMPLIANCE_AUDIT, OVERDUE_TASK,
SCHEDULE_ADHERENCE and GPS_COVERAGE. "Field Team Performance" can be grouped
either "By crew" or "By person".

From any report you can drill down into a document for the underlying asset,
crew, task or line, then navigate back. Documents are also available directly:

- ASSET_DETAIL, CREW_DETAIL, TASK_DETAIL and LINE_DETAIL.
- ASSET_VALUATION and MAINTENANCE_COST for financial views.

Reports respect your scope: a manager sees their area, while global roles see
everything.

---

## 13. Value and cost

Open "Value & Cost" to see the financial picture. It has three tabs:

- Valuation: asset value "By region", "By location" and "By family", with a
  list of unpriced asset types that need prices.
- Maintenance cost: "Monthly spend", "By event type" and "Recent events".
- Prices: the price table. Click "Update" to change the unit price used for an
  asset type.

Keep the price table complete so valuations and cost roll-ups are accurate.

---

## 14. Organization

Open Organization to view and manage the organizational hierarchy, from the CEO
through business units and divisions to directorates and departments. The page
shows an expandable tree and an "All Units" table.

To add a unit:

1. Click "+ Add Unit" (or "+ Add Subunit" on an existing unit).
2. Enter the unit type and details.
3. Save.

Unit types include CORPORATE, BUSINESS_UNIT, DIVISION, REGION_DIRECTORATE,
DEPARTMENT, SUBSTATION_UNIT, SUBSTATION_MAINTENANCE,
TRANSMISSION_MAINTENANCE, RELAY_SCADA_TELECOM and OPERATIONAL_TECHNOLOGY.

Unit detail shows its crews, personnel and child units. A unit with children
cannot be removed until the children are moved or removed. Managers only see
their own subtree.

---

## 15. Settings and administration

Open Settings. The tabs available depend on your role:

- Global Settings: default language (English, Español, 中文, አማርኛ), unit system
  (metric or imperial), time zone and date locale. Only administrators can
  change and save these.
- Audit Log: the record of who changed what and when (requires audit access).
- Persons: the people register. Add, edit, activate/deactivate and delete
  people (requires people access).
- Users: login accounts. Add, edit, activate/deactivate and delete users
  (administrators only). Link each account to a person and set its role.

Best practice: deactivate ("Disable") accounts and people who leave rather than
deleting them, so historical records keep their references.

---

## 16. Map

The Map is the situational-awareness view. Toggle layers for regions,
substations, lines, towers, assets, geofences, alerts and tasks.

Map controls:

- Search to find a place or asset.
- "Locate me" to centre on your device position.
- "Fit bounds" and "Refresh map".
- Fullscreen, and "Guide" for an on-map help panel.
- Filters, and "Clear filters".
- "Copy coordinates" to share a location.
- Click a feature to reveal its popup (voltage, condition, criticality, GPS
  warning, and so on).

The Map is read-oriented; edit records in their registers.

---

## 17. Glossary

| Term | Definition |
|---|---|
| Asset | A physical piece of equipment on the network. |
| Bay | A switchgear compartment within a substation. |
| CBM | Condition-based maintenance, driven by measured condition. |
| Checklist | A standardized procedure executed step by step. |
| Critical step | A checklist step that fails the whole run if it fails. |
| Crew | A field team that performs work. |
| Document | A printable summary of one asset, crew, task or line. |
| Execution | One completed run of a checklist. |
| Follow-up | A corrective task raised automatically after a failure. |
| Geofence | An allowed area for GPS checks. |
| GPS validation | A check that a recorded location matches reality. |
| Preventive maintenance | Scheduled work to prevent failure. |
| Scope | The part of the organization a manager is responsible for. |
| Segregation of duties | The executor cannot verify their own work. |
| SLA / overdue | Work past its due date. |
| Tower | A structure carrying a transmission line. |
| Work item | A single checklist step bound to a task. |

---

## 18. Frequently asked questions

Why can I not see a button or menu item?
Your role does not allow that action, or the record is outside your scope.
Ask a manager or administrator.

Why can I not submit or verify a task?
A task with a checklist cannot be submitted or verified until every required
item is graded. A checklist that requires GPS confirmation also needs a GPS
validation on record. And the person who executed the checklist cannot verify
it themselves.

Why is a task not being generated from my schedule?
Check that the schedule is active, that its next due date has arrived, and that
it has no open generated task already. Use "Preview" to confirm the targets and
dates, or "Run generation" to force it.

Why is a crew shown as not eligible?
The crew is missing skills or required certifications, or it is too small for
the checklist team size. Review the "Missing skills", "Missing certs" and
"Certs to obtain" columns. Eligibility is advisory, so you may still dispatch
if the gap is acceptable.

Why does a certification no longer count?
Only VALID, unexpired certifications count. Renew the certification and update
its expiry date.

Why does the map dot look wrong?
Record a GPS validation for the target. If the recorded coordinates were wrong,
use "Correct" with "Apply & re-validate" to fix and re-check them.

How do I change the language?
Use the selector in the top bar. The page reloads in the chosen language.

How do I get a printable copy of a record?
Use the print control on a report or document, or the browser print function.

---

End of manual.
