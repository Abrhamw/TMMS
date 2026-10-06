const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const DB_PATH = process.env.TMMS_DB || path.join(__dirname, 'tmms.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

function initSchema() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS person (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    role TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    title TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS region (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'CUSTOM',
    center_lat REAL NOT NULL,
    center_lng REAL NOT NULL,
    boundary REAL NOT NULL DEFAULT 1.5,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    region_manager_person_id INTEGER REFERENCES person(id),
    contact_phone TEXT,
    contact_email TEXT,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    notes TEXT,
    revision INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS region_personnel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    region_id INTEGER NOT NULL REFERENCES region(id),
    person_id INTEGER NOT NULL REFERENCES person(id),
    role TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS substation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    substation_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    region_id INTEGER NOT NULL REFERENCES region(id),
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    elevation_m REAL,
    voltage_levels TEXT NOT NULL DEFAULT '[]',
    substation_type TEXT NOT NULL DEFAULT 'TRANSFORMER',
    operational_status TEXT NOT NULL DEFAULT 'OPERATIONAL',
    commissioned_date TEXT,
    owner TEXT,
    bay_count INTEGER NOT NULL DEFAULT 0,
    gps_validated INTEGER NOT NULL DEFAULT 0,
    last_gps_validation_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS transmission_line (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    region_id INTEGER NOT NULL REFERENCES region(id),
    from_substation_id INTEGER NOT NULL REFERENCES substation(id),
    to_substation_id INTEGER NOT NULL REFERENCES substation(id),
    route_json TEXT NOT NULL DEFAULT '[]',
    voltage_kv INTEGER NOT NULL,
    line_type TEXT NOT NULL DEFAULT 'OVERHEAD',
    length_km REAL NOT NULL DEFAULT 0,
    conductor_type TEXT,
    circuit_count INTEGER NOT NULL DEFAULT 1,
    tower_count INTEGER NOT NULL DEFAULT 0,
    construction_date TEXT,
    commissioned_date TEXT,
    rating_mva REAL,
    operational_status TEXT NOT NULL DEFAULT 'ENERGIZED',
    gps_validated INTEGER NOT NULL DEFAULT 0,
    veg_clearance_m REAL,
    veg_clearance_last_checked_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS tower (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tower_id TEXT NOT NULL UNIQUE,
    line_id INTEGER NOT NULL REFERENCES transmission_line(id),
    tower_number TEXT NOT NULL,
    km_marker REAL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    tower_type TEXT NOT NULL DEFAULT 'SUSPENSION',
    tower_material TEXT NOT NULL DEFAULT 'LATTICE_STEEL',
    height_m REAL,
    foundation_type TEXT NOT NULL DEFAULT 'PAD',
    corrosion_rating INTEGER NOT NULL DEFAULT 8,
    gps_validated INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS asset (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL UNIQUE,
    asset_type TEXT NOT NULL,
    sub_type TEXT,
    substation_id INTEGER REFERENCES substation(id),
    line_id INTEGER REFERENCES transmission_line(id),
    tower_id INTEGER REFERENCES tower(id),
    parent_asset_id INTEGER REFERENCES asset(id),
    name TEXT NOT NULL,
    manufacturer TEXT,
    model TEXT,
    serial_number TEXT,
    installation_date TEXT,
    commissioned_date TEXT,
    latitude REAL,
    longitude REAL,
    condition_rating INTEGER NOT NULL DEFAULT 7,
    condition_assessed_at TEXT,
    lifecycle_status TEXT NOT NULL DEFAULT 'IN_SERVICE',
    operational_status TEXT NOT NULL DEFAULT 'OPERATIONAL',
    criticality TEXT NOT NULL DEFAULT 'MEDIUM',
    warranty_expiry TEXT,
    last_maintenance_at TEXT,
    next_maintenance_at TEXT,
    gps_validated INTEGER NOT NULL DEFAULT 0,
    last_gps_validation_at TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS asset_maintenance_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL REFERENCES asset(id),
    task_id INTEGER REFERENCES task(id),
    event_type TEXT NOT NULL,
    performed_at TEXT NOT NULL,
    crew_id INTEGER REFERENCES crew(id),
    work_summary TEXT,
    measured_values TEXT NOT NULL DEFAULT '{}',
    condition_after INTEGER,
    cost REAL
  );

  CREATE TABLE IF NOT EXISTS asset_reading (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL REFERENCES asset(id),
    reading_type TEXT NOT NULL,
    value_num REAL NOT NULL,
    unit TEXT,
    recorded_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'MANUAL',
    recorded_by INTEGER REFERENCES person(id),
    task_id INTEGER REFERENCES task(id),
    client_ref TEXT,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS asset_performance_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL REFERENCES asset(id),
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    occurred_at TEXT NOT NULL,
    magnitude REAL,
    duration_min REAL,
    source TEXT NOT NULL DEFAULT 'MANUAL',
    recorded_by INTEGER REFERENCES person(id),
    task_id INTEGER REFERENCES task(id),
    client_ref TEXT,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS tower_component (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tower_id INTEGER NOT NULL REFERENCES tower(id) ON DELETE CASCADE,
    component_type TEXT NOT NULL,
    name TEXT NOT NULL,
    material TEXT NOT NULL DEFAULT 'GALVANIZED_STEEL',
    quantity INTEGER NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT 'pcs',
    condition_rating INTEGER NOT NULL DEFAULT 8,
    status TEXT NOT NULL DEFAULT 'INSTALLED',
    notes TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS crew (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    crew_code TEXT NOT NULL UNIQUE,
    crew_type TEXT NOT NULL DEFAULT 'MAINTENANCE',
    region_id INTEGER NOT NULL REFERENCES region(id),
    leader_person_id INTEGER REFERENCES person(id),
    home_base TEXT,
    status TEXT NOT NULL DEFAULT 'AVAILABLE',
    revision INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS crew_member (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    crew_id INTEGER NOT NULL REFERENCES crew(id),
    person_id INTEGER NOT NULL REFERENCES person(id),
    role TEXT NOT NULL DEFAULT 'LINEMAN',
    skill_level TEXT NOT NULL DEFAULT 'JUNIOR',
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS certification (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL REFERENCES person(id),
    cert_type TEXT NOT NULL,
    issuing_body TEXT,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'VALID'
  );

  CREATE TABLE IF NOT EXISTS task (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_number TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    task_type TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'MEDIUM',
    status TEXT NOT NULL DEFAULT 'DRAFT',
    region_id INTEGER NOT NULL REFERENCES region(id),
    substation_id INTEGER REFERENCES substation(id),
    line_id INTEGER REFERENCES transmission_line(id),
    asset_id INTEGER REFERENCES asset(id),
    checklist_template_id INTEGER REFERENCES checklist_template(id),
    crew_id INTEGER REFERENCES crew(id),
    priority_reason TEXT,
    due_date TEXT NOT NULL,
    scheduled_start TEXT,
    scheduled_end TEXT,
    actual_start TEXT,
    actual_end TEXT,
    created_by INTEGER REFERENCES person(id),
    assigned_by INTEGER REFERENCES person(id),
    verified_by INTEGER REFERENCES person(id),
    completion_summary TEXT,
    result TEXT,
    source TEXT NOT NULL DEFAULT 'MANUAL',
    schedule_id INTEGER REFERENCES maintenance_schedule(id),
    permit_required INTEGER NOT NULL DEFAULT 0,
    is_energized_work INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS task_equipment_check (
    task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    equipment_name TEXT NOT NULL,
    is_available INTEGER NOT NULL DEFAULT 0 CHECK (is_available IN (0, 1)),
    checked_by INTEGER REFERENCES person(id),
    checked_at TEXT NOT NULL,
    PRIMARY KEY (task_id, equipment_name)
  );

  CREATE TABLE IF NOT EXISTS task_link (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES task(id),
    linked_task_id INTEGER NOT NULL REFERENCES task(id),
    link_type TEXT NOT NULL DEFAULT 'RELATED'
  );

  CREATE TABLE IF NOT EXISTS task_work_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES task(id),
    sequence INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'REMEDIATE',
    title TEXT NOT NULL,
    detail TEXT,
    source_type TEXT,
    source_id INTEGER,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_work_item_task ON task_work_item(task_id);

  CREATE TABLE IF NOT EXISTS task_checklist_template (
    task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    template_id INTEGER NOT NULL REFERENCES checklist_template(id),
    sequence INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (task_id, template_id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_checklist_template_task ON task_checklist_template(task_id);

  CREATE TABLE IF NOT EXISTS maintenance_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_name TEXT NOT NULL,
    schedule_code TEXT NOT NULL UNIQUE,
    scope_type TEXT NOT NULL,
    asset_type TEXT,
    asset_id INTEGER REFERENCES asset(id),
    substation_id INTEGER REFERENCES substation(id),
    tower_id INTEGER REFERENCES tower(id),
    line_id INTEGER REFERENCES transmission_line(id),
    region_id INTEGER REFERENCES region(id),
    frequency TEXT NOT NULL,
    frequency_config TEXT NOT NULL DEFAULT '{}',
    checklist_template_id INTEGER REFERENCES checklist_template(id),
    responsible_crew_id INTEGER REFERENCES crew(id),
    priority TEXT NOT NULL DEFAULT 'MEDIUM',
    task_type TEXT NOT NULL DEFAULT 'PREVENTIVE',
    lead_time_days INTEGER NOT NULL DEFAULT 7,
    next_due_date TEXT NOT NULL,
    last_generated_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    expected_duration_hours REAL,
    instructions TEXT,
    revision INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS checklist_template (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    asset_type TEXT,
    task_type TEXT,
    applicable_voltage_kv INTEGER,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    is_mandatory INTEGER NOT NULL DEFAULT 0,
    requires_supervisor_verification INTEGER NOT NULL DEFAULT 0,
    requires_gps_confirmation INTEGER NOT NULL DEFAULT 0,
    estimated_minutes INTEGER,
    safety_notes TEXT,
    materials TEXT,
    required_personnel TEXT,
    revision INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS checklist_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES checklist_template(id),
    sequence INTEGER NOT NULL,
    section TEXT,
    instruction TEXT NOT NULL,
    response_type TEXT NOT NULL DEFAULT 'PASS_FAIL',
    required INTEGER NOT NULL DEFAULT 1,
    pass_criteria TEXT,
    critical_step INTEGER NOT NULL DEFAULT 0,
    test_equipment TEXT
  );

  CREATE TABLE IF NOT EXISTS checklist_execution (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL,
    template_version INTEGER NOT NULL,
    task_id INTEGER REFERENCES task(id),
    asset_id INTEGER REFERENCES asset(id),
    started_at TEXT NOT NULL,
    submitted_at TEXT,
    executed_by INTEGER REFERENCES person(id),
    result TEXT,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS checklist_execution_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id INTEGER NOT NULL REFERENCES checklist_execution(id),
    template_item_id INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    instruction TEXT NOT NULL,
    response_type TEXT NOT NULL,
    response_value TEXT,
    result TEXT,
    comment TEXT,
    completed_at TEXT
  );

  -- In-progress checklist captures. A draft is held apart from a real execution
  -- so it never counts as submitted work: the crew can save partial readings and
  -- resume later, and the draft is discarded once the run is submitted.
  CREATE TABLE IF NOT EXISTS checklist_draft (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES task(id),
    template_id INTEGER NOT NULL,
    executed_by INTEGER REFERENCES person(id),
    crew_id INTEGER,
    notes TEXT,
    items_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(task_id, template_id, executed_by)
  );

  CREATE TABLE IF NOT EXISTS task_finding (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES task(id),
    execution_id INTEGER REFERENCES checklist_execution(id),
    crew_id INTEGER REFERENCES crew(id),
    created_by INTEGER REFERENCES person(id),
    title TEXT NOT NULL,
    detail TEXT,
    severity TEXT NOT NULL DEFAULT 'INFO',
    lat REAL,
    lng REAL,
    captured_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS attachment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER REFERENCES task(id),
    execution_id INTEGER REFERENCES checklist_execution(id),
    checklist_item_id INTEGER,
    created_by INTEGER REFERENCES person(id),
    kind TEXT NOT NULL DEFAULT 'PHOTO',
    file_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime TEXT,
    size_bytes INTEGER,
    lat REAL,
    lng REAL,
    accuracy_m REAL,
    captured_at TEXT NOT NULL,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS geofence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    target_type TEXT NOT NULL,
    center_lat REAL NOT NULL,
    center_lng REAL NOT NULL,
    radius_m REAL NOT NULL,
    tolerance_m REAL NOT NULL DEFAULT 50,
    is_active INTEGER NOT NULL DEFAULT 1,
    region_id INTEGER REFERENCES region(id)
  );

  CREATE TABLE IF NOT EXISTS gps_validation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    region_id INTEGER NOT NULL REFERENCES region(id),
    expected_lat REAL NOT NULL,
    expected_lng REAL NOT NULL,
    measured_lat REAL NOT NULL,
    measured_lng REAL NOT NULL,
    accuracy_m REAL NOT NULL DEFAULT 5,
    distance_m REAL NOT NULL,
    tolerance_m REAL NOT NULL,
    result TEXT NOT NULL,
    inside_geofence INTEGER,
    validation_method TEXT NOT NULL DEFAULT 'GPS_DEVICE',
    validated_by INTEGER REFERENCES person(id),
    validated_at TEXT NOT NULL,
    linked_task_id INTEGER REFERENCES task(id),
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS report_template (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    report_type TEXT NOT NULL,
    description TEXT,
    is_system INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS report (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_code TEXT NOT NULL UNIQUE,
    report_type TEXT NOT NULL,
    title TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    scope_region_id INTEGER REFERENCES region(id),
    template_id INTEGER REFERENCES report_template(id),
    status TEXT NOT NULL DEFAULT 'READY',
    format TEXT NOT NULL DEFAULT 'HTML',
    generated_at TEXT NOT NULL,
    parameters TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS report_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_type TEXT NOT NULL,
    months INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT NOT NULL,
    last_run_at TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    scope_region_id INTEGER REFERENCES region(id),
    params TEXT NOT NULL DEFAULT '{}',
    share_to TEXT,
    created_by INTEGER REFERENCES user(id),
    created_at TEXT NOT NULL
  );

  -- Evidence-based condition history written by the asset monitoring agent.
  -- Each row is one revaluation result per asset; the agent only appends a row
  -- when the suggested rating or recommendation actually changes, so the table
  -- is a change log rather than a per-run dump.
  CREATE TABLE IF NOT EXISTS asset_health_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL REFERENCES asset(id),
    captured_at TEXT NOT NULL,
    condition_rating REAL,
    suggested_rating REAL,
    health_index REAL,
    remaining_useful_life_years REAL,
    recommendation TEXT,
    source TEXT NOT NULL DEFAULT 'AGENT',
    reasons TEXT,
    report_id INTEGER REFERENCES report(id)
  );

  CREATE TABLE IF NOT EXISTS audit_log (    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL DEFAULT 'system',
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id INTEGER,
    detail TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    person_id INTEGER REFERENCES person(id),
    role TEXT NOT NULL,
    region_id INTEGER REFERENCES region(id),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES user(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS comment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES user(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_comment_entity ON comment(entity_type, entity_id);

  CREATE TABLE IF NOT EXISTS mailbox_read (
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL,
    PRIMARY KEY (user_id, task_id)
  );

  CREATE TABLE IF NOT EXISTS mailbox_message_read (
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    message_key TEXT NOT NULL,
    read_at TEXT NOT NULL,
    PRIMARY KEY (user_id, message_key)
  );

  -- Directed mailbox messages: real, authored correspondence between accounts
  -- (as opposed to the read-time aggregation of task comments/audit events).
  -- Recipients are stored by person so every account belonging to that person
  -- sees the message; the resolved user id is kept for fast inbox queries.
  CREATE TABLE IF NOT EXISTS message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_user_id INTEGER REFERENCES user(id),
    sender_person_id INTEGER REFERENCES person(id),
    recipient_person_id INTEGER REFERENCES person(id),
    recipient_user_id INTEGER REFERENCES user(id),
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'GENERAL',
    status TEXT NOT NULL DEFAULT 'SENT',
    priority TEXT NOT NULL DEFAULT 'NORMAL',
    entity_type TEXT,
    entity_id INTEGER,
    link TEXT,
    thread_id INTEGER REFERENCES message(id),
    parent_id INTEGER REFERENCES message(id),
    forward_of_id INTEGER REFERENCES message(id),
    action_required INTEGER NOT NULL DEFAULT 0,
    due_date TEXT,
    scheduled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_message_recipient ON message(recipient_person_id, status);
  CREATE INDEX IF NOT EXISTS idx_message_sender ON message(sender_user_id, status);
  CREATE INDEX IF NOT EXISTS idx_message_thread ON message(thread_id);

  -- The addressed parties of a message, one row per person per kind. A message
  -- can now carry many To/Cc/Bcc recipients (mail was single-recipient before);
  -- kind is TO|CC|BCC and BCC rows are only ever revealed to the sender.
  -- read_at records the first read by any account of that person, giving the
  -- sender a per-recipient read receipt.
  CREATE TABLE IF NOT EXISTS message_recipient (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    person_id INTEGER REFERENCES person(id),
    kind TEXT NOT NULL DEFAULT 'TO',
    read_at TEXT,
    delivered_at TEXT,
    acknowledged_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(message_id, person_id)
  );
  CREATE INDEX IF NOT EXISTS idx_message_recipient_person ON message_recipient(person_id, message_id);
  CREATE INDEX IF NOT EXISTS idx_message_recipient_message ON message_recipient(message_id);

  -- Per-account mail labels (an account's own filing tags) and their
  -- many-to-many assignment to messages. Labels are private to the account.
  CREATE TABLE IF NOT EXISTS mail_label (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(owner_user_id, name)
  );
  CREATE TABLE IF NOT EXISTS message_label (
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES mail_label(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, message_id, label_id)
  );
  CREATE INDEX IF NOT EXISTS idx_message_label_message ON message_label(message_id);
  CREATE INDEX IF NOT EXISTS idx_message_label_label ON message_label(label_id);

  -- Per-account saved searches (named, reusable mailbox filters).
  CREATE TABLE IF NOT EXISTS mail_saved_search (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    query TEXT,
    folder TEXT,
    label TEXT,
    action_only INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(owner_user_id, name)
  );

  -- Per-account mailbox state (read receipt, archive filing, junk/trash filing,
  -- starring) for directed mail.
  CREATE TABLE IF NOT EXISTS message_state (
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    read_at TEXT,
    archived_at TEXT,
    deleted_at TEXT,
    junk_at TEXT,
    junk_reason TEXT,
    starred_at TEXT,
    purged_at TEXT,
    PRIMARY KEY (user_id, message_id)
  );

  -- A "Not junk" memory: senders/domains an account has explicitly rescued, so
  -- automatic classification never files future mail from them again.
  CREATE TABLE IF NOT EXISTS mail_junk_rule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    match_type TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(owner_user_id, match_type, value)
  );
  CREATE INDEX IF NOT EXISTS idx_mail_junk_rule_owner ON mail_junk_rule(owner_user_id);

  -- Documents attached to a directed mail. An attachment is either a reference
  -- to an existing entity (report, execution, task, asset document, ...) carried
  -- as a link, or an uploaded file stored on disk. This keeps a single flexible
  -- mechanism for "attach any doc" without copying the entity itself.
  CREATE TABLE IF NOT EXISTS message_attachment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'DOC',
    entity_type TEXT,
    entity_id INTEGER,
    label TEXT,
    link TEXT,
    file_name TEXT,
    stored_name TEXT,
    mime TEXT,
    size_bytes INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_message_attachment ON message_attachment(message_id);

  CREATE TABLE IF NOT EXISTS org_unit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    unit_type TEXT NOT NULL,
    parent_id INTEGER REFERENCES org_unit(id),
    region_id INTEGER REFERENCES region(id),
    manager_person_id INTEGER REFERENCES person(id),
    sort_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS asset_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    family TEXT NOT NULL,
    family_label TEXT NOT NULL,
    label TEXT,
    asset_type TEXT NOT NULL,
    sub_type TEXT NOT NULL DEFAULT '',
    unit_of_measure TEXT NOT NULL DEFAULT 'EA',
    location_kind TEXT NOT NULL DEFAULT 'ANY',
    default_location_type TEXT,
    attribute_schema TEXT,
    default_unit_price REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_catalog_key ON asset_catalog(family, asset_type, sub_type);

  CREATE TABLE IF NOT EXISTS tower_component_standard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tower_type TEXT NOT NULL,
    component_type TEXT NOT NULL,
    name TEXT NOT NULL,
    material TEXT NOT NULL,
    default_quantity INTEGER NOT NULL,
    unit TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tower_component_standard_key
    ON tower_component_standard(tower_type, component_type);

  CREATE TABLE IF NOT EXISTS inspection_trace_point (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    line_id INTEGER,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    accuracy_m REAL,
    km REAL,
    recorded_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    crew_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_inspection_trace_point_task ON inspection_trace_point(task_id);
  CREATE INDEX IF NOT EXISTS idx_inspection_trace_point_line ON inspection_trace_point(line_id);

  -- Hot-path foreign keys and filters. Without these, list/detail/map endpoints
  -- and the boot reconcile fall back to full table scans that get progressively
  -- slower as lines, towers and the tower-mirror assets grow.
  CREATE INDEX IF NOT EXISTS idx_substation_region ON substation(region_id);
  CREATE INDEX IF NOT EXISTS idx_line_region ON transmission_line(region_id);
  CREATE INDEX IF NOT EXISTS idx_line_from_sub ON transmission_line(from_substation_id);
  CREATE INDEX IF NOT EXISTS idx_line_to_sub ON transmission_line(to_substation_id);
  CREATE INDEX IF NOT EXISTS idx_tower_line ON tower(line_id);
  CREATE INDEX IF NOT EXISTS idx_tower_line_km ON tower(line_id, km_marker);
  CREATE INDEX IF NOT EXISTS idx_asset_substation ON asset(substation_id);
  CREATE INDEX IF NOT EXISTS idx_asset_line ON asset(line_id);
  CREATE INDEX IF NOT EXISTS idx_asset_tower ON asset(tower_id);
  -- Exactly one asset row may mirror a given tower. The tower table is the
  -- infrastructure record; the mirror carries asset lifecycle data. This partial
  -- index guarantees the 1:1 relationship the sync code maintains.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_tower_mirror ON asset(tower_id)
    WHERE asset_type = 'TOWER' AND tower_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_asset_parent ON asset(parent_asset_id);
  CREATE INDEX IF NOT EXISTS idx_asset_type ON asset(asset_type);
  CREATE INDEX IF NOT EXISTS idx_asset_lifecycle ON asset(lifecycle_status);
  CREATE INDEX IF NOT EXISTS idx_asset_maint_asset ON asset_maintenance_event(asset_id);
  CREATE INDEX IF NOT EXISTS idx_asset_maint_task ON asset_maintenance_event(task_id);
  CREATE INDEX IF NOT EXISTS idx_tower_component_tower ON tower_component(tower_id);
  CREATE INDEX IF NOT EXISTS idx_tower_component_type ON tower_component(component_type);
  CREATE INDEX IF NOT EXISTS idx_crew_region ON crew(region_id);
  CREATE INDEX IF NOT EXISTS idx_crew_member_crew ON crew_member(crew_id);
  CREATE INDEX IF NOT EXISTS idx_crew_member_person ON crew_member(person_id);
  CREATE INDEX IF NOT EXISTS idx_region_personnel_region ON region_personnel(region_id);
  CREATE INDEX IF NOT EXISTS idx_region_personnel_person ON region_personnel(person_id);
  CREATE INDEX IF NOT EXISTS idx_certification_person ON certification(person_id);
  CREATE INDEX IF NOT EXISTS idx_user_region ON user(region_id);
  CREATE INDEX IF NOT EXISTS idx_user_person ON user(person_id);
  CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);
  CREATE INDEX IF NOT EXISTS idx_org_unit_region ON org_unit(region_id);
  CREATE INDEX IF NOT EXISTS idx_org_unit_parent ON org_unit(parent_id);
  CREATE INDEX IF NOT EXISTS idx_task_region ON task(region_id);
  CREATE INDEX IF NOT EXISTS idx_task_line ON task(line_id);
  CREATE INDEX IF NOT EXISTS idx_task_substation ON task(substation_id);
  CREATE INDEX IF NOT EXISTS idx_task_asset ON task(asset_id);
  CREATE INDEX IF NOT EXISTS idx_task_crew ON task(crew_id);
  CREATE INDEX IF NOT EXISTS idx_task_schedule ON task(schedule_id);
  CREATE INDEX IF NOT EXISTS idx_task_status ON task(status);
  CREATE INDEX IF NOT EXISTS idx_task_link_task ON task_link(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_link_linked ON task_link(linked_task_id);
  CREATE INDEX IF NOT EXISTS idx_schedule_region ON maintenance_schedule(region_id);
  CREATE INDEX IF NOT EXISTS idx_schedule_line ON maintenance_schedule(line_id);
  CREATE INDEX IF NOT EXISTS idx_schedule_substation ON maintenance_schedule(substation_id);
  CREATE INDEX IF NOT EXISTS idx_schedule_asset ON maintenance_schedule(asset_id);
  CREATE INDEX IF NOT EXISTS idx_schedule_crew ON maintenance_schedule(responsible_crew_id);
  CREATE INDEX IF NOT EXISTS idx_schedule_due ON maintenance_schedule(is_active, next_due_date);
  CREATE INDEX IF NOT EXISTS idx_checklist_item_template ON checklist_item(template_id);
  CREATE INDEX IF NOT EXISTS idx_checklist_exec_task ON checklist_execution(task_id);
  CREATE INDEX IF NOT EXISTS idx_checklist_exec_asset ON checklist_execution(asset_id);
  CREATE INDEX IF NOT EXISTS idx_checklist_exec_item_exec ON checklist_execution_item(execution_id);
  CREATE INDEX IF NOT EXISTS idx_task_finding_task ON task_finding(task_id);
  CREATE INDEX IF NOT EXISTS idx_attachment_task ON attachment(task_id);
  CREATE INDEX IF NOT EXISTS idx_attachment_exec ON attachment(execution_id);
  CREATE INDEX IF NOT EXISTS idx_gps_validation_target ON gps_validation(target_type, target_id);
  CREATE INDEX IF NOT EXISTS idx_gps_validation_region ON gps_validation(region_id);
  CREATE INDEX IF NOT EXISTS idx_gps_validation_task ON gps_validation(linked_task_id);
  CREATE INDEX IF NOT EXISTS idx_gps_validation_result ON gps_validation(result);
  CREATE INDEX IF NOT EXISTS idx_geofence_region ON geofence(region_id);
  CREATE INDEX IF NOT EXISTS idx_report_region ON report(scope_region_id);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

  CREATE INDEX IF NOT EXISTS idx_task_finding_crew ON task_finding(crew_id);
  CREATE INDEX IF NOT EXISTS idx_task_finding_exec ON task_finding(execution_id);
  CREATE INDEX IF NOT EXISTS idx_attachment_creator ON attachment(created_by);
  CREATE INDEX IF NOT EXISTS idx_attachment_item ON attachment(checklist_item_id);
  CREATE INDEX IF NOT EXISTS idx_checklist_exec_item_item ON checklist_execution_item(execution_id, template_item_id);
  CREATE INDEX IF NOT EXISTS idx_crew_member_active ON crew_member(crew_id, active);
  CREATE INDEX IF NOT EXISTS idx_task_status_due ON task(status, due_date);
  CREATE INDEX IF NOT EXISTS idx_task_assignee ON task(assigned_by);
  CREATE INDEX IF NOT EXISTS idx_report_schedule_due ON report_schedule(active, next_run_at);
  CREATE INDEX IF NOT EXISTS idx_certification_expiry ON certification(expires_at);

  CREATE TABLE IF NOT EXISTS job (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    dedupe_key TEXT,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'QUEUED',
    priority INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    available_at TEXT NOT NULL,
    locked_until TEXT,
    locked_by TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_job_dedupe ON job(dedupe_key) WHERE dedupe_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_job_claim ON job(status, available_at, priority);

  CREATE TABLE IF NOT EXISTS applied_migration (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS idempotency_key (
    key TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES user(id),
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER,
    response TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_key(created_at);

  -- Effective-dated labor rates. Rates are append-only: a new rate is a new
  -- row, and every time entry keeps the rate basis it was costed with.
  CREATE TABLE IF NOT EXISTS labor_rate (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER REFERENCES person(id),
    grade TEXT,
    currency TEXT NOT NULL DEFAULT 'USD',
    hourly_rate REAL NOT NULL,
    effective_from TEXT NOT NULL,
    notes TEXT,
    created_by INTEGER REFERENCES person(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_labor_rate_person ON labor_rate(person_id, effective_from);

  -- Transaction-level labor capture. Approved rows are immutable; a correction
  -- is recorded as a new adjustment entry, never a silent edit.
  CREATE TABLE IF NOT EXISTS time_entry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES task(id),
    person_id INTEGER NOT NULL REFERENCES person(id),
    crew_id INTEGER REFERENCES crew(id),
    work_date TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'NORMAL',
    started_at TEXT,
    ended_at TEXT,
    break_minutes REAL NOT NULL DEFAULT 0,
    travel_minutes REAL NOT NULL DEFAULT 0,
    standby_minutes REAL NOT NULL DEFAULT 0,
    overtime_minutes REAL NOT NULL DEFAULT 0,
    hours REAL NOT NULL DEFAULT 0,
    hourly_rate REAL,
    currency TEXT NOT NULL DEFAULT 'USD',
    labor_rate_id INTEGER REFERENCES labor_rate(id),
    labor_cost REAL,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    notes TEXT,
    approved_by INTEGER REFERENCES person(id),
    approved_at TEXT,
    rejected_reason TEXT,
    client_ref TEXT,
    created_by INTEGER REFERENCES person(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_time_entry_task ON time_entry(task_id);
  CREATE INDEX IF NOT EXISTS idx_time_entry_person ON time_entry(person_id, work_date);
  CREATE INDEX IF NOT EXISTS idx_time_entry_status ON time_entry(status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entry_client_ref ON time_entry(client_ref) WHERE client_ref IS NOT NULL;

  -- Maintenance resource register. Vehicles, lifting gear, generators and test
  -- sets are controlled items in their own right: they carry a custodian, a
  -- calibration clock and a status, distinct from the electrical assets they
  -- service.
  CREATE TABLE IF NOT EXISTS maintenance_resource (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'TOOL',
    status TEXT NOT NULL DEFAULT 'AVAILABLE',
    serial_number TEXT,
    location TEXT,
    home_region_id INTEGER REFERENCES region(id),
    custodian_person_id INTEGER REFERENCES person(id),
    capacity TEXT,
    calibration_expiry TEXT,
    certification_required TEXT,
    operating_hours REAL NOT NULL DEFAULT 0,
    odometer REAL NOT NULL DEFAULT 0,
    cost_rate REAL,
    currency TEXT NOT NULL DEFAULT 'USD',
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_resource_status ON maintenance_resource(status, category);
  CREATE INDEX IF NOT EXISTS idx_resource_region ON maintenance_resource(home_region_id);

  -- A reservation locks a resource to a task window and is what stops two crews
  -- from being dispatched with the same test set.
  CREATE TABLE IF NOT EXISTS resource_reservation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id INTEGER NOT NULL REFERENCES maintenance_resource(id),
    task_id INTEGER REFERENCES task(id),
    reserved_from TEXT NOT NULL,
    reserved_to TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'RESERVED',
    reserved_by INTEGER REFERENCES person(id),
    notes TEXT,
    client_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reservation_resource ON resource_reservation(resource_id, reserved_from, reserved_to);
  CREATE INDEX IF NOT EXISTS idx_reservation_task ON resource_reservation(task_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_client_ref ON resource_reservation(client_ref) WHERE client_ref IS NOT NULL;

  -- Actual resource usage captured in the field. Approved rows are immutable;
  -- a correction is a new adjustment entry, never a silent edit.
  CREATE TABLE IF NOT EXISTS resource_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id INTEGER NOT NULL REFERENCES maintenance_resource(id),
    reservation_id INTEGER REFERENCES resource_reservation(id),
    task_id INTEGER REFERENCES task(id),
    crew_id INTEGER REFERENCES crew(id),
    started_at TEXT,
    ended_at TEXT,
    operating_hours REAL NOT NULL DEFAULT 0,
    odometer_start REAL,
    odometer_end REAL,
    cost_rate REAL,
    currency TEXT NOT NULL DEFAULT 'USD',
    cost REAL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    approved_by INTEGER REFERENCES person(id),
    approved_at TEXT,
    rejected_reason TEXT,
    client_ref TEXT,
    created_by INTEGER REFERENCES person(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_resource_usage_resource ON resource_usage(resource_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_resource_usage_task ON resource_usage(task_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_usage_client_ref ON resource_usage(client_ref) WHERE client_ref IS NOT NULL;

  -- Controlled material/spare register. Operational stock control must not
  -- depend on free-text material descriptions on checklists.
  CREATE TABLE IF NOT EXISTS material_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'SPARE',
    unit TEXT NOT NULL DEFAULT 'EA',
    unit_cost REAL,
    currency TEXT NOT NULL DEFAULT 'USD',
    min_stock REAL NOT NULL DEFAULT 0,
    max_stock REAL,
    reorder_point REAL NOT NULL DEFAULT 0,
    supplier TEXT,
    lead_time_days INTEGER,
    criticality TEXT NOT NULL DEFAULT 'MEDIUM',
    shelf_life_days INTEGER,
    substitute_item_id INTEGER REFERENCES material_item(id),
    default_location TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_material_item_cat ON material_item(category, criticality);
  CREATE INDEX IF NOT EXISTS idx_material_item_active ON material_item(active);

  -- Reservation reduces available stock before dispatch without moving it, so
  -- two tasks cannot plan against the same last critical spare.
  CREATE TABLE IF NOT EXISTS material_reservation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES material_item(id),
    task_id INTEGER REFERENCES task(id),
    quantity REAL NOT NULL,
    location TEXT,
    status TEXT NOT NULL DEFAULT 'RESERVED',
    reserved_by INTEGER REFERENCES person(id),
    notes TEXT,
    client_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_material_reservation_item ON material_reservation(item_id, status);
  CREATE INDEX IF NOT EXISTS idx_material_reservation_task ON material_reservation(task_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_material_reservation_client_ref ON material_reservation(client_ref) WHERE client_ref IS NOT NULL;

  -- Immutable stock/consumption ledger. Corrections are ADJUSTMENT rows, never
  -- edits to a posted transaction.
  CREATE TABLE IF NOT EXISTS material_transaction (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES material_item(id),
    task_id INTEGER REFERENCES task(id),
    reservation_id INTEGER REFERENCES material_reservation(id),
    type TEXT NOT NULL,
    quantity REAL NOT NULL,
    location TEXT,
    unit_cost REAL,
    cost REAL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'POSTED',
    created_by INTEGER REFERENCES person(id),
    client_ref TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_material_txn_item ON material_transaction(item_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_material_txn_task ON material_transaction(task_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_material_txn_client_ref ON material_transaction(client_ref) WHERE client_ref IS NOT NULL;

  -- Planned cost built from standard rates and quantities before approval.
  CREATE TABLE IF NOT EXISTS cost_estimate (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES task(id),
    category TEXT NOT NULL DEFAULT 'OTHER',
    description TEXT,
    quantity REAL,
    unit_cost REAL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    created_by INTEGER REFERENCES person(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_cost_estimate_task ON cost_estimate(task_id);

  -- Committed cost: reserved/procured resources or approved external commitments.
  CREATE TABLE IF NOT EXISTS cost_commitment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES task(id),
    category TEXT NOT NULL DEFAULT 'OTHER',
    description TEXT,
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    reference TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    committed_by INTEGER REFERENCES person(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_cost_commitment_task ON cost_commitment(task_id, status);

  -- Actual direct cost transactions (contractor/service/travel/other) that have
  -- no labor/resource/material ledger of their own.
  CREATE TABLE IF NOT EXISTS cost_transaction (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES task(id),
    category TEXT NOT NULL DEFAULT 'OTHER',
    description TEXT,
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    incurred_on TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    approved_by INTEGER REFERENCES person(id),
    approved_at TEXT,
    rejected_reason TEXT,
    client_ref TEXT,
    created_by INTEGER REFERENCES person(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_cost_transaction_task ON cost_transaction(task_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_transaction_client_ref ON cost_transaction(client_ref) WHERE client_ref IS NOT NULL;

  -- Controlled defect/finding lifecycle. A critical finding becomes a defect
  -- that stays open until a verified corrective task and a root-cause-based
  -- disposition close it, so inspection -> corrective work -> cost is traceable.
  CREATE TABLE IF NOT EXISTS defect (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    defect_number TEXT NOT NULL UNIQUE,
    task_id INTEGER REFERENCES task(id),
    finding_id INTEGER REFERENCES task_finding(id),
    asset_id INTEGER REFERENCES asset(id),
    region_id INTEGER REFERENCES region(id),
    title TEXT NOT NULL,
    description TEXT,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',
    likelihood TEXT,
    risk_score INTEGER,
    status TEXT NOT NULL DEFAULT 'OPEN',
    temporary_mitigation TEXT,
    owner_person_id INTEGER REFERENCES person(id),
    target_date TEXT,
    root_cause_category TEXT,
    root_cause_detail TEXT,
    corrective_task_id INTEGER REFERENCES task(id),
    disposition TEXT,
    verified_at TEXT,
    closed_at TEXT,
    closed_by INTEGER REFERENCES person(id),
    created_by INTEGER REFERENCES person(id),
    client_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_defect_status ON defect(status, severity);
  CREATE INDEX IF NOT EXISTS idx_defect_task ON defect(task_id);
  CREATE INDEX IF NOT EXISTS idx_defect_asset ON defect(asset_id);
  CREATE INDEX IF NOT EXISTS idx_defect_owner ON defect(owner_person_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_defect_finding ON defect(finding_id) WHERE finding_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_defect_client_ref ON defect(client_ref) WHERE client_ref IS NOT NULL;
  `);

  migrate('task', 'tower_id', 'ALTER TABLE task ADD COLUMN tower_id INTEGER REFERENCES tower(id)');
  migrate('checklist_execution', 'tower_id', 'ALTER TABLE checklist_execution ADD COLUMN tower_id INTEGER REFERENCES tower(id)');
  migrate('maintenance_schedule', 'tower_id', 'ALTER TABLE maintenance_schedule ADD COLUMN tower_id INTEGER REFERENCES tower(id)');
  migrate('region', 'boundary_json', 'ALTER TABLE region ADD COLUMN boundary_json TEXT');
  migrate('substation', 'boundary_json', 'ALTER TABLE substation ADD COLUMN boundary_json TEXT');
  migrate('substation', 'fence_radius_m', 'ALTER TABLE substation ADD COLUMN fence_radius_m REAL');
  migrate('gps_validation', 'violation', 'ALTER TABLE gps_validation ADD COLUMN violation TEXT');
  migrate('gps_validation', 'in_region_boundary', 'ALTER TABLE gps_validation ADD COLUMN in_region_boundary INTEGER');
  migrate('gps_validation', 'geofence_id', 'ALTER TABLE gps_validation ADD COLUMN geofence_id INTEGER REFERENCES geofence(id)');
  migrate('gps_validation', 'review_status', 'ALTER TABLE gps_validation ADD COLUMN review_status TEXT');
  migrate('gps_validation', 'reviewed_by', 'ALTER TABLE gps_validation ADD COLUMN reviewed_by INTEGER REFERENCES person(id)');
  migrate('gps_validation', 'reviewed_at', 'ALTER TABLE gps_validation ADD COLUMN reviewed_at TEXT');
  migrate('gps_validation', 'review_note', 'ALTER TABLE gps_validation ADD COLUMN review_note TEXT');
  migrate('geofence', 'target_id', 'ALTER TABLE geofence ADD COLUMN target_id INTEGER');
  migrate('geofence', 'boundary_json', 'ALTER TABLE geofence ADD COLUMN boundary_json TEXT');
  migrate('transmission_line', 'veg_clearance_m', 'ALTER TABLE transmission_line ADD COLUMN veg_clearance_m REAL');
  migrate('transmission_line', 'veg_clearance_last_checked_at', 'ALTER TABLE transmission_line ADD COLUMN veg_clearance_last_checked_at TEXT');
  migrate('tower', 'foundation_type', "ALTER TABLE tower ADD COLUMN foundation_type TEXT NOT NULL DEFAULT 'PAD'");
  migrate('person', 'org_unit_id', 'ALTER TABLE person ADD COLUMN org_unit_id INTEGER REFERENCES org_unit(id)');
  migrate('checklist_execution', 'gps_lat', 'ALTER TABLE checklist_execution ADD COLUMN gps_lat REAL');
  migrate('checklist_execution', 'gps_lng', 'ALTER TABLE checklist_execution ADD COLUMN gps_lng REAL');
  migrate('checklist_execution', 'gps_accuracy_m', 'ALTER TABLE checklist_execution ADD COLUMN gps_accuracy_m REAL');
  migrate('checklist_template', 'materials', 'ALTER TABLE checklist_template ADD COLUMN materials TEXT');
  migrate('checklist_template', 'required_personnel', 'ALTER TABLE checklist_template ADD COLUMN required_personnel TEXT');
  migrate('checklist_item', 'test_equipment', 'ALTER TABLE checklist_item ADD COLUMN test_equipment TEXT');
  migrate('asset', 'location_type', "ALTER TABLE asset ADD COLUMN location_type TEXT NOT NULL DEFAULT 'OUTDOOR'");
  migrate('asset', 'bay', 'ALTER TABLE asset ADD COLUMN bay TEXT');
  migrate('crew_member', 'sort_order', 'ALTER TABLE crew_member ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  migrate('maintenance_schedule', 'task_type', "ALTER TABLE maintenance_schedule ADD COLUMN task_type TEXT NOT NULL DEFAULT 'PREVENTIVE'");
  migrate('checklist_execution', 'crew_id', 'ALTER TABLE checklist_execution ADD COLUMN crew_id INTEGER REFERENCES crew(id)');
  migrate('asset', 'health_index', 'ALTER TABLE asset ADD COLUMN health_index REAL');
  migrate('asset', 'remaining_useful_life_years', 'ALTER TABLE asset ADD COLUMN remaining_useful_life_years REAL');
  migrate('asset', 'evaluation_notes', 'ALTER TABLE asset ADD COLUMN evaluation_notes TEXT');
  migrate('asset', 'default_crew_id', 'ALTER TABLE asset ADD COLUMN default_crew_id INTEGER REFERENCES crew(id)');
  migrate('crew', 'status_override', 'ALTER TABLE crew ADD COLUMN status_override TEXT');
  migrate('crew', 'org_unit_id', 'ALTER TABLE crew ADD COLUMN org_unit_id INTEGER REFERENCES org_unit(id)');
  migrate('asset', 'km_from', 'ALTER TABLE asset ADD COLUMN km_from REAL');
  migrate('asset', 'km_to', 'ALTER TABLE asset ADD COLUMN km_to REAL');
  migrate('transmission_line', 'joint_box_interval_km', "ALTER TABLE transmission_line ADD COLUMN joint_box_interval_km REAL NOT NULL DEFAULT 5");
  migrate('maintenance_schedule', 'occurrences_generated', 'ALTER TABLE maintenance_schedule ADD COLUMN occurrences_generated INTEGER NOT NULL DEFAULT 0');
  // Cancellation record: the required comment, who cancelled and when, and the
  // status to restore if an administrator later retrieves the task.
  migrate('task', 'cancel_reason', 'ALTER TABLE task ADD COLUMN cancel_reason TEXT');
  migrate('task', 'cancelled_by', 'ALTER TABLE task ADD COLUMN cancelled_by INTEGER REFERENCES person(id)');
  migrate('task', 'cancelled_at', 'ALTER TABLE task ADD COLUMN cancelled_at TEXT');
  migrate('task', 'status_before_cancel', 'ALTER TABLE task ADD COLUMN status_before_cancel TEXT');
  migrate('message', 'parent_id', 'ALTER TABLE message ADD COLUMN parent_id INTEGER REFERENCES message(id)');
  migrate('message', 'forward_of_id', 'ALTER TABLE message ADD COLUMN forward_of_id INTEGER REFERENCES message(id)');
  migrate('message', 'action_required', 'ALTER TABLE message ADD COLUMN action_required INTEGER NOT NULL DEFAULT 0');
  migrate('message', 'due_date', 'ALTER TABLE message ADD COLUMN due_date TEXT');
  migrate('message', 'scheduled_at', 'ALTER TABLE message ADD COLUMN scheduled_at TEXT');
  // Comments can target name-keyed entities (equipment) that have no numeric id;
  // those rows carry the name in entity_ref with entity_id pinned to 0.
  migrate('comment', 'entity_ref', 'ALTER TABLE comment ADD COLUMN entity_ref TEXT');
  // Findings are cross-linked to the infrastructure/equipment/item they concern
  // so a task's findings are traceable beyond the task boundary.
  migrate('task_finding', 'asset_id', 'ALTER TABLE task_finding ADD COLUMN asset_id INTEGER REFERENCES asset(id)');
  migrate('task_finding', 'tower_id', 'ALTER TABLE task_finding ADD COLUMN tower_id INTEGER REFERENCES tower(id)');
  migrate('task_finding', 'equipment_name', 'ALTER TABLE task_finding ADD COLUMN equipment_name TEXT');
  migrate('task_finding', 'checklist_item_id', 'ALTER TABLE task_finding ADD COLUMN checklist_item_id INTEGER');
  // Offline write idempotency: the mobile app tags each queued write with a
  // client_ref, so a retry after an ambiguous network drop cannot duplicate it.
  // Web callers never send it and behave exactly as before.
  migrate('checklist_execution', 'client_ref', 'ALTER TABLE checklist_execution ADD COLUMN client_ref TEXT');
  migrate('task_finding', 'client_ref', 'ALTER TABLE task_finding ADD COLUMN client_ref TEXT');
  migrate('attachment', 'client_ref', 'ALTER TABLE attachment ADD COLUMN client_ref TEXT');
  migrate('gps_validation', 'client_ref', 'ALTER TABLE gps_validation ADD COLUMN client_ref TEXT');
  migrate('comment', 'client_ref', 'ALTER TABLE comment ADD COLUMN client_ref TEXT');
  migrate('message', 'client_ref', 'ALTER TABLE message ADD COLUMN client_ref TEXT');
  migrate('inspection_trace_point', 'client_ref', 'ALTER TABLE inspection_trace_point ADD COLUMN client_ref TEXT');
  migrate('message_recipient', 'delivered_at', 'ALTER TABLE message_recipient ADD COLUMN delivered_at TEXT');
  migrate('message_recipient', 'acknowledged_at', 'ALTER TABLE message_recipient ADD COLUMN acknowledged_at TEXT');
  // Junk/trash/star filing for directed mail lives on the per-account state row.
  migrate('message_state', 'deleted_at', 'ALTER TABLE message_state ADD COLUMN deleted_at TEXT');
  migrate('message_state', 'junk_at', 'ALTER TABLE message_state ADD COLUMN junk_at TEXT');
  migrate('message_state', 'junk_reason', 'ALTER TABLE message_state ADD COLUMN junk_reason TEXT');
  migrate('message_state', 'starred_at', 'ALTER TABLE message_state ADD COLUMN starred_at TEXT');
  // A permanently removed message leaves a purged marker for senders (whose
  // message row must survive for recipients) so it stops showing in Trash/Sent.
  migrate('message_state', 'purged_at', 'ALTER TABLE message_state ADD COLUMN purged_at TEXT');
  // A line inspection may be split across crews: a section task carries the
  // inclusive tower range it is responsible for.
  migrate('task', 'tower_from_id', 'ALTER TABLE task ADD COLUMN tower_from_id INTEGER REFERENCES tower(id)');
  migrate('task', 'tower_to_id', 'ALTER TABLE task ADD COLUMN tower_to_id INTEGER REFERENCES tower(id)');
  // Permit/isolation approval and the recorded readiness override are the
  // evidence that a hard-blocked task was authorised to start anyway.
  migrate('task', 'permit_reference', 'ALTER TABLE task ADD COLUMN permit_reference TEXT');
  migrate('task', 'permit_approved_at', 'ALTER TABLE task ADD COLUMN permit_approved_at TEXT');
  migrate('task', 'permit_approved_by', 'ALTER TABLE task ADD COLUMN permit_approved_by INTEGER REFERENCES person(id)');
  migrate('task', 'readiness_override_reason', 'ALTER TABLE task ADD COLUMN readiness_override_reason TEXT');
  migrate('task', 'readiness_override_by', 'ALTER TABLE task ADD COLUMN readiness_override_by INTEGER REFERENCES person(id)');
  migrate('task', 'readiness_override_at', 'ALTER TABLE task ADD COLUMN readiness_override_at TEXT');
  // Financial closure is tracked separately from technical completion: a task
  // may be technically verified while its cost is still being reconciled.
  migrate('task', 'closure_state', "ALTER TABLE task ADD COLUMN closure_state TEXT NOT NULL DEFAULT 'OPEN'");
  migrate('task', 'cost_reconciled_at', 'ALTER TABLE task ADD COLUMN cost_reconciled_at TEXT');
  migrate('task', 'cost_reconciled_by', 'ALTER TABLE task ADD COLUMN cost_reconciled_by INTEGER REFERENCES person(id)');
  migrate('task', 'variance_reason', 'ALTER TABLE task ADD COLUMN variance_reason TEXT');
  migrate('task', 'management_acceptance_at', 'ALTER TABLE task ADD COLUMN management_acceptance_at TEXT');
  migrate('task', 'management_acceptance_by', 'ALTER TABLE task ADD COLUMN management_acceptance_by INTEGER REFERENCES person(id)');
  migrate('task', 'closed_at', 'ALTER TABLE task ADD COLUMN closed_at TEXT');
  migrate('task', 'closed_by', 'ALTER TABLE task ADD COLUMN closed_by INTEGER REFERENCES person(id)');
  // Performance-aware condition snapshots: the asset monitor records how much
  // of a suggested rating came from the age baseline versus live performance
  // (loading, faults, thermal), so the change-log can explain a degradation.
  migrate('asset_health_snapshot', 'base_rating', 'ALTER TABLE asset_health_snapshot ADD COLUMN base_rating REAL');
  migrate('asset_health_snapshot', 'performance_delta', 'ALTER TABLE asset_health_snapshot ADD COLUMN performance_delta REAL');
  migrate('asset_health_snapshot', 'degradation_rate', 'ALTER TABLE asset_health_snapshot ADD COLUMN degradation_rate REAL');
  migrate('asset_health_snapshot', 'factors_json', 'ALTER TABLE asset_health_snapshot ADD COLUMN factors_json TEXT');
  migrate('asset_health_snapshot', 'model_version', 'ALTER TABLE asset_health_snapshot ADD COLUMN model_version TEXT');
  migrate('asset_health_snapshot', 'created_by', 'ALTER TABLE asset_health_snapshot ADD COLUMN created_by INTEGER REFERENCES person(id)');
  // Everything already sent predates delivery tracking: treat a recipient as
  // delivered only when that person actually has an active account to receive
  // it, mirroring the live delivery rule (accountless people stay undelivered).
  try {
    db.prepare(
      `UPDATE message_recipient SET delivered_at = COALESCE(
         (SELECT sent_at FROM message m WHERE m.id = message_recipient.message_id),
         (SELECT updated_at FROM message m WHERE m.id = message_recipient.message_id))
       WHERE delivered_at IS NULL AND person_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM user u WHERE u.person_id = message_recipient.person_id AND u.active = 1)
         AND (SELECT status FROM message m WHERE m.id = message_recipient.message_id) = 'SENT'`
    ).run();
  } catch (_) { /* non-fatal */ }

  // Indexes on columns that only exist after the migrate() calls above, so they
  // cannot live in the CREATE TABLE block on a fresh database.
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_asset_default_crew ON asset(default_crew_id);
  CREATE INDEX IF NOT EXISTS idx_person_org_unit ON person(org_unit_id);
  CREATE INDEX IF NOT EXISTS idx_task_tower ON task(tower_id);
  CREATE INDEX IF NOT EXISTS idx_schedule_tower ON maintenance_schedule(tower_id);
  CREATE INDEX IF NOT EXISTS idx_checklist_exec_tower ON checklist_execution(tower_id);
  CREATE INDEX IF NOT EXISTS idx_gps_validation_review ON gps_validation(review_status);
  CREATE INDEX IF NOT EXISTS idx_geofence_target ON geofence(target_id);
  CREATE INDEX IF NOT EXISTS idx_message_parent ON message(parent_id);
  CREATE INDEX IF NOT EXISTS idx_message_forward_of ON message(forward_of_id);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_checklist_execution_client_ref ON checklist_execution(client_ref) WHERE client_ref IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_task_finding_client_ref ON task_finding(client_ref) WHERE client_ref IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_attachment_client_ref ON attachment(client_ref) WHERE client_ref IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_gps_validation_client_ref ON gps_validation(client_ref) WHERE client_ref IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_comment_client_ref ON comment(client_ref) WHERE client_ref IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_message_client_ref ON message(client_ref) WHERE client_ref IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_inspection_trace_point_client_ref ON inspection_trace_point(client_ref) WHERE client_ref IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_asset_reading_asset ON asset_reading(asset_id, recorded_at);
  CREATE INDEX IF NOT EXISTS idx_asset_event_asset ON asset_performance_event(asset_id, occurred_at);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_reading_client_ref ON asset_reading(client_ref) WHERE client_ref IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_performance_event_client_ref ON asset_performance_event(client_ref) WHERE client_ref IS NOT NULL;
  `);

  // Backfill the review queue for validations recorded before review tracking
  // existed. Only touches rows that still lack a status, so it is idempotent.
  try {
    db.prepare(
      `UPDATE gps_validation
          SET review_status = CASE
            WHEN violation IS NOT NULL OR result = 'FAIL' OR inside_geofence = 0 THEN 'OPEN'
            ELSE 'NOT_REQUIRED'
          END
        WHERE review_status IS NULL`
    ).run();
  } catch (_) { /* non-fatal */ }

  // A task that carries a crew is assigned work, never merely "scheduled":
  // the lifecycle only reaches ASSIGNED through a crew handoff. Schedule
  // generation used to leave a responsible crew on a SCHEDULED row, a state
  // that fell through every role's task list (too late for "to schedule",
  // already crewed for "to assign"). Normalise those rows so the crew, their
  // command chain and the report views all see the work. Idempotent.
  try {
    db.prepare(
      `UPDATE task
          SET status = 'ASSIGNED', updated_at = ?
        WHERE status = 'SCHEDULED' AND crew_id IS NOT NULL`
    ).run(new Date().toISOString());
  } catch (_) { /* non-fatal */ }

  // Tasks historically carried a single checklist template on
  // task.checklist_template_id. Seed the join table from that column so the
  // multi-template model has a complete starting point. INSERT OR IGNORE makes
  // this safe to run on every boot.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO task_checklist_template (task_id, template_id, sequence)
       SELECT id, checklist_template_id, 0 FROM task WHERE checklist_template_id IS NOT NULL`
    ).run();
  } catch (_) { /* non-fatal */ }

  // Seed the multi-recipient join table from the legacy single-recipient column
  // so older messages are addressable through the new model too. INSERT OR
  // IGNORE keeps this a no-op once every message has been migrated.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO message_recipient (message_id, person_id, kind, created_at)
       SELECT id, recipient_person_id, 'TO', created_at FROM message WHERE recipient_person_id IS NOT NULL`
    ).run();
  } catch (_) { /* non-fatal */ }

  // Indexes that reference migrated columns must be created after the ALTERs
  // above so a fresh database builds cleanly.
  db.exec('CREATE INDEX IF NOT EXISTS idx_checklist_exec_crew ON checklist_execution(crew_id);');

  // Let SQLite refresh its statistics after any new indexes/columns so the
  // planner keeps picking the indexes added above.
  try { db.exec('PRAGMA optimize;'); } catch (_) { /* non-fatal */ }
}

function migrate(table, column, alterSql) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(alterSql);
}

function hasMigration(name) {
  try {
    return !!db.prepare('SELECT 1 FROM applied_migration WHERE name = ?').get(name);
  } catch (_) {
    return false;
  }
}

function recordMigration(name) {
  db.prepare('INSERT OR IGNORE INTO applied_migration (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
}

function once(name, fn) {
  if (hasMigration(name)) return false;
  fn();
  recordMigration(name);
  return true;
}

function appliedMigrations() {
  try {
    return db.prepare('SELECT name, applied_at FROM applied_migration ORDER BY applied_at').all();
  } catch (_) {
    return [];
  }
}

function writeAudit(action, entity, entityId, detail) {
  try {
    db.prepare(
      'INSERT INTO audit_log (actor, action, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)'
    ).run('system', action, entity, entityId, detail ? JSON.stringify(detail) : null, new Date().toISOString());
  } catch (_) {
    /* non-fatal */
  }
}

module.exports = { db, initSchema, writeAudit, migrate, hasMigration, recordMigration, once, appliedMigrations };
