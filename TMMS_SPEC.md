# Transmission Asset Management System (TMMS) — System Specification

**Document Type:** System Specification / Operational Reference
**Scope:** Full lifecycle management of transmission infrastructure maintenance
**Audience:** System architects, developers, operations staff, field crews, compliance auditors

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [System Architecture](#2-system-architecture)
3. [Domain 1 — Regions](#3-regions)
4. [Domain 2 — Substations](#4-substations)
5. [Domain 3 — Transmission Lines](#5-transmission-lines)
6. [Domain 4 — Assets](#6-assets)
7. [Domain 5 — Tasks](#7-tasks)
8. [Domain 6 — Crews](#8-crews)
9. [Domain 7 — Maintenance Schedules](#9-maintenance-schedules)
10. [Domain 8 — Reports](#10-reports)
11. [Domain 9 — GPS Validation](#11-gps-validation)
12. [Domain 10 — Checklists](#12-checklists)
13. [Domain 11 — Integrated Map](#13-integrated-map)
14. [Inter-Domain Relationships](#14-inter-domain-relationships)
15. [End-to-End Workflows](#15-end-to-end-workflows)
16. [Shared Reference Data & Enumerations](#16-shared-reference-data)
17. [API Surface Summary](#17-api-surface-summary)
18. [Data Integrity, Security & Compliance](#18-data-integrity-security-compliance)
19. [State-of-the-Art Recommendation](#19-state-of-the-art-recommendation)

---

## 1. System Overview

TMMS is a geographic, asset-centric maintenance management platform for electrical power transmission infrastructure. It unifies spatial data (regions, substations, lines, assets), operational data (tasks, crews, schedules), and compliance data (checklists, reports, GPS validation) into a single authoritative system of record.

### 1.1 Primary Objectives

- Maintain a single, accurate inventory of all transmission assets with their condition.
- Plan, dispatch, and track preventive/corrective/emergency maintenance and inspections.
- Verify the physical (GPS-validated) location of assets against the recorded location.
- Enforce standardized inspection and maintenance procedures via checklists.
- Produce operational, compliance, and management reports.
- Provide a live geographic map with status overlays for situational awareness.

### 1.2 Guiding Principles

- **Single Source of Truth:** Every asset, task, and location has one authoritative record.
- **Spatial-First:** All infrastructure is georeferenced; coordinates are validated before being trusted.
- **Closed-Loop Maintenance:** Every task follows Plan → Dispatch → Execute → Document → Verify.
- **Auditability:** All field data carries who/when/what provenance.
- **Regulatory Alignment:** Data model supports audit evidence for grid-code and reliability compliance.

### 1.3 Key Entities at a Glance

| Entity | Domain | Purpose |
|---|---|---|
| Region | Regions | Geographic organizational unit |
| Substation | Substations | Node where voltage transformation occurs |
| TransmissionLine | Transmission Lines | HV corridors linking substations |
| Asset | Assets | Physical equipment (transformers, breakers, towers, etc.) |
| Task | Tasks | Work orders for maintenance/inspection |
| Crew | Crews | Field work groups with certifications |
| MaintenanceSchedule | Schedules | Recurring maintenance plans |
| Report | Reports | Operational/compliance outputs |
| GpsValidation | GPS Validation | Coordinate verification records |
| Checklist | Checklists | Standardized step-by-step procedures |
| ChecklistTemplate | Checklists | Reusable checklist definitions |
| GeoLayer / MapView | Integrated Map | Map presentation configuration |

---

## 2. System Architecture

### 2.1 Logical Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Presentation Tier                     │
│   Web Console (management)  │  Mobile Field App (offline)   │
│   Integrated Map (GIS)      │  Reporting Dashboards         │
└─────────────────────────────┬───────────────────────────────┘
                              │ REST/GraphQL + WebSocket
┌─────────────────────────────▼───────────────────────────────┐
│                      Application Tier                       │
│   Service Layer: Region, Substation, Line, Asset, Task,     │
│   Crew, Schedule, Report, GpsValidation, Checklist, Map     │
│   Workflow Engine (task state machine, schedule generator)  │
│   Notification / Dispatch Service                           │
└─────────────────────────────┬───────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│                        Data Tier                            │
│   RDBMS (PostgreSQL + PostGIS for geometry)                 │
│   Document/Object store (checklist attachments, photos)     │
│   Cache (task queues, map tiles)                            │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Technology Notes

- **GIS storage:** PostGIS geometry columns for points (assets, substations), linestrings (transmission lines), polygons (regions, geofences).
- **Spatial reference:** WGS84 (EPSG:4326) for storage and interchange; local projected CRS (e.g., EPSG:3857/UTM) for distance calculations.
- **Mobile support:** Offline-first field app; queue of unsent task results and GPS fixes; sync reconciliation by entity UUID + revision.
- **Concurrency:** Optimistic locking via `revision` integer; server timestamps authoritative.

---

## 3. Regions

### 3.1 Purpose

Regions are the top-level geographic organizational unit. They group substations, transmission lines, crews, and field operations, and define the administrative boundaries for planning, budgeting, and reporting.

### 3.2 Data Model

**Table: `region`**

| Field | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK | System identifier |
| `code` | varchar(20) | UNIQUE, NOT NULL | Short unique code (e.g., `NE`, `SW`); used in asset IDs |
| `name` | varchar(100) | NOT NULL | Display name |
| `type` | enum | NOT NULL | `NORTHERN`, `SOUTHERN`, `EASTERN`, `WESTERN`, `CENTRAL`, `CUSTOM` |
| `boundary_geom` | geometry(Polygon,4326) | NOT NULL | Geofence polygon of the region |
| `center_lat` | double | NOT NULL | Region centroid latitude |
| `center_lng` | double | NOT NULL | Region centroid longitude |
| `status` | enum | NOT NULL, default `ACTIVE` | `ACTIVE`, `INACTIVE`, `PLANNING` |
| `region_manager_id` | FK → `person.id` | NULL | Assigned manager |
| `safety_officer_id` | FK → `person.id` | NULL | Assigned safety officer |
| `contact_phone` | varchar(30) | NULL | Operations contact |
| `contact_email` | varchar(120) | NULL | Operations contact |
| `timezone` | varchar(50) | NOT NULL | e.g., `America/New_York` |
| `address` | text | NULL | Service address |
| `notes` | text | NULL | Free text |
| `created_at`, `updated_at` | timestamptz | NOT NULL | Audit timestamps |
| `revision` | int | NOT NULL | Optimistic lock |

**Assigned personnel** — many-to-many via `region_personnel`:

| Field | Type | Description |
|---|---|---|
| `region_id` | FK | References region |
| `person_id` | FK | References person |
| `role` | enum | `MANAGER`, `SUPERVISOR`, `SAFETY_OFFICER`, `PLANNER`, `DISPATCHER`, `FIELD_ENGINEER` |
| `assigned_at` | timestamptz | Assignment date |
| `is_primary` | boolean | Primary role holder flag |

### 3.3 Relationships

- `1 → N` Substation (`substation.region_id`)
- `1 → N` TransmissionLine (`transmission_line.region_id`)
- `1 → N` Crew (`crew.region_id`)
- `M → N` Personnel (via `region_personnel`)
- `1 → N` GpsValidation scope records (validation targets within region)

### 3.4 Key Workflows

1. **Region creation:** Define code (unique), name, boundary polygon; assign manager/safety officer; status `PLANNING` → `ACTIVE`.
2. **Reassignment:** Moving a substation/line between regions triggers revalidation of geofence containment and an audit event; cascade updates crews and schedules that reference the region.
3. **Decommission (INACTIVE):** Only permitted when no `ACTIVE` tasks and no non-decommissioned assets exist in the region; otherwise blocked with a summary of blockers.

---

## 4. Substations

### 4.1 Purpose

Substations are the nodes where voltage transformation, switching, and protection occur. They aggregate assets and provide connection points for transmission lines.

### 4.2 Data Model

**Table: `substation`**

| Field | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK | System identifier |
| `substation_id` | varchar(40) | UNIQUE, NOT NULL | Human-readable ID (e.g., `SUB-NE-001`) |
| `name` | varchar(120) | NOT NULL | Display name |
| `region_id` | FK → `region.id` | NOT NULL | Owning region |
| `latitude`, `longitude` | double | NOT NULL | GPS location (WGS84) |
| `elevation_m` | double | NULL | Elevation |
| `voltage_levels` | varchar[] | NOT NULL | e.g., `{500kV, 220kV}` |
| `substation_type` | enum | NOT NULL | `TRANSFORMER`, `SWITCHING`, `TRANSFORMER_SWITCHING`, `GAS_INSULATED`, `HVDC_CONVERTER` |
| `operational_status` | enum | NOT NULL | `OPERATIONAL`, `MAINTENANCE`, `OUT_OF_SERVICE`, `DECOMMISSIONED`, `UNDER_CONSTRUCTION` |
| `commissioned_date` | date | NULL | In-service date |
| `decommissioned_date` | date | NULL | Removed-from-service date |
| `owner` | varchar(120) | NULL | Asset owner organization |
| `bay_count` | int | default 0 | Number of bays |
| `transformer_count` | int | default 0 | Denormalized count (recomputed) |
| `emergency_contact` | varchar(30) | NULL | |
| `gps_validated` | boolean | default false | True if latest GPS validation passed |
| `last_gps_validation_at` | timestamptz | NULL | |
| `revision` | int | NOT NULL | Optimistic lock |
| `created_at`, `updated_at` | timestamptz | NOT NULL | |

### 4.3 Relationships

- `N → 1` Region
- `1 → N` TransmissionLine end points (`transmission_line.from_substation_id`, `to_substation_id`)
- `1 → N` Assets (`asset.substation_id`)
- `1 → N` GpsValidation records (as `target_type=SUBSTATION`)
- `1 → N` Tasks (targetable object)

### 4.4 Key Workflows

1. **Commissioning:** Create substation under a region → assign voltage levels → link lines → register assets via bulk import → trigger GPS validation → operational_status `UNDER_CONSTRUCTION` → `OPERATIONAL`.
2. **Connection of a transmission line:** Update line `from/to_substation_id`; validate line endpoints are within 500 m of the referenced substation point (auto-flag discrepancy).
3. **Outage declaration:** `OPERATIONAL` → `MAINTENANCE`/`OUT_OF_SERVICE` requires an associated corrective/emergency task or scheduled outage; generates notification to affected line and asset records.
4. **Decommissioning:** Requires no active tasks, no energized lines connected, all assets decommissioned or removed; after decommission, assets auto-flag `REMOVED`.

---

## 5. Transmission Lines

### 5.1 Purpose

Transmission lines are the high-voltage corridors linking substations. They own the linear geometry (route), tower inventory, and corridor-level maintenance history.

### 5.2 Data Model

**Table: `transmission_line`**

| Field | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK | System identifier |
| `line_id` | varchar(40) | UNIQUE, NOT NULL | e.g., `TL-NE-201` |
| `name` | varchar(120) | NOT NULL | e.g., "Northport–Milford 500 kV" |
| `region_id` | FK → `region.id` | NOT NULL | Owning region |
| `from_substation_id` | FK → `substation.id` | NOT NULL | Sending-end substation |
| `to_substation_id` | FK → `substation.id` | NOT NULL | Receiving-end substation |
| `route_geom` | geometry(LineString,4326) | NOT NULL | Surveyed route polyline |
| `voltage_kv` | int | NOT NULL | e.g., 138, 220, 345, 500, 765 |
| `line_type` | enum | NOT NULL | `OVERHEAD`, `UNDERGROUND`, `MIXED` |
| `length_km` | double | NOT NULL | Route length |
| `conductor_type` | varchar(80) | NULL | e.g., `ACSR 954 kcmil`, `ACSS` |
| `conductor_count_per_phase` | int | default 1 | Bundle conductor count |
| `circuit_count` | int | default 1 | Number of circuits |
| `tower_count` | int | default 0 | Denormalized count (recomputed) |
| `insulator_count` | int | default 0 | Denormalized count |
| `construction_date` | date | NULL | |
| `commissioned_date` | date | NULL | |
| `rating_mva` | double | NULL | Thermal rating |
| `right_of_way_width_m` | double | NULL | ROW corridor width |
| `operational_status` | enum | NOT NULL | `ENERGIZED`, `DE_ENERGIZED`, `UNDER_MAINTENANCE`, `RETIRED`, `UNDER_CONSTRUCTION` |
| `gps_validated` | boolean | default false | |
| `revision` | int | NOT NULL | |

### 5.3 Tower / Structure Inventory

**Table: `tower`** (subset of Asset with role `TOWER`; see Domain 6)

| Field | Type | Description |
|---|---|---|
| `id` | UUID PK | |
| `line_id` | FK → line | Owning line |
| `tower_number` | varchar(20) | Along-route numbering (e.g., `N201-045`) |
| `km_marker` | double | Chainage along route |
| `latitude`, `longitude` | double | Footing coordinates |
| `tower_type` | enum | `SUSPENSION`, `TENSION`, `ANGLE`, `DEAD_END`, `TRANSITION` |
| `tower_material` | enum | `LATTICE_STEEL`, `TUBULAR_STEEL`, `CONCRETE`, `WOOD`, `COMPOSITE` |
| `foundation_type` | enum | `PAD`, `RAFT`, `PILE`, `ROCK_ANCHOR` |
| `height_m` | double | |
| `base_width_m` | double | |
| `corrosion_rating` | int | 1–10 condition scale |

### 5.4 Relationships

- `N → 1` Region; `N → 1` from/to Substation (both ends)
- `1 → N` Tower
- `1 → N` `tower_component` records (standard parts register per tower; see §15.8)
- `1 → N` Asset records (conductors, insulators, dampers, hardware) positioned along the line
- `1 → N` GpsValidation records (`target_type=LINE`, polyline accuracy sampling)
- `1 → N` Tasks (targetable object)

### 5.5 Key Workflows

1. **Line registration:** Create with endpoints → enter surveyed route polyline → auto-compute length (GIS geodesic) → import tower list (Excel/CSV, §15.8) → verify endpoints against substation geofences. Once towers exist, the line route is rebuilt from tower locations (tower positions ARE the route points).
2. **Tower numbering validation:** Validate `tower_number` sequence monotonic vs. `km_marker`; flag out-of-order entries.
3. **Line outage for maintenance:** Set `UNDER_MAINTENANCE`; auto-generate notification tasks for endpoints; block non-emergency concurrent tasks that require energization.
4. **Route correction:** Survey crews submit corrected `route_geom`; change requires GPS validation sampling pass along the new route and audit of prior validation records.

---

## 6. Assets

### 6.1 Purpose

Assets are the physical equipment of the transmission network. The Asset domain is the condition and lifecycle record for every component.

### 6.2 Asset Type Hierarchy

Assets are classified by `asset_type` (primary) and optional `sub_type`. Canonical types:

| Category | Asset Types |
|---|---|
| Transformation | `TRANSFORMER`, `AUTO_TRANSFORMER`, `BUSHING` |
| Switching | `CIRCUIT_BREAKER`, `DISCONNECTOR` (isolator), `GROUND_SWITCH`, `SWITCHGEAR`, `GIS` (indoor switchgear) |
| Protection | `PROTECTION_RELAY`, `RELAY_PANEL`, `CT` (current transformer), `VT` (voltage transformer) |
| Conductors | `CONDUCTOR_SPAN`, `BUSBAR`, `JUMPER`, `LINE_CONDUCTOR`, `OPGW` |
| Structures | `TOWER`, `POLE`, `FOUNDATION` |
| Insulation | `INSULATOR_STRING`, `INSULATOR_DISC`, `ARRESTER` (surge), `STRAIN_INSULATOR`, `LIGHTNING_ARRESTER` |
| Control & Comms | `SCADA_RTU`, `SUBSTATION_CONTROLLER`, `IED`, `COMMUNICATION_RADIO`, `OPTICAL_FIBER` |
| Ancillary | `DAMPER`, `SPACER`, `HARDWARE_FITTING`, `CABLE_JOINT`, `EARTHING_MAT`, `SECURITY_FENCE`, `BATTERY_BANK`, `METER` |

Every asset also carries a `location_type` (`OUTDOOR`, `INDOOR`, `BUILDING`, `CELLAR`, `UNDERGROUND`) and an optional `bay`/feeder-bay identifier to locate the device within a substation yard or building.

### 6.3 Data Model

**Table: `asset`** (common core; extended by type-specific tables)

| Field | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK | |
| `asset_id` | varchar(40) | UNIQUE, NOT NULL | e.g., `XFR-NE-001-T1` |
| `asset_type` | enum | NOT NULL | See hierarchy |
| `sub_type` | varchar(60) | NULL | Type-specific refinement |
| `substation_id` | FK → `substation.id` | NULL* | If located in a substation |
| `line_id` | FK → `line.id` | NULL* | If located on a line |
| `tower_id` | FK → `tower.id` | NULL* | If tower-mounted |
| `parent_asset_id` | FK → `asset.id` | NULL | Composition parent (e.g., bushing → transformer) |
| `name` | varchar(120) | NOT NULL | |
| `manufacturer` | varchar(120) | NULL | |
| `model` | varchar(120) | NULL | |
| `serial_number` | varchar(80) | NULL | |
| `installation_date` | date | NULL | |
| `commissioned_date` | date | NULL | |
| `manufacture_date` | date | NULL | |
| `latitude`, `longitude` | double | NULL* | Location point |
| `condition_rating` | int | NOT NULL, 1–10 | 1=critical, 10=new |
| `condition_assessed_at` | timestamptz | NULL | |
| `lifecycle_status` | enum | NOT NULL | `IN_SERVICE`, `SPARE`, `UNDER_MAINTENANCE`, `DEFECTIVE`, `REMOVED`, `DECOMMISSIONED` |
| `operational_status` | enum | NOT NULL | `OPERATIONAL`, `DEGRADED`, `OUT_OF_SERVICE` |
| `health_index` | decimal | NULL | Computed from condition + age + failure history |
| `remaining_useful_life_years` | decimal | NULL | Computed |
| `failure_history_count` | int | default 0 | Denormalized |
| `criticality` | enum | NOT NULL | `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` |
| `warranty_expiry` | date | NULL | |
| `last_maintenance_at` | timestamptz | NULL | |
| `next_maintenance_at` | timestamptz | NULL | |
| `gps_validated` | boolean | default false | |
| `last_gps_validation_at` | timestamptz | NULL | |
| `metadata` | jsonb | NULL | Type-specific attributes |
| `revision` | int | NOT NULL | |

*Exactly one location anchor (`substation_id`, `line_id`, or explicit lat/lng) must resolve; validated by constraint.

### 6.4 Asset Maintenance History

**Table: `asset_maintenance_event`**

| Field | Type | Description |
|---|---|---|
| `id` | UUID PK | |
| `asset_id` | FK | Target asset |
| `task_id` | FK → `task.id` | Originating task (nullable for warranty claims) |
| `event_type` | enum | `PREVENTIVE`, `CORRECTIVE`, `EMERGENCY`, `INSPECTION`, `OVERHAUL`, `REPAIR`, `REPLACEMENT`, `DIAGNOSTIC_TEST` |
| `performed_at` | timestamptz | |
| `crew_id` | FK | Executing crew |
| `work_summary` | text | Narrative |
| `measured_values` | jsonb | Test/diagnostic readings (oil, IR, SF6, etc.) |
| `condition_after` | int | 1–10 |
| `cost` | decimal | |
| `documents` | uuid[] | Attachment IDs |

### 6.5 Type-Specific Extensions (examples)

- **Transformer (`asset_type=TRANSFORMER`)**: `rating_mva`, `voltage_ratio` (e.g., `500/230`), `vector_group` (e.g., `YNd11`), `oil_volume_l`, `oil_type`, `tap_changer_type`, `cooling_type` (ONAF/ONAN), `winding_temp`, `gas_pressure`.
- **Circuit breaker**: `interrupting_rating_ka`, `operating_mechanism` (SF6/air/vacuum/oil), `operating_voltage_kv`, `puffer_type`, `op_count` (operations counter).
- **Protection relay**: `relay_firmware_version`, `relay_type` (distance/differential/overcurrent), `scheme`, `communication_protocol` (IEC 61850, Modbus, DNP3), `settings_file_ref`.
- **SCADA RTU**: `protocol`, `point_count`, `firmware_version`, `last_comm_test_at`.

### 6.6 Relationships

- `N → 1` Substation / Line / Tower / parent Asset (location + composition)
- `1 → N` AssetMaintenanceEvent
- `1 → N` Task (targetable object)
- `1 → N` GpsValidation (`target_type=ASSET`)
- `1 → N` MaintenanceSchedule (schedule templates applicable to asset class/individual asset)
- `1 → N` ChecklistResult (via task execution)

### 6.7 Key Workflows

1. **Asset registration:** Create with location anchor → validate serial uniqueness per manufacturer+model+substation → assign condition rating → criticality classification → enroll in applicable maintenance schedules.
2. **Condition assessment:** Field crew performs inspection checklist → records `condition_rating` → system recomputes `health_index`, `remaining_useful_life`, and flags assets below criticality threshold for planning.
3. **Failure/defect workflow:** `operational_status=DEGRADED` or `DEFECTIVE` lifecycle → auto-generate corrective task → when resolved, record maintenance event and update condition.
4. **Replacement:** New asset created with `installation_date`; old asset lifecycle → `REMOVED`, decommissioned date set; parent/child links re-pointed; maintenance history retained for audit.

---

## 7. Tasks

### 7.1 Purpose

Tasks are the unit of work: maintenance, inspection, and corrective actions executed by crews against assets, substations, or lines.

### 7.2 Data Model

**Table: `task`**

| Field | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK | |
| `task_number` | varchar(30) | UNIQUE, NOT NULL | e.g., `TK-2026-000123` |
| `title` | varchar(160) | NOT NULL | |
| `description` | text | NULL | |
| `task_type` | enum | NOT NULL | `PREVENTIVE`, `CORRECTIVE`, `EMERGENCY`, `INSPECTION`, `REPLACEMENT`, `TESTING`, `REPAIR` |
| `priority` | enum | NOT NULL | `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` |
| `status` | enum | NOT NULL | `DRAFT`, `SCHEDULED`, `ASSIGNED`, `IN_PROGRESS`, `ON_HOLD`, `PENDING_VERIFICATION`, `COMPLETED`, `CANCELLED`, `FAILED` |
| `region_id` | FK → `region.id` | NOT NULL | |
| `substation_id` | FK → `substation.id` | NULL | Optional target |
| `line_id` | FK → `line.id` | NULL | Optional target |
| `tower_id` | FK → `tower.id` | NULL | Optional tower target (with `line_id`); GPS confirmation validates against the tower |
| `asset_id` | FK → `asset.id` | NULL | Optional target |
| `checklist_template_id` | FK → `checklist_template.id` | NULL | Required procedure |
| `crew_id` | FK → `crew.id` | NULL | Assigned crew |
| `priority_reason` | varchar(30) | NULL | e.g., `NEAR_MISS`, `REGULATORY`, `AGE`, `FAULT` |
| `due_date` | timestamptz | NOT NULL | |
| `scheduled_start` | timestamptz | NULL | |
| `scheduled_end` | timestamptz | NULL | |
| `actual_start` | timestamptz | NULL | |
| `actual_end` | timestamptz | NULL | |
| `created_by` | FK → person | NOT NULL | |
| `assigned_by` | FK → person | NULL | |
| `verified_by` | FK → person | NULL | Supervisor verification |
| `completion_summary` | text | NULL | |
| `result` | enum | NULL | `PASS`, `FAIL`, `PARTIAL`, `DEFERRED` |
| `is_offline_created` | boolean | default false | Created on mobile |
| `source` | enum | NOT NULL | `MANUAL`, `SCHEDULE_GENERATED`, `AUTO_GENERATED_DEFECT`, `INCIDENT`, `GIS_DISCREPANCY` |
| `permit_required` | boolean | default false | PTW (permit to work) needed |
| `permit_number` | varchar(40) | NULL | |
| `is_energized_work` | boolean | default false | |
| `loto_required` | boolean | default false | Lockout/tagout |
| `created_at`, `updated_at` | timestamptz | NOT NULL | |
| `revision` | int | NOT NULL | |

### 7.3 Task Status State Machine

```
DRAFT ──► SCHEDULED ──► ASSIGNED ──► IN_PROGRESS ──► PENDING_VERIFICATION ──► COMPLETED
                  │          │            │                  │
                  │          │            ├──► ON_HOLD ◄─────┘ (blocked, weather, parts)
                  │          │            │
                  │          ▼            ▼
                  └────► CANCELLED    FAILED (rework → new corrective task)
```

Rules:
- Only `SCHEDULED`/`ASSIGNED` tasks are dispatchable.
- `IN_PROGRESS` requires `crew_id` set and checklist started.
- `COMPLETED` requires `result`, `completion_summary`, executed checklist with all required steps marked, and (if `checklist_template` mandates) supervisor verification.
- `EMERGENCY` tasks may bypass `DRAFT`→`SCHEDULED` (created directly as `ASSIGNED`).
- `CANCELLED` requires reason code + authorizing role.

### 7.4 Task Linking

**Table: `task_link`** (task dependencies & references)

| Field | Type | Description |
|---|---|---|
| `task_id` | FK | |
| `linked_task_id` | FK | |
| `link_type` | enum | `DEPENDS_ON`, `RELATED`, `BLOCKED_BY`, `SUBTASK_OF`, `GENERATED_FROM` |

### 7.5 Relationships

- `N → 1` Region; optional `N → 1` Substation/Line/Asset target
- `N → 1` Crew
- `N → 1` ChecklistTemplate
- `1 → N` GpsValidation (field confirmation during task execution)
- `1 → N` ChecklistResult (execution records)
- `1 → N` AssetMaintenanceEvent (when task completes maintenance on asset)
- `M → N` Task links

### 7.6 Key Workflows

1. **Manual creation:** Planner defines target, type, priority, due date, required checklist; status `DRAFT` → `SCHEDULED`.
2. **Auto-generation from schedule:** Schedule generator emits `PREVENTIVE`/`INSPECTION` tasks on `next_due_date` (see Domain 7).
3. **Auto-generation from defect/condition:** Asset condition drops below threshold or operational_status becomes `DEGRADED` → corrective task (`source=AUTO_GENERATED_DEFECT`).
4. **Dispatch:** Dispatcher assigns crew respecting availability & certifications; `SCHEDULED` → `ASSIGNED`; crew notified.
5. **Execution (field):** Crew starts task → `IN_PROGRESS`; runs checklist; records GPS-confirmed position, photos, measurements; submits → `PENDING_VERIFICATION`.
6. **Verification:** Supervisor reviews result/attachments → `COMPLETED` (or returns with comments → `ON_HOLD`/reopens `IN_PROGRESS`).
7. **Closure side effects:** Update asset `last_maintenance_at`, `condition_rating`, `lifecycle_status`; write `asset_maintenance_event`; reschedule next occurrence of recurring schedule.

---

## 8. Crews

### 8.1 Purpose

Crews are the field work groups that execute maintenance and inspection tasks. The domain manages roster, leader, skills, certifications, and availability.

### 8.2 Data Model

**Table: `crew`**

| Field | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK | |
| `name` | varchar(100) | NOT NULL | |
| `crew_code` | varchar(20) | UNIQUE | e.g., `CREW-NE-03` |
| `crew_type` | enum | NOT NULL | `MAINTENANCE`, `INSPECTION`, `EMERGENCY_RESPONSE`, `CONSTRUCTION`, `RELAY_AND_PROTECTION`, `SUBSTATION`, `LINE` |
| `region_id` | FK → `region.id` | NOT NULL | Home region |
| `leader_person_id` | FK → `person.id` | NOT NULL | Crew leader |
| `home_base` | varchar(120) | NULL | Depot / staging location |
| `base_lat`, `base_lng` | double | NULL | |
| `size` | int | default 0 | Denormalized member count |
| `status` | enum | NOT NULL | `AVAILABLE`, `ON_SITE`, `ON_LEAVE`, `DISABLED` |
| `certification_profile` | jsonb | NULL | Aggregate cert summary |
| `vehicles` | varchar[] | NULL | Assigned vehicles |
| `revision` | int | NOT NULL | |

**Table: `crew_member`** (roster; references person)

| Field | Type | Description |
|---|---|---|
| `id` | UUID PK | |
| `crew_id` | FK | |
| `person_id` | FK → `person.id` | |
| `role` | enum | `CREW_LEADER`, `LINEMAN`, `ELECTRICIAN`, `TECHNICIAN`, `SAFETY_WATCH`, `APPRENTICE`, `DRIVER` |
| `joined_at` | date | |
| `active` | boolean | |
| `skill_level` | enum | `JUNIOR`, `INTERMEDIATE`, `SENIOR`, `EXPERT` |

**Table: `certification`**

| Field | Type | Description |
|---|---|---|
| `id` | UUID PK | |
| `person_id` | FK | |
| `cert_type` | enum | `LIVE_LINE`, `HEIGHT_WORK`, `FIRST_AID`, `SWITCHING_AUTHORITY`, `CONFINED_SPACE`, `HOT_STICK`, `HVDC_QUALIFIED`, `OIL_HANDLING`, `SF6_HANDLING`, `SCAFFOLD_ERECTION` |
| `issuing_body` | varchar(120) | |
| `issued_at` | date | |
| `expires_at` | date | |
| `status` | enum | `VALID`, `EXPIRED`, `SUSPENDED` |

**Table: `crew_availability`** (shift-level availability)

| Field | Type | Description |
|---|---|---|
| `id` | UUID PK | |
| `crew_id` | FK | |
| `day_of_week` | smallint | 0–6 |
| `shift_start` | time | |
| `shift_end` | time | |
| `effective_from`, `effective_to` | date | Validity window |

**Table: `crew_assignment_override`** (blocked/unavailable windows)

| Field | Type | Description |
|---|---|---|
| `id` | UUID PK | |
| `crew_id` | FK | |
| `reason` | enum | `LEAVE`, `TRAINING`, `OUTAGE_OPPORTUNITY`, `EQUIPMENT_DOWN`, `WEATHER` |
| `from`, `to` | timestamptz | Window |

### 8.3 Relationships

- `N → 1` Region
- `1 → N` CrewMember → Person
- `1 → N` Certification (per person, linked to crew roster)
- `1 → N` Task (assigned tasks)
- `1 → N` CrewAvailability / CrewAssignmentOverride
- Person is shared reference (Region personnel, Task creator, Verifier all reference same Person entity)

### 8.4 Key Workflows

1. **Crew creation:** Create crew with leader → add members → assign certifications → set availability rosters.
2. **Certification expiry monitoring:** Daily job checks `expires_at`; flags expired certs; crew `status` downgraded or restricted from task types requiring the cert.
3. **Dispatch eligibility check (task assignment):** Match task requirements (task type, required certs) against crew member certifications + availability window + region; return scored candidate crews.
4. **Shift management:** Dispatcher reviews availability and overrides; over-allocated crews flagged.
5. **Utilization tracking:** Compute crew utilization = charged hours / available hours for reporting (Domain 8).

---

## 9. Maintenance Schedules

### 9.1 Purpose

Maintenance Schedules define recurring preventive maintenance plans. They drive auto-generation of tasks on due dates.

### 9.2 Data Model

**Table: `maintenance_schedule`**

| Field | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK | |
| `schedule_name` | varchar(120) | NOT NULL | e.g., "Transformer Oil Sampling — 6 Monthly" |
| `schedule_code` | varchar(30) | UNIQUE | |
| `scope_type` | enum | NOT NULL | `ASSET`, `ASSET_CLASS`, `SUBSTATION`, `LINE`, `LINE_TOWERS`, `TOWER`, `REGION` |
| `asset_type` | enum | NULL | If `scope_type=ASSET_CLASS` |
| `asset_id` | FK | NULL | If `scope_type=ASSET` |
| `substation_id` / `line_id` / `tower_id` / `region_id` | FK | NULL | Per scope_type |
| `frequency` | enum | NOT NULL | `DAILY`, `WEEKLY`, `BIWEEKLY`, `MONTHLY`, `QUARTERLY`, `SEMI_ANNUAL`, `ANNUAL`, `BIENNIAL`, `CUSTOM_DAYS` |
| `custom_frequency_days` | int | NULL | If `CUSTOM_DAYS` |
| `frequency_config` | jsonb | NULL | e.g., day-of-month, week-of-year |
| `checklist_template_id` | FK | NOT NULL | Associated procedure |
| `responsible_crew_id` | FK → `crew.id` | NULL | Preferred crew |
| `priority` | enum | NOT NULL | Generated-task priority |
| `lead_time_days` | int | default 7 | Warning period before due |
| `next_due_date` | timestamptz | NOT NULL | Next auto-generation date |
| `last_generated_at` | timestamptz | NULL | |
| `is_active` | boolean | default true | |
| `requires_planned_outage` | boolean | default false | |
| `expected_duration_hours` | double | NULL | |
| `estimated_labor_hours` | double | NULL | |
| `instructions` | text | NULL | |
| `revision` | int | NOT NULL | |

### 9.3 Schedule Generation Algorithm

1. Daily job scans active schedules where `next_due_date <= today + lead_time_days`.
2. For each, check for an existing open task with same `source=schedule` and same target + schedule within the current period → skip (prevent duplicates).
3. Apply business rules (skip days, outage windows, seasonality) from `frequency_config`.
4. Generate task with:
   - `task_type = PREVENTIVE` (or `INSPECTION` if checklist kind is inspection)
   - `priority` from schedule
   - `due_date = next_due_date`
   - `checklist_template_id` from schedule
   - `source = SCHEDULE_GENERATED`, `schedule_id` recorded
5. Update `last_generated_at`; compute next period: `next_due_date += period` (calendar-aware).
6. If crew overrides exist at that window, the dispatcher is notified to reassign.

### 9.4 Relationships

- `N → 1` ChecklistTemplate
- `N → 1` Crew (preferred, nullable)
- Target references: Asset / AssetClass / Substation / Line / Tower (single) / LineTowers (every tower on a line) / Region
- `1 → N` Task (generated tasks carry `schedule_id`)

> **Tower scopes:** `TOWER` generates one task for a single tower; `LINE_TOWERS` expands to one task per tower on the selected line (ordered by `km_marker`). Generated tower tasks set both `line_id` and `tower_id`, and the schedule auto-derives `region_id` from the target line/substation/tower when not supplied.

### 9.5 Key Workflows

1. **Schedule creation & enrollment:** Create schedule bound to asset/class → run dry-run preview of next N occurrences → confirm → `is_active=true`.
2. **Rolling generation:** Automated daily generation as above.
3. **Deferral:** Completed task may return `result=DEFERRED` with reason → next occurrence re-pinned per deferral policy (bounded, e.g., max 25% of cycle, requires manager approval beyond that).
4. **Rescheduling:** Manual change of `next_due_date` (regulatory windows, outage coordination); audit-trailed.
5. **Retirement:** Schedule deactivated; open generated tasks still honored or cancelled with approval.

---

## 10. Reports

### 10.1 Purpose

Reports convert operational data into decision and compliance artifacts. The domain defines report types, templates, generation, and distribution.

### 10.2 Report Catalog

| Report | Category | Key Data Sources | Typical Frequency |
|---|---|---|---|
| Maintenance Completion Summary | Operations | Task (status, result, actual dates) | Weekly / Monthly |
| Asset Condition Report | Asset | Asset condition_rating, health_index, criticality | Monthly / Quarterly |
| Crew Utilization Report | Management | Crew, Task labor hours, availability | Weekly / Monthly |
| Outage / Incident Report | Operations | Task (EMERGENCY/CORRECTIVE), incident records, line/substation outages | Per event + Monthly |
| Compliance / Audit Report | Compliance | Checklist results, GPS validation pass rates, certification expiry, permit adherence | Quarterly / Annual |
| Overdue Task Report | Operations | Task due vs completed | Daily / Weekly |
| Budget / Cost Report | Management | AssetMaintenanceEvent cost, task costs | Monthly |
| Asset Register | Asset | All assets with location + lifecycle | On demand |
| Safety / Near-Miss Report | Safety | Incident, safety observations | Monthly |
| Schedule Adherence Report | Planning | Schedule next_due vs completion lag | Monthly |

### 10.3 Data Model

**Table: `report`**

| Field | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK | |
| `report_code` | varchar(30) | UNIQUE | |
| `report_type` | enum | NOT NULL | Per catalog above |
| `title` | varchar(160) | NOT NULL | |
| `period_start`, `period_end` | timestamptz | NOT NULL | Reporting window |
| `scope_region_id` | FK | NULL | Regional filter |
| `scope_substation_id` / `line_id` | FK | NULL | |
| `template_id` | FK → `report_template.id` | NOT NULL | |
| `status` | enum | NOT NULL | `REQUESTED`, `GENERATING`, `READY`, `FAILED`, `ARCHIVED` |
| `format` | enum | NOT NULL | `PDF`, `XLSX`, `CSV`, `DASHBOARD`, `JSON` |
| `output_url` | varchar(500) | NULL | Rendered artifact link |
| `generated_by` | FK → person | NULL | |
| `generated_at` | timestamptz | NULL | |
| `parameters` | jsonb | NULL | Query parameters snapshot |
| `revision` | int | NOT NULL | |

**Table: `report_template`**

| Field | Type | Description |
|---|---|---|
| `id` | UUID PK | |
| `name` | varchar(120) | |
| `report_type` | enum | |
| `definition` | jsonb | Query/aggregation + layout definition |
| `is_system` | boolean | System-provided vs custom |
| `schedule` | jsonb | Optional recurring delivery config |

### 10.4 Key Metrics Definitions

- **Maintenance completion rate:** `COMPLETED / (COMPLETED + OVERDUE + CANCELLED)` in period.
- **On-time completion rate:** tasks with `actual_end <= due_date` / completed tasks.
- **Asset health score:** average `health_index` weighted by criticality.
- **Crew utilization:** `Σ actual labor hours / Σ available hours`.
- **GPS validation coverage:** validated assets / total assets per region.
- **Checklist compliance:** steps passed / total required steps across executed checklists.
- **Backlog (aging):** open tasks bucketed by overdue days (`0–7`, `8–30`, `31–90`, `>90`).

### 10.5 Relationships

- `N → 1` ReportTemplate
- Optional regional / substation / line filters
- `N → 1` Creator (Person)
- Consumes data from Task, Asset, Crew, ChecklistResult, GpsValidation, Incident

### 10.6 Key Workflows

1. **On-demand generation:** User selects report type, period, scope → build parameters → status `REQUESTED` → async `GENERATING` → `READY` with artifact.
2. **Scheduled delivery:** Template `schedule` triggers generation and emails distribution list.
3. **Compliance evidence pack:** Audit run bundles the mandatory report set with GPS validation coverage and certification status snapshots into a single archive.

---

## 11. GPS Validation

### 11.1 Purpose

GPS Validation verifies that recorded coordinates for regions (boundary), substations, lines (route), towers, and assets match reality. It detects coordinate entry errors, survey drift, and mis-registration, and drives geofencing and map trustworthiness.

### 11.2 Data Model

**Table: `gps_validation`**

| Field | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK | |
| `target_type` | enum | NOT NULL | `REGION`, `SUBSTATION`, `LINE`, `TOWER`, `ASSET` |
| `target_id` | UUID | NOT NULL | Referenced object id |
| `region_id` | FK | NOT NULL | Owning region (for reporting) |
| `expected_lat`, `expected_lng` | double | NOT NULL | Recorded/expected position |
| `measured_lat`, `measured_lng` | double | NOT NULL | Field-measured position |
| `accuracy_m` | double | NOT NULL | GPS receiver accuracy (HDOP-derived) |
| `distance_m` | double | NOT NULL | Haversine distance expected↔measured |
| `tolerance_m` | double | NOT NULL | Allowed deviation per target type |
| `result` | enum | NOT NULL | `PASS`, `FAIL`, `OUT_OF_TOLERANCE`, `MANUAL_REVIEW` |
| `geofence_id` | FK → `geofence.id` | NULL | If geofencing applied |
| `inside_geofence` | boolean | NULL | |
| `validation_method` | enum | NOT NULL | `GPS_DEVICE`, `SURVEY`, `APP_CAPTURE`, `AERIAL_SURVEY`, `MANUAL_ENTRY` |
| `device_info` | jsonb | NULL | Device, satellites, HDOP |
| `photo_ref` | uuid | NULL | Photo evidence |
| `validated_by` | FK → person | NOT NULL | |
| `validated_at` | timestamptz | NOT NULL | |
| `linked_task_id` | FK → `task.id` | NULL | Field confirmation task |
| `notes` | text | NULL | |
| `revision` | int | NOT NULL | |

**Table: `geofence`**

| Field | Type | Description |
|---|---|---|
| `id` | UUID PK | |
| `name` | varchar(120) | |
| `geometry` | geometry | Polygon / buffer zone |
| `target_type` | enum | Applies to asset/substation/tower |
| `tolerance_m` | double | Default tolerance |
| `is_active` | boolean | |
| `region_id` | FK | |

### 11.3 Default Tolerances

| Target Type | Default Tolerance |
|---|---|
| Substation (centroid) | 150 m |
| Tower | 20 m |
| Asset (substation-mounted) | 50 m |
| Asset (line/tower-mounted) | 20 m |
| Line route sample points | 50 m perpendicular |
| Region boundary | 1,000 m (boundary coincidence) |

### 11.4 GPS Validation Workflows

1. **Field confirmation (task-driven):** Crew executes inspection task with a `GPS_CONFIRM` checklist step → captures measured coordinates + accuracy → system computes `distance_m` vs expected → result:
   - `PASS` if `distance_m <= tolerance_m` and inside geofence.
   - `FAIL` if beyond tolerance → asset flagged `gps_validated=false`, discrepancy report generated, coordinate correction requested.
2. **Geofence enforcement:** When recording asset location, if a `geofence` exists for that target type, reject/flag positions outside it.
3. **Aerial survey revalidation:** Bulk re-survey of a line/tower set → bulk validation records → updates `gps_validated` and route geometry if within tolerance.
4. **Coordinate correction:** On `FAIL`, a `CORRECTIVE` task auto-generated to re-survey; after new measurement passes, recorded coordinates updated (audit of old values retained).
5. **Map trust overlay:** `gps_validated=false` items render with warning styling on the Integrated Map until validated.

### 11.5 Relationships

- `N → 1` Region
- Optional `N → 1` Task (originating)
- Optional `N → 1` Geofence
- `N → 1` Person (validator)
- Updates `gps_validated` flags on Asset / Substation / Line / Tower

---

## 12. Checklists

### 12.1 Purpose

Checklists standardize inspection and maintenance procedures per asset type and task type, with step-by-step procedures, pass/fail criteria, measurements, and required documentation.

### 12.2 Data Model

**Table: `checklist_template`**

| Field | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK | |
| `name` | varchar(160) | NOT NULL | e.g., "500 kV Circuit Breaker Annual Inspection" |
| `code` | varchar(30) | UNIQUE | |
| `category` | enum | NOT NULL | `INSPECTION`, `PREVENTIVE_MAINTENANCE`, `CORRECTIVE`, `EMERGENCY`, `COMMISSIONING`, `DIAGNOSTIC` |
| `asset_type` | enum | NULL | Primary applicable asset type |
| `task_type` | enum | NULL | Applicable task type |
| `applicable_voltage_kv` | int | NULL | Max voltage applicability |
| `version` | int | NOT NULL | Version control |
| `status` | enum | NOT NULL | `DRAFT`, `ACTIVE`, `SUPERSEDED`, `RETIRED` |
| `is_mandatory` | boolean | default false | Cannot be skipped on matching tasks |
| `estimated_minutes` | int | NULL | |
| `requires_supervisor_verification` | boolean | default false | |
| `requires_gps_confirmation` | boolean | default false | |
| `required_tools` | varchar[] | NULL | |
| `required_certifications` | enum[] | NULL | Crew certs required |
| `safety_notes` | text | NULL | |
| `created_by` | FK → person | NOT NULL | |
| `revision` | int | NOT NULL | |

**Table: `checklist_item`**

| Field | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PK | |
| `template_id` | FK | NOT NULL | |
| `sequence` | int | NOT NULL | Step order |
| `section` | varchar(80) | NULL | Grouping label |
| `instruction` | text | NOT NULL | Step description |
| `response_type` | enum | NOT NULL | `PASS_FAIL`, `YES_NO`, `NUMERIC`, `TEXT`, `PHOTO`, `SELECT`, `MEASUREMENT`, `GPS_POINT` |
| `required` | boolean | NOT NULL | Mandatory step |
| `pass_criteria` | jsonb | NULL | For NUMERIC: min/max/unit; for SELECT: options |
| `conditional_if` | jsonb | NULL | Skip logic (e.g., only if type=SF6) |
| `max_photos` | int | default 0 | |
| `critical_step` | boolean | default false | Any FAIL forces overall FAIL |

**Table: `checklist_execution`** (instance of a checklist run within a task)

| Field | Type | Description |
|---|---|---|
| `id` | UUID PK | |
| `template_id` | FK | Version snapshot of template used |
| `template_version` | int | |
| `task_id` | FK | Owning task |
| `asset_id` | FK | Target asset |
| `tower_id` | FK | Target tower (for tower-scoped tasks) |
| `started_at`, `submitted_at` | timestamptz | |
| `executed_by` | FK → person | |
| `result` | enum | `PASS`, `FAIL`, `PARTIAL`, `INCOMPLETE` |
| `notes` | text | |

**Table: `checklist_execution_item`**

| Field | Type | Description |
|---|---|---|
| `id` | UUID PK | |
| `execution_id` | FK | |
| `template_item_id` | FK | Snapshot reference |
| `response_value` | jsonb | PASS/FAIL, numeric, text, select, photo ids, GPS point |
| `result` | enum | `PASS`, `FAIL`, `NA`, `NOT_RUN` |
| `actual_value` | varchar | For measurements |
| `comment` | text | |
| `completed_at` | timestamptz | |

### 12.3 Versioning & Supersession

- New revisions create a new `version`; old versions remain readable.
- `ACTIVE` version is used for task generation and template binding.
- Tasks snapshot `template_version` at creation, so historical results reflect the procedure in force at execution time.

### 12.4 Response Evaluation Rules

- Item `result=FAIL` on a `critical_step` → execution overall `FAIL`.
- `NUMERIC` with `pass_criteria` → auto pass/fail vs min/max.
- Missing `required` item at submit → execution locked as `INCOMPLETE`; cannot be submitted.
- `NA` allowed only if item allows it or `conditional_if` skip logic true.

### 12.5 Relationships

- `1 → N` ChecklistItem
- `1 → N` ChecklistExecution → ChecklistExecutionItem
- `N → 1` Task (tasks reference template; executions belong to task)
- Referenced by MaintenanceSchedule (`checklist_template_id`)
- Category/asset_type matching used to recommend templates

### 12.6 Key Workflows

1. **Template authoring:** Create items with sequence, response types, pass criteria → validate skip logic → set `ACTIVE` → bind to schedules.
2. **Task binding:** On task creation, system proposes matching ACTIVE templates (by asset_type + task_type + voltage); planner confirms.
3. **Field execution:** Mobile app renders steps; required steps enforced; photos/measurements/GPS captured; offline queued.
4. **Review & audit:** Execution results flow to task completion, asset condition updates, and compliance reports.

---

## 13. Integrated Map

### 13.1 Purpose

The Integrated Map is the geographic visualization layer for regions, substations, transmission lines, and assets, using GPS-validated positions, status overlays, and maintenance indicators.

### 13.2 Map Layers

| Layer | Geometry | Source | Default Overlay |
|---|---|---|---|
| Region boundaries | Polygon | `region.boundary_geom` | Fill + label |
| Substations | Point | `substation` | Status color icon |
| Transmission lines | LineString | `transmission_line.route_geom` | Color by voltage/status |
| Towers | Point | `tower` | Clustered markers |
| Assets | Point | `asset` (lat/lng or derived) | Condition color |
| Geofences | Polygon | `geofence.geometry` | Dashed outline |
| GpsValidation alerts | Point | validation FAIL targets | Warning styling |
| Maintenance activity | Point/Line | Open tasks, last 30 days | Marker clusters + heat |
| Crew locations | Point | Crew on-site positions | Live (optional) |

### 13.3 Status & Indicator Overlays

- **Substation/Line status colors:** `OPERATIONAL` green, `MAINTENANCE` amber, `OUT_OF_SERVICE` red, `UNDER_CONSTRUCTION` blue, `DECOMMISSIONED` grey.
- **Asset condition palette (1–10):** 1–3 red, 4–5 orange, 6–7 amber, 8–10 green.
- **Task density:** Heat layer for open tasks; clusters expand on zoom.
- **Validation status:** Assets with `gps_validated=false` or last validation `FAIL` show warning badge.
- **Schedule recency:** Assets with overdue preventive tasks flagged by `next_maintenance_at < today`.

### 13.4 Data Model (presentation config)

**Table: `map_layer_config`**

| Field | Type | Description |
|---|---|---|
| `id` | UUID PK | |
| `layer_key` | varchar(40) | e.g., `SUBSTATIONS`, `ASSETS` |
| `name` | varchar(80) | |
| `visible_by_default` | boolean | |
| `min_zoom`, `max_zoom` | int | Visibility range |
| `style` | jsonb | Symbology (colors, icons, size) |
| `filter` | jsonb | Optional filter expression |

**Table: `map_view`** (saved user views)

| Field | Type | Description |
|---|---|---|
| `id` | UUID PK | |
| `name` | varchar(120) | |
| `owner_id` | FK → person | |
| `is_shared` | boolean | |
| `viewport` | jsonb | Center/zoom/rotation |
| `active_layers` | uuid[] | Enabled layers |
| `filters` | jsonb | Saved filter set |

### 13.5 Key Interactions

1. **Click-through:** Clicking a feature opens a detail panel → jumps to entity record → shows open tasks, last validation, condition trend.
2. **Spatial query:** Draw box/polygon → lists contained assets/substations → export list or create bulk task.
3. **Validation-driven refresh:** When a GPS validation passes/fails, the map updates symbology in near-real time (WebSocket push).
4. **Route editing:** Line route edit mode uses validated survey points; unsaved edits are visually distinct.
5. **Dispatch view:** Dispatchers see open tasks pinned to asset locations plus crew live positions to optimize assignment.

---

## 14. Inter-Domain Relationships

### 14.1 Relationship Matrix

| From | To | Cardinality | Semantics |
|---|---|---|---|
| Region | Substation | 1:N | Ownership |
| Region | TransmissionLine | 1:N | Ownership |
| Region | Crew | 1:N | Home region |
| Region | GpsValidation | 1:N | Scope |
| Substation | TransmissionLine | 1:N (each end) | Connection endpoint |
| Substation | Asset | 1:N | Located within |
| TransmissionLine | Tower | 1:N | Structure inventory |
| TransmissionLine | Asset | 1:N | Conductor/insulator/hardware |
| Tower | Asset | 1:N | Mounted components |
| Asset | Asset | 1:N | Parent/child composition |
| Asset | AssetMaintenanceEvent | 1:N | Condition lifecycle |
| Asset | MaintenanceSchedule | 1:N | Enrolled schedules |
| Task | Asset / Substation / Line | N:1 (optional) | Target objects |
| Task | Crew | N:1 | Executing crew |
| Task | ChecklistTemplate | N:1 | Required procedure |
| Task | ChecklistExecution | 1:N | Execution records |
| Task | GpsValidation | 1:N | Field confirmations |
| Task | AssetMaintenanceEvent | 1:N | Closure side effects |
| Crew | Certification | 1:N (via person) | Capability |
| MaintenanceSchedule | ChecklistTemplate | N:1 | Procedure binding |
| MaintenanceSchedule | Task | 1:N | Generated tasks |
| ChecklistTemplate | ChecklistItem | 1:N | Steps |
| GpsValidation | Geofence | N:1 (optional) | Geofence check |
| GpsValidation | Asset/Substation/Line/Tower | N:1 | Target |
| Report | all domains | N:M (read) | Aggregation source |

### 14.2 Shared Reference Entities

- **Person:** single entity referenced by Region personnel, CrewMember, Task (creator/assigner/verifier), GpsValidation validator, Report generator.
- **Enum catalogs:** unified enum values (Section 16) so cross-domain joins are consistent.
- **Targetable interface:** Substation, TransmissionLine, Tower, Asset all expose `target_type + target_id` used by Task, GpsValidation, and map layers.

### 14.3 Denormalization Rules

Derived counters (e.g., `substation.transformer_count`, `line.tower_count`, `asset.failure_history_count`, `crew.size`) are maintained by triggers/event handlers on child writes, not by application code, to preserve consistency.

---

## 15. End-to-End Workflows

### 15.1 Preventive Maintenance Lifecycle

```
Register asset/line/substation
        │
        ▼
Enroll in MaintenanceSchedule (frequency + checklist + crew)
        │
        ▼  [daily scheduler]
Generate Task (SCHEDULED, source=SCHEDULE_GENERATED)
        │
        ▼  [dispatcher]
Crew eligibility check (certs + availability + region) → ASSIGNED
        │
        ▼  [field crew]
IN_PROGRESS → execute Checklist (incl. GPS confirmation step)
        │
        ▼
PENDING_VERIFICATION → supervisor review → COMPLETED (PASS/FAIL/DEFERRED)
        │
        ▼  [closure side effects]
Asset: update condition_rating, last_maintenance_at, health_index
AssetMaintenanceEvent written
MaintenanceSchedule.next_due_date advanced
```

### 15.2 Fault → Corrective Workflow

```
Condition/failure detected (asset DEGRADED, SCADA alarm, patrol finding)
        │
        ▼
Auto-generate CORRECTIVE task (priority from criticality)
        │
        ▼
Dispatch crew → diagnose (checklist DIAGNOSTIC) → repair
        │
        ▼
Verify → COMPLETED → asset maintenance event + condition update
        │
        ▼
If chronic (repeat failures), escalate to REPLACEMENT planning + report
```

### 15.3 Emergency Response Workflow

```
Incident reported (line trip, outage, storm damage)
        │
        ▼
Emergency task created directly ASSIGNED (bypasses DRAFT)
Outage window blocked on map; geofenced alert
        │
        ▼
Crew dispatched (nearest available, overrides availability)
        │
        ▼
Execute with EMERGENCY checklist (abbreviated, mandatory safety steps)
        │
        ▼
Restore → verification → COMPLETED → Outage/Incident Report generated
```

### 15.4 GPS Discrepancy Workflow

```
Field GPS confirmation FAIL (distance > tolerance or outside geofence)
        │
        ▼
GpsValidation record FAIL; asset gps_validated=false
        │
        ▼
Auto-generate survey/corrective task; map shows warning overlay
        │
        ▼
Re-survey → new measurement passes → coordinates updated (audited)
        │
        ▼
gps_validated=true; map refreshes; discrepancy report archived
```

### 15.6 Tower Inspection Lifecycle

```
Create/verify tower inventory (Towers page, line + km_marker + GPS)
        │
        ▼
Schedule tower work: scope TOWER (single tower) or LINE_TOWERS (all
towers on a line) → generated tasks carry line_id + tower_id
        │
        ▼
Crew executes Tower Structure Inspection checklist at the tower
(GPS_POINT item confirms the crew is at the correct structure)
        │
        ▼
Checklist GPS within 50 m → gps_validation TOWER record PASS →
tower.gps_validated = true; findings recorded (corrosion, tilt, bolts)
        │
        ▼
Reported via Asset Condition / Maintenance Completion reports
```

### 15.7 Geographic Boundaries, Tower Assets & Geofencing

**Geographic boundaries**
- Every `region` has a polygon boundary stored in `region.boundary_json` (auto-generated from center + boundary radius, 14 vertices). If no polygon exists, a radius fallback (boundary degrees × 111.32 km) is used.
- Every `substation` has a yard boundary in `substation.boundary_json` (auto-generated decagon) plus `fence_radius_m` (default 220 m). Editable via the Substations form.
- The map renders region polygons and substation yard polygons; the `GET /map/data` response includes `boundary_json` for both.

**Towers as assets**
- Every tower has a linked `asset` row (`asset_type = 'TOWER'`, `tower_id` set, name = tower_id, position copied from the tower, condition = corrosion_rating, GPS flag synced). Seed + `backfill()` create these idempotently.
- Tower CRUD (`POST/PUT/DELETE /towers`) keeps the linked asset in sync (create/update position + condition, delete the asset first).
- Towers therefore appear in the Assets register, health index, reports, and GPS coverage.

**Geofencing & violations (tower location aware)**
- Shared logic in `backend/geofence.js`: `evaluateViolation()` combines three checks for every GPS validation:
  1. **Region boundary** — measured point inside the region polygon (`in_region_boundary`).
  2. **Substation yard** — for `SUBSTATION` targets, measured point inside the yard polygon (`OUTSIDE_SUBSTATION_BOUNDARY`).
  3. **Geofence** — measured point inside an active geofence of the same `target_type` or a region-wide `REGION` geofence (`inside_geofence`, `OUTSIDE_GEOFENCE`).
- Violation reasons recorded on `gps_validation.violation`: `OUTSIDE_REGION_BOUNDARY`, `OUTSIDE_SUBSTATION_BOUNDARY`, `OUTSIDE_GEOFENCE`, `OUT_OF_TOLERANCE`.
- Checklist GPS confirmation (`recordGpsFromChecklist`) and `POST /gps-validations` both populate `violation`, `inside_geofence`, and `in_region_boundary`; PASS sets the tower + linked asset `gps_validated`.
- `GET /api/violations` lists FAIL/geofence/boundary violations; `GET /api/gps-summary` returns a `violations` count.

### 15.8 Tower Components, Route-from-Towers & External Import

**Tower component register (standard parts breakdown)**
- Every tower carries a standard component set recorded in `tower_component` (created automatically with the tower and by `backfill()` for existing towers).
- The standard catalog (`backend/towerComponents.js`) follows utility lattice-tower practice: insulator strings, conductor suspension/tension clamps, vibration dampers, spacers, jumper connection / joint boxes, lattice steel members, gusset plates, galvanized bolts-nuts-washers, cross arms, peak/earth-wire mast, earth-wire clamps, concrete foundations, anchor/stub bolts, step bolts, anti-climbing devices, bird guards, danger/identification plates, and tower earthing — 18 part types with default quantities, materials and unit of measure.
- Component records carry `quantity`, `unit`, `material`, `condition_rating` (0–10), `status` (`INSTALLED`, `SPARE`, `DEFECT_REPORTED`, `REPLACED`, `REMOVED`) and `notes`, so parts are tracked and replaced alongside the tower.
- API: `GET /tower-component-types` (catalog), `GET /towers/:id` + `GET /towers/:id/components`, `POST /towers/:id/components`, `PUT /tower-components/:id`, `DELETE /tower-components/:id`. Tower list includes `component_count`.

**Transmission-line route = composite of tower locations**
- Tower GPS positions are the route points of a transmission line. `rebuildLineRoute(lineId)` regenerates `route_json` from the line's towers ordered by `km_marker`, and recomputes `length_km` (sum of haversine distances) and `gps_validated`.
- The rebuild runs automatically on tower create/update/delete and after bulk import, so the drawn waypoints on the line form are only an interim route until towers exist.
- Line detail exposes the towers and the derived route polyline.

**Manual input from external sources (Excel / CSV) — standard practice**
- Field data is prepared offline in spreadsheets and loaded into TMMS in one operation via `POST /towers/import` (the standard workflow for new transmission-line additions).
- The endpoint accepts either `{ csv: "<text>" }` (tab- or comma-delimited, quoted-field aware) or `{ records: [ ... ] }`. Columns: `line_id` (numeric id), `line_code` or `line_name` (one is required), `tower_id`, `tower_number`, `km_marker`/`km`, `latitude`/`lat`, `longitude`/`lng`/`lon`, `tower_type`, `tower_material`, `height_m`, `corrosion_rating`, `gps_validated`.
- Imported towers automatically get: the standard component set, the linked `TOWER` asset, an updated `tower_count`, and a rebuilt line route. Rows for existing `tower_id` values are updated in place. The response reports `created`, `updated`, and per-row `errors` (unknown line, missing ID, invalid coordinates).
- The Towers page provides a "Download template" CSV and an import dialog that accepts pasted Excel cells (tab-separated) or a `.csv` file — matching the "prepare offline, upload once" practice.

**Route → towers (reverse conversion)**
- `POST /lines/:id/towers-from-route` converts every route polyline point into a registered tower (suspension/lattice-steel, height by voltage class, interpolated km marker, `PAD` foundation) with its standard component set and linked `TOWER` asset, then updates `tower_count` and rebuilds the route.
- The conversion is idempotent: route points that already have a tower within tolerance (1e-6 deg) are skipped, so re-running it never duplicates towers. When the route is already the composite of tower locations the endpoint reports `created: 0`.
- This closes the loop with `rebuildLineRoute`: towers derive the route, and any drawn waypoint route can be materialised back into towers — the two representations always agree.

### 15.9 Vegetation Clearance (Right-of-Way)

- Each transmission line records a vegetation (right-of-way) clearance `veg_clearance_m` and the `veg_clearance_last_checked_at` timestamp.
- Defaults are derived from line voltage following utility/NESC clearance practice when a line is created: ≤ 50 kV → 6.1 m; < 250 kV → 7.6 m; < 500 kV → 10.7 m; ≥ 500 kV → 11.9 m. Values are editable per line and `backfill()` fills nulls for existing lines.
- The clearance is exposed on the line form and the line detail modal (with last-checked date), and is consumed by patrol planning and vegetation management reporting.
Audit trigger (quarterly / annual)
        │
        ▼
Bundle: maintenance completion, asset condition, overdue backlog,
checklist compliance, GPS validation coverage, certification expiry,
outage/incident logs
        │
        ▼
Generate single archive (PDF) with signatures/snapshots
        │
        ▼
Distribute; archive immutable copy for regulator access
```

### 15.10 Transmission Organisational Hierarchy, Standard Checklists & Role-Based Workflow

**Organisational hierarchy (`org_unit`)**
- The full Transmission business-unit hierarchy is modelled: HQ CEO → Transmission Business Unit (HDE) → Maintenance Executive and Transmission System Operator divisions → 13 regional directorates (Addis Ababa, Oromia, Amhara, Tigray, Afar, Somali, Benishangul-Gumuz, SNNP, Sidama, Gambela, Harari, Dire Dawa + existing regions) → per-directorate departments (Substation Maintenance, Transmission Maintenance, Relay/SCADA/Telecom & Control) → resident substation units.
- Every directorate, department and substation unit has an assigned manager (linked to `person` and `app_user`) and its own field crews, all region-scoped (`region_id`).
- API: `GET /org-tree` (nested hierarchy with managers and crews), `GET /org-units`, `GET /org-units/:id` (personnel + child units); `POST`/`PUT`/`DELETE /org-units` are admin-only.
- The Organization page renders the tree (expandable, per-unit crews and managers) and supports admin CRUD.

**Roles (see §18.2)**
- `EXECUTIVE` (global: CEO and division leads), `REGION_DIRECTOR`, `SUBSTATION_MANAGER`, `TRANSMISSION_MANAGER`, `RELAY_SCADA_MANAGER`. All run the task workflow (`task:create/assign/verify/manage`); master-data writes stay `ADMIN`-only. `FIELD_CREW` keeps `task:execute` + `gps:write`. Logins: `director.<c>@tmms.example`/`Region@123`, `sm|tm|rs.<c>`/`SubMgr@123|TransMgr@123|RelayMgr@123`, `ceo`/`Executive@123`.

**Standard checklists**
- Eight industry-standard templates are auto-seeded (admin-editable): CT inspection, VT/PT inspection, Disconnector inspection, GIS indoor switchgear inspection, Battery & charger PM, Protection relay functional test, SCADA/RTU/Telecom check, and Line conductor/OPGW/insulator patrol — each 5 items ending with a `GPS_POINT` confirmation and `requires_gps_confirmation`.

**Never-missed GPS enforcement**
- Finishing-place GPS captured at checklist submission is always compared against the installed device location and persisted as a `gps_validation` row (`APP_CAPTURE`). A `FAIL` marks the execution `FAIL`; an unknown device location yields `MANUAL_REVIEW` (never a silent pass). Task verification returns 409 unless a `PASS` device-vs-finish validation exists when the template requires GPS confirmation.
- `GET /api/violations` surfaces every `FAIL`/geofence violation for review (GPS page → Violations panel).

---


### 16.1 Master Enum Catalogs

- **AssetType:** as listed in Section 6.2.
- **TaskType:** `PREVENTIVE`, `CORRECTIVE`, `EMERGENCY`, `INSPECTION`, `REPLACEMENT`, `TESTING`, `REPAIR`.
- **Priority:** `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`.
- **TaskStatus:** `DRAFT`, `SCHEDULED`, `ASSIGNED`, `IN_PROGRESS`, `ON_HOLD`, `PENDING_VERIFICATION`, `COMPLETED`, `CANCELLED`, `FAILED`.
- **OperationalStatus:** `OPERATIONAL`, `MAINTENANCE`, `OUT_OF_SERVICE`, `UNDER_CONSTRUCTION`, `DECOMMISSIONED` (per-entity subsets).
- **ConditionRating:** integer 1–10 (1 = critical, 10 = new).
- **Frequency:** `DAILY`, `WEEKLY`, `BIWEEKLY`, `MONTHLY`, `QUARTERLY`, `SEMI_ANNUAL`, `ANNUAL`, `BIENNIAL`, `CUSTOM_DAYS`.
- **GpsValidationResult:** `PASS`, `FAIL`, `OUT_OF_TOLERANCE`, `MANUAL_REVIEW`.
- **ChecklistResponseType:** `PASS_FAIL`, `YES_NO`, `NUMERIC`, `TEXT`, `PHOTO`, `SELECT`, `MEASUREMENT`, `GPS_POINT`.
- **RegionType, SubstationType, LineType, TowerType, CrewType, CertType, ReportType:** defined in respective sections.

### 16.2 Reference Data Managed in System

- Voltage level codes (`kV` list, with max ratings).
- Conductor catalogs (type code → properties).
- Manufacturer catalog (name, contact, warranty defaults).
- Person directory (shared).
- Checklist templates (versioned).
- Geofences and tolerance profiles.

---

## 17. API Surface Summary

REST-style resource endpoints (all namespaced under `/api`):

| Resource | Methods | Notes |
|---|---|---|
| `/regions` | GET/POST, `/regions/{id}` GET/PUT/DELETE | Plus `/regions/{id}/personnel` |
| `/substations` | CRUD | Plus `/substations/{id}/assets`, `/lines` |
| `/lines` | CRUD | Plus `/lines/{id}/towers`, `/lines/{id}/towers-from-route` (route → towers) |
| `/assets` | CRUD | Plus `/assets/{id}/maintenance-events`, `/assets/{id}/condition` |
| `/tasks` | CRUD + `/tasks/{id}/state` (transitions) | State-machine guarded |
| `/crews` | CRUD + `/crews/{id}/members`, `/crews/{id}/availability` | |
| `/certifications` | CRUD | Expiry alerts |
| `/schedules` | CRUD + `/schedules/{id}/preview` | Dry-run generator |
| `/checklists` | CRUD + `/checklists/{id}/items` | Versioned |
| `/task-executions` | Create/Get | Field submission (offline capable) |
| `/gps-validations` | Create/Query | Bulk survey upload |
| `/gps-summary` | GET | Coverage by type/region |
| `/violations` | GET | Never-missed FAIL/geofence violations for review |
| `/geofences` | CRUD | |
| `/org-tree`, `/org-units` | GET (admin POST/PUT/DELETE on `/org-units`) | Transmission hierarchy with managers & crews |
| `/reports` | POST request / GET status / GET artifact | Async generation |
| `/map/layers` | GET | Layer/config views |
| `/map/query` | POST | Spatial query |

Notifications: WebSocket for task assignment, GPS validation result, outage alerts, schedule generation.

---

## 18. Data Integrity, Security & Compliance

### 18.1 Data Integrity

- **Referential integrity:** All FKs enforced; location-anchor constraint on Asset (exactly one of substation/line/lat-lng).
- **Audit trail:** All entity mutations write `audit_log` (actor, action, entity, before/after JSON diff, timestamp).
- **Optimistic locking:** `revision` on all aggregate roots; conflicts returned to client.
- **Immutable history:** AssetMaintenanceEvent, ChecklistExecution, GpsValidation, Report artifacts are append-only.

### 18.2 Security

- **RBAC roles:** `ADMIN`, `EXECUTIVE`, `REGION_DIRECTOR`, `REGION_MANAGER`, `SUBSTATION_MANAGER`, `TRANSMISSION_MANAGER`, `RELAY_SCADA_MANAGER`, `PLANNER`, `DISPATCHER`, `SUPERVISOR`, `FIELD_CREW`, `AUDITOR`, `VIEWER` (see §15.10).
- **Master-data separation:** regions, substations, lines, towers, assets, checklists and users are `ADMIN`-only writes; management roles operate the task workflow; field crews execute and record GPS.
- **Field-scoping:** Crew roles access only their region/assigned tasks; auditors read-only.
- **Field data integrity:** Signed submissions; server recomputes `distance_m` for GPS from raw coordinates (client values not trusted).
- **Attachments:** Virus-scanned, permissioned object store; retention policy per document type.

### 18.3 Compliance Support

- Evidence preserved for mandatory inspection cycles (checklist snapshots with timestamps + validator).
- GPS validation coverage percentages reported for audit.
- Certification expiry monitoring feeds dispatch blocking and compliance reports.
- Retention: task records, checklist executions, and validation records kept for regulator-defined periods; report artifacts immutable after archiving.

---

## 19. State-of-the-Art Recommendation

TMMS already covers the asset register, maintenance lifecycle, GPS validation, geofencing and reporting. The following modernisation path brings it in line with current utility practice:

1. **Digital-twin map layer.** Upgrade the integrated map from 2D markers/polylines to a CIM (Common Information Model) / GIS-backed network model with topology (conductor connectivity via towers), so outages and fault spans can be traced end-to-end and visualised.
2. **LiDAR / drone inspection integration.** Ingest drone and helicopter LiDAR point clouds and photogrammetry; automate vegetation-clearance measurement against `veg_clearance_m` and hot-spot detection (conductor sag, encroachment) instead of manual patrol.
3. **Predictive maintenance (PdM).** Feed condition ratings, load/thermal histories and vibration monitoring into ML models (e.g., gradient-boosted failure prediction) that propose condition-based interventions and re-rate inspection frequencies from the current time-based schedules.
4. **Sensor/IoT telemetry.** Connect line monitors (sag, temperature, vibration, partial discharge on substation assets) via IEC 61850 / MQTT into the asset record, replacing the current manual GPS-survey entry with live streams that auto-trigger alarms and tasks.
5. **Offline-first field app.** The current field submission supports offline capture; evolve it into a full PWA with progressive sync, digital checklists offline, and photo/AR-based verification on tower components.
6. **Automated vegetation & access scheduling.** Optimise patrol and vegetation crews from line clearance data, growth models, terrain access and crew certification — closing the loop between `veg_clearance_last_checked_at`, patrol checklists and crew dispatch.
7. **Workflow automation & API.** Expose the state-machine task lifecycle, schedule generation and report artifacts through a stable public API and webhooks so outage-management and ERP systems integrate without custom code.
8. **Security hardening.** Add row-level encryption of sensitive metadata, SSO/SCIM identity federation, and signed chain-of-custody evidence (hashes) for regulator-facing audit archives.

---

*End of TMMS System Specification.*
