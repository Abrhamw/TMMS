const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const DB_PATH = process.env.TMMS_DB || path.join(__dirname, 'tmms.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

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

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_message_recipient ON message(recipient_person_id, status);
  CREATE INDEX IF NOT EXISTS idx_message_sender ON message(sender_user_id, status);
  CREATE INDEX IF NOT EXISTS idx_message_thread ON message(thread_id);

  -- Per-account mailbox state (read receipt, archive filing) for directed mail.
  CREATE TABLE IF NOT EXISTS message_state (
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    read_at TEXT,
    archived_at TEXT,
    PRIMARY KEY (user_id, message_id)
  );

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

  // Let SQLite refresh its statistics after any new indexes/columns so the
  // planner keeps picking the indexes added above.
  try { db.exec('PRAGMA optimize;'); } catch (_) { /* non-fatal */ }
}

function migrate(table, column, alterSql) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(alterSql);
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

module.exports = { db, initSchema, writeAudit };
