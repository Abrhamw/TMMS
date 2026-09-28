// Checklist catalog triangulated from the "Substation Complete Asset Inspection
// and Maintenance System" workbook (Enhanced). The workbook's sheets are
// cross-referenced as follows:
//
//   Inspection Checklists  -> one source row per task (description, tools,
//                             condition to check, skill, team, duration, LOTO)
//   Asset & Bay Register   -> asset category names, criticality and LOTO flag
//   Schedule & Manpower    -> maintenance stream / frequency / crew mapping
//   Skills & Safety Matrix -> role, team size and LOTO authority
//   CMMS Import Notes      -> frequency codes, LOTO flag semantics, pass/fail
//                             criteria stored with each step
//
// Rows are grouped by (asset category x maintenance stream x frequency) so the
// generated templates line up with how those streams are scheduled. Every
// template gets a closing GPS confirmation step because TMMS records where each
// inspection was actually performed.
//
// Each workbook row is expanded into small, single-standing questions. Every
// question carries:
//
//   q        one simple question (never more than one item to answer)
//   section  the discipline doing the check: Visual / Mechanical / Electrical /
//            Testing / Protection / Automation / Telecom / Battery / Civil
//   equip    the test equipment / tool used for that instruction
//   type     the reply the server grades:
//              YES_NO     single yes/no question, "Yes" is acceptable
//              NUMERIC    measured value graded against min..max (with unit)
//              SELECT     observed state graded against the acceptable options
//              GPS_POINT  captured coordinates compared with the geofence
//
// The template keeps safety and materials apart: safety_notes holds only the
// LOTO/safety instruction, materials holds the required materials/tools, and
// required_personnel holds the team + skill. Equipment for each instruction
// lives on the checklist_item.test_equipment column.
//
// This module is data only; `ensureWorkbookChecklists()` in seed.js performs
// the idempotent import. WORKBOOK_REVISION is bumped whenever the questions
// change so boot re-syncs an already-imported database.

const WORKBOOK_REVISION = 8;

const CATEGORIES = {
  TR: { name: 'Power / Auto-Transformer', asset_type: 'TRANSFORMER', voltage: null },
  CB: { name: 'Circuit Breaker', asset_type: 'CIRCUIT_BREAKER', voltage: null },
  CT: { name: 'Current Transformer (CT)', asset_type: 'CT', voltage: null },
  VT: { name: 'Voltage Transformer (VT/PT)', asset_type: 'VT', voltage: null },
  CVT: { name: 'Capacitive Voltage Transformer (CVT)', asset_type: 'VT', voltage: null },
  DS: { name: 'Disconnectors & Earth Switches', asset_type: 'DISCONNECTOR', voltage: null },
  SA: { name: 'Surge Arresters', asset_type: 'ARRESTER', voltage: null },
  BR: { name: 'Busbars / Reactors / Capacitors', asset_type: 'BUSBAR', voltage: null },
  BC: { name: 'Buscoupler Bay', asset_type: 'CIRCUIT_BREAKER', voltage: null },
  SAS: { name: 'SAS / SCADA', asset_type: 'SCADA_RTU', voltage: null },
  REL: { name: 'Protection Relays', asset_type: 'PROTECTION_RELAY', voltage: null },
  DC: { name: 'DC Auxiliary (125 V / 48 V)', asset_type: 'BATTERY_BANK', voltage: null },
  TEL: { name: 'Telecom & Dispatch', asset_type: 'TELECOM', voltage: null },
  CIV: { name: 'Civil / Yard', asset_type: null, voltage: null },
  LINE: { name: 'Line Bay', asset_type: null, voltage: 400 },
  TWR: { name: 'Transmission Tower', asset_type: 'TOWER', voltage: null },
  FND: { name: 'Tower Foundation', asset_type: 'FOUNDATION', voltage: null },
  LINS: { name: 'Line Insulators', asset_type: 'INSULATOR_STRING', voltage: null },
  LCON: { name: 'Line Conductors', asset_type: 'CONDUCTOR_SPAN', voltage: null },
  OPGW: { name: 'OPGW System', asset_type: 'OPGW_SPAN', voltage: null },
  FOJB: { name: 'FO Joint Box', asset_type: 'JOINT_BOX', voltage: null },
  VEG: { name: 'Right-of-Way Vegetation', asset_type: null, voltage: null },
  ROW: { name: 'Right-of-Way Access', asset_type: null, voltage: null },
  HW: { name: 'Line Hardware & Fittings', asset_type: 'TOWER', voltage: null },
  GRD: { name: 'Tower Grounding', asset_type: 'GROUNDING', voltage: null },
};

const STREAMS = {
  INSP: { label: 'Inspection', category: 'INSPECTION', task_type: 'INSPECTION' },
  PREV: { label: 'Preventive Maintenance', category: 'PREVENTIVE_MAINTENANCE', task_type: 'PREVENTIVE' },
  CBM: { label: 'Predictive / CBM', category: 'DIAGNOSTIC', task_type: 'TESTING' },
};

const FREQUENCIES = { M: 'Monthly', Q: 'Quarterly', SA: 'Semi-Annual', A: 'Annual', BA: 'Bi-Annual', '3Y': '3-Year', '5Y': '5-Year', AN: 'As Needed' };

// The CT and VT inspection checks are merged into the existing standard
// templates so tasks/schedules that already reference those codes keep working
// while still picking up the enriched workbook content.
const CODE_OVERRIDES = {
  'CT|INSP|Q': 'CL-CT-INSP',
  'VT|INSP|Q': 'CL-VT-INSP',
};

// Transmission-line asset families are consolidated: every inspection,
// preventive and diagnostic row for a family is merged into a single task list
// instead of one template per stream x frequency, so a field crew carries one
// checklist per asset. FOJB folds into OPGW, ROW folds into VEG and tower
// grounding folds into the tower family because they inspect/maintain the same
// physical asset.
const LINE_MERGE = {
  TWR: 'TWR', FND: 'FND', LINS: 'LINS', LCON: 'LCON',
  OPGW: 'OPGW', FOJB: 'OPGW', VEG: 'VEG', ROW: 'VEG', HW: 'HW', GRD: 'TWR',
};

// Families that stay split by discipline: inspection rows form one checklist
// and everything else (preventive + predictive/CBM + grounding) forms the
// maintenance checklist, because those are different task categories.
const LINE_STREAM_SPLIT = new Set(['TWR']);
const MAINT_STREAMS = new Set(['PREV', 'CBM']);

// One reused code per consolidated family. The existing standard CL-COND-INSP
// code is kept for conductors so the 60+ tasks / schedules / executions that
// already reference it stay linked; the other families reuse one of the codes
// created by the previous import and retire the rest.
const LINE_GROUPS = {
  'TWR|INSP': { name: 'Transmission Tower Inspection', code: 'CL-WB-TWR-INSP-A', asset_type: 'TOWER', stream: 'INSP' },
  'TWR|MAINT': { name: 'Transmission Tower Maintenance', code: 'CL-WB-TWR-PREV-AN', asset_type: 'TOWER', stream: 'PREV' },
  FND: { name: 'Tower Foundation Inspection & Repair', code: 'CL-WB-FND-INSP-A', asset_type: 'FOUNDATION' },
  LINS: { name: 'Line Insulator Inspection & Maintenance', code: 'CL-WB-LINS-CBM-A', asset_type: 'INSULATOR_STRING' },
  LCON: { name: 'Transmission Line Conductor Inspection & Maintenance', code: 'CL-COND-INSP', asset_type: 'CONDUCTOR_SPAN' },
  OPGW: { name: 'OPGW / Fibre Optic System', code: 'CL-WB-OPGW-PREV-A', asset_type: 'OPGW_SPAN' },
  VEG: { name: 'Right-of-Way (Vegetation & Access)', code: 'CL-WB-VEG-INSP-Q', asset_type: null },
  HW: { name: 'Line Hardware & Fittings', code: 'CL-WB-HW-INSP-A', asset_type: 'TOWER' },
};


// TASK_ID, category, stream, frequency, description, tools, condition, skill, team, days, LOTO
const RAW_ROWS = [
  ['TR-INSP-01', 'TR', 'INSP', 'M', 'Check oil levels in main conservator, OLTC conservator, bushing oil cups', 'Flashlight, inspection mirror, lint-free cloth', 'Oil level within normal operating range bounded by temperature reference curves', 'Technician Level I', '2 Technicians', 0.5, 'No'],
  ['TR-INSP-02', 'TR', 'INSP', 'M', 'Inspect silica gel breather condition and colour', 'Visual check', 'Silica gel active (dark blue or vibrant orange); pink/white indicates moisture saturation > 80%', 'Technician Level I', '2 Technicians', 0.25, 'No'],
  ['TR-INSP-03', 'TR', 'INSP', 'M', 'Inspect oil leaks on tank, gaskets, valves, radiators, bushings', 'Lint-free wipes, flashlight', 'Zero active oil weeping, dripping, or pooling on gaskets or foundation pads', 'Technician Level I', '2 Technicians', 0.25, 'No'],
  ['TR-INSP-04', 'TR', 'INSP', 'M', 'Check cooling fans, pumps, radiators, control cubicle alarms', 'Flashlight, multimeter', 'Fans/pumps operate; no abnormal noise/vibration; alarms correct', 'Electrical Technician', '2 Technicians', 0.5, 'No'],
  ['TR-INSP-05', 'TR', 'INSP', 'M', 'Record OLTC counter, motor drive condition, oil leaks', 'Logsheet, flashlight', 'Counter advances; no mechanical damage; no oil leaks', 'Technician Level I', '2 Technicians', 0.25, 'No'],
  ['TR-PREV-01', 'TR', 'PREV', 'A', 'DGA oil sampling and laboratory chromatography', 'Glass syringe, amber bottles, purge oil', 'Total combustible gases within IEEE C57.104 limits (Acetylene = 0 ppm, Hydrogen < 100 ppm)', 'Testing Specialist', '1 Engineer + 2 Techs', 3, 'Yes'],
  ['TR-PREV-02', 'TR', 'PREV', 'A', 'Dielectric BDV and moisture content test', 'BDV test set, Karl Fischer kit', 'BDV > 50 kV; moisture content < 15 ppm', 'Testing Specialist', '1 Engineer + 2 Techs', 2, 'Yes'],
  ['TR-PREV-03', 'TR', 'PREV', 'A', 'Insulation Resistance and Polarization Index', 'Megger S1-568, discharge wand', 'Polarization Index > 1.2; IR matches factory baseline', 'Testing Specialist', '1 Engineer + 2 Techs', 2, 'Yes'],
  ['TR-PREV-04', 'TR', 'PREV', 'A', 'OLTC inspection, contact wear, motor drive, limit switches', 'Hand tools, contact gauge', 'Contact wear within limit; motor operates smoothly', 'Testing Specialist', '1 Engineer + 2 Techs', 2, 'Yes'],
  ['TR-PREV-05', 'TR', 'PREV', 'A', 'Cooling system functional test and control alarm check', 'Multimeter, thermometers', 'All stages start per setpoint; alarms correct', 'Electrical Technician', '1 Engineer + 2 Techs', 1, 'Yes'],
  ['TR-CBM-01', 'TR', 'CBM', 'BA', 'Bushing Capacitance and Tan Delta test', 'OMICRON DIRANA / CPC 100', 'Tan Delta < 0.5% at 20°C; Capacitance within ±2% of nameplate', 'Testing Specialist', '1 Engineer + 1 Tech', 1.5, 'Yes'],
  ['TR-CBM-02', 'TR', 'CBM', '3Y', 'Winding resistance, turns ratio, magnetic balance', 'Transformer ohmmeter, TTR', 'Within ±2% of baseline', 'Testing Specialist', '1 Engineer + 1 Tech', 2, 'Yes'],
  ['CB-INSP-01', 'CB', 'INSP', 'M', 'Verify SF6 gas pressure/density against temperature curve', 'Density gauge, thermometer', 'Pressure pointer firmly in the Green zone corresponding to temperature compensation curve', 'Technician Level I', '2 Technicians', 0.25, 'No'],
  ['CB-INSP-02', 'CB', 'INSP', 'M', 'Inspect hydraulic/spring mechanism, pressures, motor, heaters', 'Multimeter, flashlight', 'Hydraulic pressure normal; motor recharge time < 3 mins; heaters functional', 'Electrical Technician', '2 Technicians', 0.5, 'No'],
  ['CB-INSP-03', 'CB', 'INSP', 'M', 'Check trip/close coils, anti-pumping, local/remote indication', 'Multimeter, logsheet', 'No alarm; indication correct', 'Electrical Technician', '2 Technicians', 0.25, 'No'],
  ['CB-PREV-01', 'CB', 'PREV', 'A', 'Timing and motion analysis test', 'OMICRON CIBANO 500', 'Opening/closing time and pole synchronization within ±2ms of manufacturer specs', 'Testing Specialist', '1 Engineer + 2 Techs', 1.5, 'Yes'],
  ['CB-PREV-02', 'CB', 'PREV', 'A', 'Contact resistance measurement', 'Micro-ohmmeter DLRO', 'Contact resistance below factory maximum limit (typically < 50 µΩ)', 'Testing Specialist', '1 Engineer + 2 Techs', 1, 'Yes'],
  ['CB-PREV-03', 'CB', 'PREV', 'A', 'Trip/close coil current and auxiliary contact check', 'Coil current tester', 'Within manufacturer curve', 'Testing Specialist', '1 Engineer + 2 Techs', 1, 'Yes'],
  ['CB-CBM-01', 'CB', 'CBM', 'A', 'SF6 gas quality: purity, dew point, SO2', 'DILO / WIKA SF6 analyzer', 'SF6 Purity > 99%; Dew point < -30°C; SO2 < 10 ppm', 'Testing Specialist', '1 Engineer + 1 Tech', 1, 'Yes'],
  ['CT-INSP-01', 'CT', 'INSP', 'Q', 'Oil level, insulator, terminal, secondary circuit and polarity tag inspection', 'Binoculars, flashlight, wipes, hand tools, multimeter, Megger', 'Oil level within limits; zero cracks or contamination; terminals tight; wiring and polarity tags correct; insulation resistance acceptable', 'Technician Level I', '1 Technician', 0.5, 'No'],
  ['CT-PREV-01', 'CT', 'PREV', '3Y', 'CT magnetization curve and secondary winding resistance', 'OMICRON CT Analyzer, Kelvin clips', 'Knee-point voltage matches rating curve within ±10%; secondary resistance within ±5%', 'Testing Specialist', '1 Engineer + 1 Tech', 1, 'Yes'],
  ['VT-INSP-01', 'VT', 'INSP', 'Q', 'Insulation, terminal, fuse, secondary voltage and identification tag inspection', 'Binoculars, flashlight, wipes, hand tools, multimeter', 'Insulation clean; terminals tight; fuses and links healthy; secondary voltage within range; identification tags legible', 'Technician Level I', '1 Technician', 0.5, 'No'],
  ['VT-PREV-01', 'VT', 'PREV', '3Y', 'VT ratio, polarity and burden test', 'VT test set', 'Ratio and polarity correct; burden within limit', 'Testing Specialist', '1 Engineer + 1 Tech', 1, 'Yes'],
  ['CVT-INSP-01', 'CVT', 'INSP', 'Q', 'CVT oil level and insulation inspection', 'Binoculars, flashlight, wipes', 'Oil level visible and within limits; zero cracks or contamination', 'Technician Level I', '1 Technician', 0.5, 'No'],
  ['CVT-CBM-01', 'CVT', 'CBM', '3Y', 'CVT capacitance and Tan Delta', 'OMICRON CPC 100', 'Tan Delta < 0.7%; Capacitance variation within ±1% of factory baseline', 'Testing Specialist', '1 Engineer + 1 Tech', 1, 'Yes'],
  ['DS-INSP-01', 'DS', 'INSP', 'SA', 'Visual check of contact alignment, blade insertion, silver plating', 'Binoculars, mirror', 'Full blade engagement inside fixed fingers; clean silver-plated contact surfaces', 'Technician Level II', '2 Technicians', 0.5, 'Yes'],
  ['DS-INSP-02', 'DS', 'INSP', 'SA', 'Check interlocks, earth switch operation, mechanical linkage', 'Hand tools, logsheet', 'Interlocks correct; no jamming', 'Technician Level II', '2 Technicians', 0.5, 'Yes'],
  ['DS-PREV-01', 'DS', 'PREV', 'A', 'Contact resistance across closed blades', 'DLRO 100, clamp leads', 'Contact resistance below factory maximum limit (typically < 50 µΩ)', 'Testing Specialist', '1 Engineer + 1 Tech', 1, 'Yes'],
  ['SA-INSP-01', 'SA', 'INSP', 'SA', 'Inspect surge counter, discharge monitor, base mounting', 'Logsheet, wrench set', 'Counter secure; logs recorded; discharge path clear; zero structural corrosion', 'Technician Level I', '1 Technician', 0.25, 'No'],
  ['SA-CBM-01', 'SA', 'CBM', 'A', 'Resistive leakage current and third harmonic analysis', 'Leakage current monitor', 'Resistive leakage current within baseline manufacturer parameters', 'Testing Specialist', '1 Engineer + 1 Tech', 0.5, 'No'],
  ['BR-INSP-01', 'BR', 'INSP', 'M', 'Visual patrol of busbar supports, clamps, reactor tanks, capacitor units', 'Binoculars, flashlight', 'Zero loose hardware, broken insulators, or oil weeping', 'Technician Level I', '1 Technician', 0.25, 'No'],
  ['BR-PREV-01', 'BR', 'PREV', 'A', 'Capacitor bank capacitance measurement', 'Capacitance meter', 'Capacitance within ±2% of rating', 'Testing Specialist', '1 Engineer + 2 Techs', 2, 'Yes'],
  ['BR-PREV-02', 'BR', 'PREV', 'A', 'Reactor winding resistance and insulation test', 'Micro-ohmmeter, Megger', 'Winding resistance within ±5% of baseline', 'Testing Specialist', '1 Engineer + 2 Techs', 2, 'Yes'],
  ['BC-INSP-01', 'BC', 'INSP', 'M', 'Check CB SF6, disconnectors, earth switches, interlocks, alarms', 'Flashlight, logsheet', 'No alarms; interlocks correct', 'Technician Level I', '2 Technicians', 0.5, 'No'],
  ['BC-PREV-01', 'BC', 'PREV', 'A', 'CB timing, contact resistance, DS/ES contact resistance, relay trip test', 'CIBANO 500, DLRO, relay test set', 'Times ±2 ms; contact resistance < 50 µΩ', 'Testing Specialist', '1 Engineer + 2 Techs', 1.5, 'Yes'],
  ['SAS-INSP-01', 'SAS', 'INSP', 'M', 'Check HMI/SCADA alarm logs, event buffers, GPS clock sync', 'HMI diagnostics', 'GPS master clock locked; zero unacknowledged critical alarms; time drift < 1ms', 'Automation Engineer', '1 Automation Engineer', 0.5, 'No'],
  ['SAS-INSP-02', 'SAS', 'INSP', 'Q', 'Check gateway communication, RTU, switch, fibre links', 'Laptop, optical power meter', 'No communication alarms; optical power within range', 'Automation Engineer', '1 Automation Engineer', 0.5, 'No'],
  ['SAS-CBM-01', 'SAS', 'CBM', 'A', 'IEC 61850 GOOSE/SV traffic audit and cybersecurity review', 'Wireshark laptop, fibre test cables', 'Zero packet drops; VLAN separation maintained; no unauthorised MAC addresses', 'Automation Specialist', '1 Automation + 1 Tech', 1, 'No'],
  ['REL-PREV-01', 'REL', 'PREV', 'A', 'Numerical relay secondary injection and trip circuit verification', 'OMICRON CMC 356, laptop', 'Pickup thresholds and operating time characteristics within ±5% of relay setting sheet', 'Protection Engineer', '1 Protection + 1 Tech', 1.5, 'Yes'],
  ['REL-PREV-02', 'REL', 'PREV', 'A', 'Trip circuit supervision, DC supply, CB trip/close coil integrity', 'Multimeter, test set', 'No DC earth fault; trip circuit healthy', 'Protection Engineer', '1 Protection + 1 Tech', 1, 'Yes'],
  ['REL-PREV-03', 'REL', 'PREV', '3Y', 'Scheme logic, interlock, auto-reclose, breaker failure test', 'Relay test set, laptop', 'Logic matches approved scheme', 'Protection Engineer', '1 Protection + 1 Automation', 1, 'Yes'],
  ['DC-INSP-01', 'DC', 'INSP', 'M', 'Measure float voltage, electrolyte level, specific gravity', 'Multimeter, hydrometer, PPE', 'Float voltage 2.23V/cell; specific gravity 1.215 ± 0.005 at 25°C', 'Electrical Technician', '1 Electrical Tech', 0.5, 'No'],
  ['DC-PREV-01', 'DC', 'PREV', 'A', 'Battery capacity discharge load test', 'DC load bank, data logger, thermal camera', 'Battery sustains rated autonomy without individual cell voltage dropping below 1.80V', 'Electrical Technician', '2 Electrical Techs', 1.5, 'Yes'],
  ['TEL-INSP-01', 'TEL', 'INSP', 'Q', 'Check optical power, radio status, SCADA link, alarms', 'Optical power meter, logsheet', 'Optical power within receiver sensitivity threshold', 'Telecom Specialist', '1 Telecom Specialist', 0.5, 'No'],
  ['TEL-PREV-01', 'TEL', 'PREV', 'A', 'BER test, fibre/microwave check, PLC, dispatch link audit', 'BER test set, optical power meter, radio kit', 'Bit error rate < 10^-9; optical power within receiver sensitivity; SCADA link stable', 'Telecom Specialist', '1 Telecom + 1 Tech', 1, 'No'],
  ['CIV-INSP-01', 'CIV', 'INSP', 'M', 'Inspect fence, gates, cable trenches, drainage', 'Visual walk-around', 'Fence intact; gates latch securely; trenches and drainage clear of debris and oil sludge', 'Civil Technician', '1 Civil Tech', 0.5, 'No'],
  ['CIV-PREV-01', 'CIV', 'PREV', 'A', 'Main earthing grid resistance and step/touch potential test', 'Megger DET2/2, test spikes', 'Substation main earth grid resistance < 1.0 Ohm', 'Civil / Testing Engineer', '1 Engineer + 1 Tech', 1, 'No'],
  ['LINE-INSP-01', 'LINE', 'INSP', 'M', 'Line bay overall: CB, DS, ES, CT/VT, SA, busbar, control alarms', 'Flashlight, binoculars, logsheet', 'No alarms; no visible damage', 'Technician Level I', '2 Technicians', 0.5, 'No'],
  ['LINE-PREV-01', 'LINE', 'PREV', 'A', 'Line bay integrated preventive: CB timing, CT/VT, DS/ES, SA, relay trip', 'CIBANO 500, CT analyzer, DLRO, relay test set', 'All tests within limits; protection trip correct', 'Testing / Protection', '1 Engineer + 2 Techs', 2, 'Yes'],
  ['TWR-INSP-01', 'TWR', 'INSP', 'M', 'Visual inspection of lattice members for missing, bent or corroded members', 'Binoculars, camera, checklist', 'No missing members; corrosion < 10% section loss; no bent member > 5°', 'Line Inspector', '2 Linemen', 0.1, 'No'],
  ['INS-INSP-01', 'LINS', 'INSP', 'M', 'Visual inspection of insulator strings for broken discs, cracks, contamination', 'Binoculars, camera', 'No broken discs; contamination level < moderate; no cracks', 'Line Inspector', '2 Linemen', 0.1, 'No'],
  ['COND-INSP-01', 'LCON', 'INSP', 'M', 'Visual inspection of conductors for broken strands, corrosion, vibration damage', 'Binoculars, camera', 'Broken strands < 5% of total; no corrosion', 'Line Inspector', '2 Linemen', 0.1, 'No'],
  ['OPGW-INSP-01', 'OPGW', 'INSP', 'M', 'Visual inspection of OPGW cable, clamps, sag and damage', 'Binoculars, camera', 'No damage; sag within ±2%', 'Telecom Technician', '1 Telecom + 1 Lineman', 0.1, 'No'],
  ['ROW-INSP-01', 'ROW', 'INSP', 'M', 'Inspect access roads, gates and right-of-way condition', 'Visual, checklist', 'Roads passable; gates functional', 'Line Inspector', '1 Lineman', 0.1, 'No'],
  ['TWR-INSP-02', 'TWR', 'INSP', 'A', 'Check tower bolts, nuts, cotter pins and tightness', 'Torque wrench, spanner set', 'No missing bolts/nuts; torque within ±10% of specification', 'Lineman', '2 Linemen', 0.2, 'No'],
  ['TWR-INSP-05', 'TWR', 'INSP', '3Y', 'Check galvanization, rust and painting condition', 'Rust meter, visual', 'No rust > 5% area; galvanization intact', 'Line Inspector', '2 Linemen', 0.1, 'No'],
  ['TWR-PREV-01', 'TWR', 'PREV', 'AN', 'Replace missing or bent tower members', 'Replacement members, tools', 'Tower structural integrity restored', 'Lineman', '2 Linemen + 1 Engineer', 0.5, 'Yes'],
  ['TWR-PREV-02', 'TWR', 'PREV', '3Y', 'Torque all tower bolts', 'Torque wrench', 'Torque per specification', 'Lineman', '2 Linemen', 0.2, 'No'],
  ['TWR-CBM-01', 'TWR', 'CBM', 'A', 'Monitor tower vibration', 'Vibration recorder', 'Within acceptable limits', 'Transmission Engineer', '1 Engineer + 1 Tech', 0.2, 'No'],
  ['TWR-INSP-04', 'FND', 'INSP', 'A', 'Inspect foundation for cracks, settlement, exposure, erosion', 'Crack gauge, level, measuring tape', 'No crack > 0.3 mm; settlement < 5 mm; exposure < 300 mm', 'Civil Engineer', '1 Engineer + 1 Tech', 0.2, 'No'],
  ['FND-PREV-01', 'FND', 'PREV', 'AN', 'Repair foundation cracks and exposure', 'Grout, protective coating', 'Repaired to original strength', 'Civil Engineer', '1 Engineer + 2 Techs', 0.5, 'No'],
  ['INS-INSP-02', 'LINS', 'CBM', 'A', 'Thermography of insulator strings for hotspots', 'Thermal camera', 'Delta T < 2°C', 'Thermographer', '1 Engineer + 1 Tech', 0.2, 'Yes'],
  ['INS-PREV-01', 'LINS', 'PREV', '3Y', 'Insulator cleaning / washing to remove pollution', 'Washing equipment, water', 'Pollution level reduced to acceptable (ESDD < 0.1 mg/cm²)', 'Lineman', '2 Linemen', 0.3, 'Yes'],
  ['INS-PREV-02', 'LINS', 'PREV', 'AN', 'Replace broken or damaged insulator discs', 'Replacement discs, tools', 'All discs intact; string strength restored', 'Lineman', '2 Linemen + 1 Engineer', 0.5, 'Yes'],
  ['INS-CBM-01', 'LINS', 'CBM', 'A', 'Insulator pollution measurement (ESDD/NSDD)', 'Pollution measurement kit', 'ESDD < 0.1 mg/cm²', 'Testing Specialist', '1 Engineer + 1 Tech', 0.2, 'No'],
  ['COND-INSP-02', 'LCON', 'CBM', 'A', 'Thermography of conductor joints and jumpers', 'Thermal camera', 'Delta T < 5°C', 'Thermographer', '1 Engineer + 1 Tech', 0.2, 'Yes'],
  ['COND-PREV-01', 'LCON', 'PREV', 'AN', 'Repair broken conductor strands', 'Repair rods, clamps', 'Repair restores 100% strength', 'Lineman', '2 Linemen + 1 Engineer', 0.5, 'Yes'],
  ['COND-PREV-02', 'LCON', 'PREV', '3Y', 'Measure conductor sag', 'Sag measuring kit', 'Sag within ±2% of design', 'Transmission Engineer', '1 Engineer + 2 Techs', 0.3, 'Yes'],
  ['COND-PREV-03', 'LCON', 'PREV', 'A', 'Inspect jumper connections and clamps for overheating and tightness', 'Thermal camera, torque wrench', 'No overheating; clamps tight', 'Lineman', '2 Linemen', 0.2, 'Yes'],
  ['COND-CBM-01', 'LCON', 'CBM', 'A', 'Conductor vibration analysis', 'Vibration recorder', 'Vibration level < limit', 'Transmission Engineer', '1 Engineer + 1 Tech', 0.2, 'Yes'],
  ['OPGW-PREV-01', 'OPGW', 'PREV', 'A', 'OTDR test of OPGW fibre', 'OTDR test set', 'Loss < 0.1 dB; no breaks', 'Telecom Technician', '1 Telecom + 1 Tech', 0.2, 'Yes'],
  ['OPGW-PREV-02', 'FOJB', 'PREV', 'A', 'Inspect FO joint box for sealing, water ingress, splice tray', 'Tools, sealing kit', 'Sealed, no water, splices intact', 'Telecom Technician', '1 Telecom + 1 Tech', 0.1, 'No'],
  ['FOJB-INSP-01', 'FOJB', 'INSP', 'Q', 'Visual check of FO joint box condition, mounting, corrosion', 'Visual, camera', 'No corrosion, mounting secure', 'Telecom Technician', '1 Telecom', 0.1, 'No'],
  ['VEG-INSP-01', 'VEG', 'INSP', 'Q', 'Inspect vegetation encroachment and clearance to conductors', 'Laser distance meter, camera', 'Min clearance: 400 kV = 5.0 m, 230 kV = 4.0 m, 132 kV = 3.0 m', 'Vegetation Crew', '1 Engineer + 2 Crew', 0.2, 'No'],
  ['VEG-PREV-01', 'VEG', 'PREV', 'A', 'Clear trees and vegetation within right-of-way', 'Chainsaw, brush cutter', 'Clearance maintained; no trees within ROW', 'Vegetation Crew', '1 Engineer + 4 Crew', 0.5, 'No'],
  ['HW-INSP-01', 'HW', 'INSP', 'A', 'Inspect vibration dampers, spacers, grading rings', 'Binoculars, camera', 'No missing; no damage', 'Lineman', '2 Linemen', 0.1, 'Yes'],
  ['GRD-PREV-01', 'GRD', 'PREV', '5Y', 'Improve tower grounding by adding ground rods', 'Ground rods, conductors', 'Resistance < 10 Ohm', 'Electrical Technician', '1 Engineer + 2 Techs', 0.5, 'No'],
  ['TWR-CBM-02', 'GRD', 'CBM', 'A', 'Measure tower grounding resistance', 'Earth tester', 'Resistance < 10 Ohm', 'Electrical Technician', '1 Engineer + 1 Tech', 0.2, 'No'],
];

const ROWS = RAW_ROWS.map(([id, cat, stream, freq, desc, tools, cond, skill, team, days, loto]) => (
  { id, cat, stream, freq, desc, tools, cond, skill, team, days, loto }
));

const VISUAL = 'Visual';
const MECHANICAL = 'Mechanical';
const ELECTRICAL = 'Electrical';
const TESTING = 'Testing';
const PROTECTION = 'Protection';
const AUTOMATION = 'Automation';
const TELECOM = 'Telecom';
const BATTERY = 'Battery';
const CIVIL = 'Civil';

// One small question per item, with its discipline and test equipment.
const QUESTIONS = {
  'TR-INSP-01': [
    { q: 'Is the main conservator oil level within the normal range for the prevailing oil temperature?', type: 'YES_NO', section: VISUAL, equip: 'Flashlight, inspection mirror' },
    { q: 'Is the OLTC conservator oil level within the normal range?', type: 'YES_NO', section: VISUAL, equip: 'Flashlight, inspection mirror' },
    { q: 'Are the bushing oil cups at the normal oil level?', type: 'YES_NO', section: VISUAL, equip: 'Flashlight, inspection mirror' },
  ],
  'TR-INSP-02': [
    { q: 'Is the silica gel in the breather active (dark blue or vibrant orange)?', type: 'YES_NO', section: VISUAL, equip: 'Visual check' },
  ],
  'TR-INSP-03': [
    { q: 'Is the transformer tank free of active oil leaks?', type: 'YES_NO', section: VISUAL, equip: 'Lint-free wipes, flashlight' },
    { q: 'Are the gaskets, valves and flanges free of active oil leaks?', type: 'YES_NO', section: VISUAL, equip: 'Lint-free wipes, flashlight' },
    { q: 'Are the radiators and bushings free of active oil leaks?', type: 'YES_NO', section: VISUAL, equip: 'Lint-free wipes, flashlight' },
  ],
  'TR-INSP-04': [
    { q: 'Do all cooling fans run without abnormal noise or vibration?', type: 'YES_NO', section: MECHANICAL, equip: 'Flashlight' },
    { q: 'Do all oil pumps run without abnormal noise or vibration?', type: 'YES_NO', section: MECHANICAL, equip: 'Flashlight' },
    { q: 'Are the radiators free of leaks or blockage?', type: 'YES_NO', section: VISUAL, equip: 'Flashlight' },
    { q: 'Are the cooling control cubicle alarms correct?', type: 'YES_NO', section: ELECTRICAL, equip: 'Multimeter' },
  ],
  'TR-INSP-05': [
    { q: 'Does the OLTC counter advance on each operation?', type: 'YES_NO', section: MECHANICAL, equip: 'Logsheet, flashlight' },
    { q: 'Is the OLTC motor drive free of mechanical damage?', type: 'YES_NO', section: MECHANICAL, equip: 'Flashlight' },
    { q: 'Is the OLTC free of oil leaks?', type: 'YES_NO', section: VISUAL, equip: 'Flashlight' },
  ],
  'TR-PREV-01': [
    { q: 'What is the Acetylene (C2H2) concentration on DGA?', type: 'NUMERIC', min: 0, max: 0, unit: 'ppm', section: TESTING, equip: 'Glass syringe, amber bottles, purge oil', critical: true },
    { q: 'What is the Hydrogen (H2) concentration on DGA?', type: 'NUMERIC', min: 0, max: 100, unit: 'ppm', section: TESTING, equip: 'Glass syringe, amber bottles, purge oil', critical: true },
    { q: 'Are all other combustible gases within IEEE C57.104 limits?', type: 'YES_NO', section: TESTING, equip: 'Gas chromatography kit', critical: true },
  ],
  'TR-PREV-02': [
    { q: 'What is the oil dielectric breakdown voltage (BDV)?', type: 'NUMERIC', min: 50, max: 200, unit: 'kV', section: TESTING, equip: 'BDV test set', critical: true },
    { q: 'What is the oil moisture content?', type: 'NUMERIC', min: 0, max: 15, unit: 'ppm', section: TESTING, equip: 'Karl Fischer kit', critical: true },
  ],
  'TR-PREV-03': [
    { q: 'What is the Polarization Index (PI)?', type: 'NUMERIC', min: 1.2, max: 100, unit: '', section: TESTING, equip: 'Megger S1-568', critical: true },
    { q: 'Does the insulation resistance match the factory baseline?', type: 'YES_NO', section: TESTING, equip: 'Megger S1-568, discharge wand', critical: true },
  ],
  'TR-PREV-04': [
    { q: 'Is the OLTC contact wear within the manufacturer limit?', type: 'YES_NO', section: MECHANICAL, equip: 'Contact gauge', critical: true },
    { q: 'Does the OLTC motor drive operate smoothly through all tap positions?', type: 'YES_NO', section: MECHANICAL, equip: 'Hand tools', critical: true },
    { q: 'Do the OLTC limit switches stop the drive at both end positions?', type: 'YES_NO', section: ELECTRICAL, equip: 'Hand tools', critical: true },
  ],
  'TR-PREV-05': [
    { q: 'Do all cooling stages start automatically at their setpoints?', type: 'YES_NO', section: ELECTRICAL, equip: 'Multimeter, thermometers', critical: true },
    { q: 'Are the cooling control alarms correct when each stage is forced?', type: 'YES_NO', section: ELECTRICAL, equip: 'Multimeter, thermometers', critical: true },
  ],
  'TR-CBM-01': [
    { q: 'What is the bushing Tan Delta at 20 C?', type: 'NUMERIC', min: 0, max: 0.5, unit: '%', section: TESTING, equip: 'OMICRON DIRANA / CPC 100', critical: true },
    { q: 'What is the bushing capacitance deviation from nameplate?', type: 'NUMERIC', min: -2, max: 2, unit: '%', section: TESTING, equip: 'OMICRON DIRANA / CPC 100', critical: true },
  ],
  'TR-CBM-02': [
    { q: 'What is the winding resistance deviation from baseline?', type: 'NUMERIC', min: -2, max: 2, unit: '%', section: TESTING, equip: 'Transformer ohmmeter', critical: true },
    { q: 'What is the turns ratio deviation from nameplate?', type: 'NUMERIC', min: -2, max: 2, unit: '%', section: TESTING, equip: 'TTR', critical: true },
    { q: 'Is the magnetic balance within 2% of baseline?', type: 'YES_NO', section: TESTING, equip: 'Transformer ohmmeter, TTR', critical: true },
  ],
  'CB-INSP-01': [
    { q: 'In which zone is the SF6 density gauge pointer for the recorded ambient temperature?', type: 'SELECT', options: ['Green', 'Amber', 'Red', 'Below scale'], pass: ['Green'], section: VISUAL, equip: 'Density gauge, thermometer' },
  ],
  'CB-INSP-02': [
    { q: 'Is the hydraulic or spring mechanism pressure normal?', type: 'YES_NO', section: MECHANICAL, equip: 'Multimeter, flashlight' },
    { q: 'Is the motor recharge time less than 3 minutes?', type: 'YES_NO', section: ELECTRICAL, equip: 'Multimeter' },
    { q: 'Are the mechanism cabinet heaters functional?', type: 'YES_NO', section: ELECTRICAL, equip: 'Multimeter' },
  ],
  'CB-INSP-03': [
    { q: 'Are the trip and close coils free of alarms?', type: 'YES_NO', section: ELECTRICAL, equip: 'Multimeter' },
    { q: 'Is the anti-pumping function correct?', type: 'YES_NO', section: ELECTRICAL, equip: 'Multimeter, logsheet' },
    { q: 'Are the local and remote position indications correct?', type: 'YES_NO', section: ELECTRICAL, equip: 'Logsheet' },
  ],
  'CB-PREV-01': [
    { q: 'What is the opening time deviation from the manufacturer specification?', type: 'NUMERIC', min: -2, max: 2, unit: 'ms', section: TESTING, equip: 'OMICRON CIBANO 500', critical: true },
    { q: 'What is the closing time deviation from the manufacturer specification?', type: 'NUMERIC', min: -2, max: 2, unit: 'ms', section: TESTING, equip: 'OMICRON CIBANO 500', critical: true },
    { q: 'What is the pole-to-pole synchronization deviation?', type: 'NUMERIC', min: -2, max: 2, unit: 'ms', section: TESTING, equip: 'OMICRON CIBANO 500', critical: true },
  ],
  'CB-PREV-02': [
    { q: 'What is the highest pole contact resistance?', type: 'NUMERIC', min: 0, max: 50, unit: 'uOhm', section: TESTING, equip: 'Micro-ohmmeter DLRO', critical: true },
  ],
  'CB-PREV-03': [
    { q: 'Is the trip coil current within the manufacturer curve?', type: 'YES_NO', section: TESTING, equip: 'Coil current tester', critical: true },
    { q: 'Is the close coil current within the manufacturer curve?', type: 'YES_NO', section: TESTING, equip: 'Coil current tester', critical: true },
    { q: 'Are the auxiliary contacts operating correctly?', type: 'YES_NO', section: ELECTRICAL, equip: 'Coil current tester' },
  ],
  'CB-CBM-01': [
    { q: 'What is the SF6 gas purity?', type: 'NUMERIC', min: 99, max: 100, unit: '%', section: TESTING, equip: 'DILO / WIKA SF6 analyzer', critical: true },
    { q: 'What is the SF6 dew point?', type: 'NUMERIC', min: -80, max: -30, unit: 'C', section: TESTING, equip: 'DILO / WIKA SF6 analyzer', critical: true },
    { q: 'What is the SF6 SO2 content?', type: 'NUMERIC', min: 0, max: 10, unit: 'ppm', section: TESTING, equip: 'DILO / WIKA SF6 analyzer', critical: true },
  ],
  'CT-INSP-01': [
    { q: 'For oil-filled CTs, is the oil level visible in the sight glass?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, flashlight' },
    { q: 'Is the oil level within the normal range for the prevailing oil temperature?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, flashlight' },
    { q: 'Is the porcelain or composite insulation free of hairline cracks?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, wipes' },
    { q: 'Is the insulation free of contamination, pollution or flashover tracking marks?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, wipes' },
    { q: 'Are the primary and secondary terminal connections tight and free of overheating or corrosion?', type: 'YES_NO', section: MECHANICAL, equip: 'Hand tools, thermal camera' },
    { q: 'Are the secondary circuit wiring and polarity identification tags correct and secure?', type: 'YES_NO', section: ELECTRICAL, equip: 'Multimeter, logsheet' },
    { q: 'What is the insulation resistance?', type: 'NUMERIC', min: 100, max: 100000, unit: 'MΩ', section: ELECTRICAL, equip: 'Megger S1-568, discharge wand' },
  ],
  'CT-PREV-01': [
    { q: 'What is the knee-point voltage deviation from the rating curve?', type: 'NUMERIC', min: -10, max: 10, unit: '%', section: TESTING, equip: 'OMICRON CT Analyzer', critical: true },
    { q: 'What is the secondary winding resistance deviation from rated?', type: 'NUMERIC', min: -5, max: 5, unit: '%', section: TESTING, equip: 'OMICRON CT Analyzer, Kelvin clips', critical: true },
  ],
  'VT-INSP-01': [
    { q: 'Is the insulation free of hairline cracks?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, wipes' },
    { q: 'Is the insulation free of contamination, pollution or flashover tracking marks?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, wipes' },
    { q: 'Are the primary and secondary terminal connections tight and free of corrosion?', type: 'YES_NO', section: MECHANICAL, equip: 'Hand tools' },
    { q: 'Are the secondary fuses and links in good condition?', type: 'YES_NO', section: ELECTRICAL, equip: 'Multimeter' },
    { q: 'What is the secondary voltage at each phase?', type: 'NUMERIC', min: 55, max: 125, unit: 'V', section: ELECTRICAL, equip: 'Multimeter' },
    { q: 'Are the ratio and polarity identification tags present and legible?', type: 'YES_NO', section: VISUAL, equip: 'Logsheet' },
  ],
  'VT-PREV-01': [
    { q: 'Is the VT ratio correct?', type: 'YES_NO', section: TESTING, equip: 'VT test set', critical: true },
    { q: 'Is the polarity correct?', type: 'YES_NO', section: TESTING, equip: 'VT test set', critical: true },
    { q: 'Is the burden within the rated limit?', type: 'YES_NO', section: TESTING, equip: 'VT test set', critical: true },
  ],
  'CVT-INSP-01': [
    { q: 'Is the oil level visible in the sight glass?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, flashlight' },
    { q: 'Is the oil level within the normal range for the prevailing oil temperature?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, flashlight' },
    { q: 'Is the porcelain or composite insulation free of hairline cracks?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, wipes' },
    { q: 'Is the insulation free of contamination, pollution or flashover tracking marks?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, wipes' },
  ],
  'CVT-CBM-01': [
    { q: 'What is the CVT Tan Delta?', type: 'NUMERIC', min: 0, max: 0.7, unit: '%', section: TESTING, equip: 'OMICRON CPC 100', critical: true },
    { q: 'What is the CVT capacitance deviation from the factory baseline?', type: 'NUMERIC', min: -1, max: 1, unit: '%', section: TESTING, equip: 'OMICRON CPC 100', critical: true },
  ],
  'DS-INSP-01': [
    { q: 'Is the disconnector blade fully engaged inside the fixed fingers?', type: 'YES_NO', section: MECHANICAL, equip: 'Binoculars, mirror', critical: true },
    { q: 'Are the silver-plated contact surfaces clean?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, mirror' },
    { q: 'Are the contact surfaces free of damage?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, mirror' },
  ],
  'DS-INSP-02': [
    { q: 'Do the disconnector interlocks operate correctly?', type: 'YES_NO', section: MECHANICAL, equip: 'Hand tools', critical: true },
    { q: 'Does the earth switch operate without jamming?', type: 'YES_NO', section: MECHANICAL, equip: 'Hand tools' },
    { q: 'Is the mechanical linkage free of jamming?', type: 'YES_NO', section: MECHANICAL, equip: 'Hand tools, logsheet' },
  ],
  'DS-PREV-01': [
    { q: 'What is the contact resistance across the closed blades?', type: 'NUMERIC', min: 0, max: 50, unit: 'uOhm', section: TESTING, equip: 'DLRO 100, clamp leads', critical: true },
  ],
  'SA-INSP-01': [
    { q: 'Is the surge counter secure?', type: 'YES_NO', section: MECHANICAL, equip: 'Wrench set' },
    { q: 'Are the surge counter logs recorded?', type: 'YES_NO', section: VISUAL, equip: 'Logsheet' },
    { q: 'Is the discharge path clear?', type: 'YES_NO', section: VISUAL, equip: 'Logsheet' },
    { q: 'Is the arrester base mounting free of structural corrosion?', type: 'YES_NO', section: VISUAL, equip: 'Wrench set' },
  ],
  'SA-CBM-01': [
    { q: 'Is the resistive leakage current within the manufacturer baseline?', type: 'YES_NO', section: TESTING, equip: 'Leakage current monitor' },
    { q: 'Is the third-harmonic component within the baseline?', type: 'YES_NO', section: TESTING, equip: 'Leakage current monitor' },
  ],
  'BR-INSP-01': [
    { q: 'Are the busbar supports and clamps free of loose hardware?', type: 'YES_NO', section: MECHANICAL, equip: 'Binoculars, flashlight' },
    { q: 'Are the busbar insulators free of breakage?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, flashlight' },
    { q: 'Are the reactor tanks and capacitor units free of oil weeping?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, flashlight' },
  ],
  'BR-PREV-01': [
    { q: 'What is the capacitor bank capacitance deviation from rating?', type: 'NUMERIC', min: -2, max: 2, unit: '%', section: TESTING, equip: 'Capacitance meter', critical: true },
  ],
  'BR-PREV-02': [
    { q: 'What is the reactor winding resistance deviation from baseline?', type: 'NUMERIC', min: -5, max: 5, unit: '%', section: TESTING, equip: 'Micro-ohmmeter', critical: true },
    { q: 'Is the reactor insulation resistance acceptable?', type: 'YES_NO', section: TESTING, equip: 'Megger', critical: true },
  ],
  'BC-INSP-01': [
    { q: 'Is the buscoupler CB SF6 pressure normal?', type: 'YES_NO', section: VISUAL, equip: 'Flashlight, logsheet' },
    { q: 'Do the buscoupler disconnectors operate correctly?', type: 'YES_NO', section: MECHANICAL, equip: 'Flashlight' },
    { q: 'Do the buscoupler earth switches operate correctly?', type: 'YES_NO', section: MECHANICAL, equip: 'Flashlight' },
    { q: 'Are the buscoupler interlocks correct?', type: 'YES_NO', section: MECHANICAL, equip: 'Logsheet' },
    { q: 'Are the buscoupler alarms normal?', type: 'YES_NO', section: ELECTRICAL, equip: 'Logsheet' },
  ],
  'BC-PREV-01': [
    { q: 'What is the CB opening/closing time deviation?', type: 'NUMERIC', min: -2, max: 2, unit: 'ms', section: TESTING, equip: 'CIBANO 500', critical: true },
    { q: 'What is the CB contact resistance?', type: 'NUMERIC', min: 0, max: 50, unit: 'uOhm', section: TESTING, equip: 'DLRO', critical: true },
    { q: 'What is the DS/ES contact resistance?', type: 'NUMERIC', min: 0, max: 50, unit: 'uOhm', section: TESTING, equip: 'DLRO', critical: true },
    { q: 'Did the protection trip test operate correctly?', type: 'YES_NO', section: PROTECTION, equip: 'Relay test set', critical: true },
  ],
  'SAS-INSP-01': [
    { q: 'Is the GPS master clock locked?', type: 'YES_NO', section: AUTOMATION, equip: 'HMI diagnostics' },
    { q: 'Is the time drift below 1 ms?', type: 'NUMERIC', min: 0, max: 1, unit: 'ms', section: AUTOMATION, equip: 'HMI diagnostics' },
    { q: 'Are there zero unacknowledged critical HMI/SCADA alarms?', type: 'YES_NO', section: AUTOMATION, equip: 'HMI diagnostics' },
  ],
  'SAS-INSP-02': [
    { q: 'Are the gateway and RTU communication links free of alarms?', type: 'YES_NO', section: AUTOMATION, equip: 'Laptop' },
    { q: 'Are the network switches free of alarms?', type: 'YES_NO', section: AUTOMATION, equip: 'Laptop' },
    { q: 'Are the fibre links free of alarms?', type: 'YES_NO', section: AUTOMATION, equip: 'Optical power meter' },
    { q: 'Is the optical power within the receiver sensitivity range?', type: 'YES_NO', section: AUTOMATION, equip: 'Optical power meter' },
  ],
  'SAS-CBM-01': [
    { q: 'Are there zero GOOSE/SV packet drops?', type: 'YES_NO', section: AUTOMATION, equip: 'Wireshark laptop, fibre test cables' },
    { q: 'Is VLAN separation maintained?', type: 'YES_NO', section: AUTOMATION, equip: 'Wireshark laptop' },
    { q: 'Is the process bus free of unauthorised MAC addresses?', type: 'YES_NO', section: AUTOMATION, equip: 'Wireshark laptop' },
  ],
  'REL-PREV-01': [
    { q: 'What is the pickup threshold deviation from the relay setting sheet?', type: 'NUMERIC', min: -5, max: 5, unit: '%', section: PROTECTION, equip: 'OMICRON CMC 356', critical: true },
    { q: 'What is the operating time characteristic deviation from the setting sheet?', type: 'NUMERIC', min: -5, max: 5, unit: '%', section: PROTECTION, equip: 'OMICRON CMC 356', critical: true },
    { q: 'Did the relay trip the breaker correctly during injection?', type: 'YES_NO', section: PROTECTION, equip: 'OMICRON CMC 356', critical: true },
  ],
  'REL-PREV-02': [
    { q: 'Is the DC supply free of earth faults?', type: 'YES_NO', section: PROTECTION, equip: 'Multimeter, test set', critical: true },
    { q: 'Is the trip circuit supervision healthy?', type: 'YES_NO', section: PROTECTION, equip: 'Multimeter, test set', critical: true },
    { q: 'Are the CB trip and close coils intact?', type: 'YES_NO', section: PROTECTION, equip: 'Multimeter, test set', critical: true },
  ],
  'REL-PREV-03': [
    { q: 'Does the scheme logic match the approved scheme?', type: 'YES_NO', section: PROTECTION, equip: 'Relay test set, laptop', critical: true },
    { q: 'Do the interlock functions operate correctly?', type: 'YES_NO', section: PROTECTION, equip: 'Relay test set', critical: true },
    { q: 'Does the auto-reclose function operate correctly?', type: 'YES_NO', section: PROTECTION, equip: 'Relay test set', critical: true },
    { q: 'Does the breaker-failure function operate correctly?', type: 'YES_NO', section: PROTECTION, equip: 'Relay test set', critical: true },
  ],
  'DC-INSP-01': [
    { q: 'What is the individual cell float voltage?', type: 'NUMERIC', min: 2.21, max: 2.25, unit: 'V', section: BATTERY, equip: 'Multimeter' },
    { q: 'What is the electrolyte specific gravity corrected to 25 C?', type: 'NUMERIC', min: 1.21, max: 1.22, unit: '', section: BATTERY, equip: 'Hydrometer, PPE' },
    { q: 'Is the electrolyte level between the minimum and maximum marks?', type: 'YES_NO', section: BATTERY, equip: 'PPE' },
  ],
  'DC-PREV-01': [
    { q: 'What is the lowest individual cell voltage during the discharge?', type: 'NUMERIC', min: 1.8, max: 99, unit: 'V', section: BATTERY, equip: 'DC load bank, data logger', critical: true },
    { q: 'Did the battery sustain the rated autonomy duration?', type: 'YES_NO', section: BATTERY, equip: 'DC load bank, data logger', critical: true },
    { q: 'Is the thermal image free of hot cells or connections?', type: 'YES_NO', section: BATTERY, equip: 'Thermal camera' },
  ],
  'TEL-INSP-01': [
    { q: 'Is the optical power within the receiver sensitivity threshold?', type: 'YES_NO', section: TELECOM, equip: 'Optical power meter' },
    { q: 'Is the radio status normal?', type: 'YES_NO', section: TELECOM, equip: 'Logsheet' },
    { q: 'Is the SCADA link normal?', type: 'YES_NO', section: TELECOM, equip: 'Logsheet' },
    { q: 'Are there any communication alarms?', type: 'YES_NO', section: TELECOM, equip: 'Logsheet' },
  ],
  'TEL-PREV-01': [
    { q: 'What is the measured bit error rate (BER)?', type: 'NUMERIC', min: 0, max: 0.000000001, unit: '', section: TELECOM, equip: 'BER test set' },
    { q: 'Is the optical power within receiver sensitivity?', type: 'YES_NO', section: TELECOM, equip: 'Optical power meter' },
    { q: 'Is the fibre or microwave link stable?', type: 'YES_NO', section: TELECOM, equip: 'Radio kit' },
    { q: 'Is the PLC link stable?', type: 'YES_NO', section: TELECOM, equip: 'Radio kit' },
    { q: 'Is the dispatch link stable?', type: 'YES_NO', section: TELECOM, equip: 'Radio kit' },
  ],
  'CIV-INSP-01': [
    { q: 'Is the perimeter fence intact?', type: 'YES_NO', section: CIVIL, equip: 'Visual walk-around' },
    { q: 'Do the gates latch securely?', type: 'YES_NO', section: CIVIL, equip: 'Visual walk-around' },
    { q: 'Are the cable trenches clear of debris and oil sludge?', type: 'YES_NO', section: CIVIL, equip: 'Visual walk-around' },
    { q: 'Is the drainage clear?', type: 'YES_NO', section: CIVIL, equip: 'Visual walk-around' },
  ],
  'CIV-PREV-01': [
    { q: 'What is the main earthing grid resistance?', type: 'NUMERIC', min: 0, max: 1, unit: 'Ohm', section: TESTING, equip: 'Megger DET2/2, test spikes', critical: true },
    { q: 'Are the step potentials within the calculated safe limits?', type: 'YES_NO', section: TESTING, equip: 'Megger DET2/2, test spikes', critical: true },
    { q: 'Are the touch potentials within the calculated safe limits?', type: 'YES_NO', section: TESTING, equip: 'Megger DET2/2, test spikes', critical: true },
  ],
  'LINE-INSP-01': [
    { q: 'Is the line bay circuit breaker free of visible damage?', type: 'YES_NO', section: VISUAL, equip: 'Flashlight, binoculars' },
    { q: 'Are the line bay disconnectors and earth switches free of visible damage?', type: 'YES_NO', section: VISUAL, equip: 'Flashlight, binoculars' },
    { q: 'Are the line bay CTs, VTs and surge arresters free of visible damage?', type: 'YES_NO', section: VISUAL, equip: 'Flashlight, binoculars' },
    { q: 'Is the line bay busbar free of visible damage?', type: 'YES_NO', section: VISUAL, equip: 'Flashlight, binoculars' },
    { q: 'Are the line bay control alarms normal?', type: 'YES_NO', section: ELECTRICAL, equip: 'Logsheet' },
  ],
  'LINE-PREV-01': [
    { q: 'Is the line bay CB timing within limits?', type: 'YES_NO', section: TESTING, equip: 'CIBANO 500', critical: true },
    { q: 'Are the line bay CT/VT tests within limits?', type: 'YES_NO', section: TESTING, equip: 'CT analyzer', critical: true },
    { q: 'Is the line bay DS/ES contact resistance within limits?', type: 'YES_NO', section: TESTING, equip: 'DLRO', critical: true },
    { q: 'Is the line bay surge arrester test within limits?', type: 'YES_NO', section: TESTING, equip: 'Leakage current monitor', critical: true },
    { q: 'Did the line bay protection trip test operate correctly?', type: 'YES_NO', section: PROTECTION, equip: 'Relay test set', critical: true },
  ],
  'TWR-INSP-01': [
    { q: 'Are all tower lattice members present?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, camera' },
    { q: 'Are the tower members free of bending greater than 5 degrees?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, camera' },
    { q: 'Is the corrosion section loss on tower members less than 10%?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, camera' },
  ],
  'INS-INSP-01': [
    { q: 'Are the insulator strings free of broken discs?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, camera' },
    { q: 'Are the insulator strings free of cracks?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, camera' },
    { q: 'Is the insulator contamination level below moderate?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, camera' },
  ],
  'COND-INSP-01': [
    { q: 'Are the conductors free of broken strands?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, camera' },
    { q: 'Are the conductors free of corrosion?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, camera' },
    { q: 'Are the conductors free of vibration damage?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, camera' },
  ],
  'OPGW-INSP-01': [
    { q: 'Is the OPGW cable free of damage?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, camera' },
    { q: 'Are the OPGW clamps secure and undamaged?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, camera' },
    { q: 'Are the OPGW splices and supports intact?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, camera' },
  ],
  'ROW-INSP-01': [
    { q: 'Are the right-of-way access roads passable?', type: 'YES_NO', section: CIVIL, equip: 'Visual walk-around' },
    { q: 'Are the right-of-way gates functional?', type: 'YES_NO', section: CIVIL, equip: 'Visual walk-around' },
  ],
  'TWR-INSP-02': [
    { q: 'Are all tower bolts, nuts and cotter pins present?', type: 'YES_NO', section: MECHANICAL, equip: 'Torque wrench, spanner set' },
    { q: 'Is the tower bolt torque within ±10% of specification?', type: 'YES_NO', section: MECHANICAL, equip: 'Torque wrench' },
  ],
  'TWR-INSP-05': [
    { q: 'Is the tower rust area less than 5%?', type: 'YES_NO', section: VISUAL, equip: 'Rust meter, visual' },
    { q: 'Is the tower galvanization intact?', type: 'YES_NO', section: VISUAL, equip: 'Rust meter, visual' },
  ],
  'TWR-PREV-01': [
    { q: 'Are all missing tower members replaced?', type: 'YES_NO', section: MECHANICAL, equip: 'Replacement members, tools' },
    { q: 'Are all bent tower members replaced?', type: 'YES_NO', section: MECHANICAL, equip: 'Replacement members, tools' },
    { q: 'Is the tower structural integrity restored?', type: 'YES_NO', section: MECHANICAL, equip: 'Replacement members, tools', critical: true },
  ],
  'TWR-PREV-02': [
    { q: 'Is the torque of all tower bolts per specification?', type: 'YES_NO', section: MECHANICAL, equip: 'Torque wrench', critical: true },
  ],
  'TWR-CBM-01': [
    { q: 'Is the tower vibration within acceptable limits?', type: 'YES_NO', section: TESTING, equip: 'Vibration recorder' },
  ],
  'TWR-INSP-04': [
    { q: 'Is the largest foundation crack width less than 0.3 mm?', type: 'YES_NO', section: CIVIL, equip: 'Crack gauge' },
    { q: 'Is the foundation settlement less than 5 mm?', type: 'YES_NO', section: CIVIL, equip: 'Level, measuring tape' },
    { q: 'Is the foundation exposure less than 300 mm?', type: 'YES_NO', section: CIVIL, equip: 'Measuring tape' },
    { q: 'Is the foundation free of erosion?', type: 'YES_NO', section: CIVIL, equip: 'Measuring tape' },
  ],
  'FND-PREV-01': [
    { q: 'Are the foundation cracks repaired to original strength?', type: 'YES_NO', section: CIVIL, equip: 'Grout, protective coating' },
    { q: 'Is the exposed foundation surface protected?', type: 'YES_NO', section: CIVIL, equip: 'Protective coating' },
  ],
  'INS-INSP-02': [
    { q: 'Is the insulator string temperature differential less than 2°C?', type: 'YES_NO', section: TESTING, equip: 'Thermal camera', critical: true },
  ],
  'INS-PREV-01': [
    { q: 'Are the insulator strings cleaned / washed?', type: 'YES_NO', section: MECHANICAL, equip: 'Washing equipment, water' },
    { q: 'Is the pollution level after cleaning acceptable (ESDD < 0.1 mg/cm²)?', type: 'YES_NO', section: TESTING, equip: 'Pollution measurement kit', critical: true },
  ],
  'INS-PREV-02': [
    { q: 'Are all broken or damaged insulator discs replaced?', type: 'YES_NO', section: MECHANICAL, equip: 'Replacement discs, tools' },
    { q: 'Is the insulator string mechanical strength restored?', type: 'YES_NO', section: MECHANICAL, equip: 'Replacement discs, tools', critical: true },
  ],
  'INS-CBM-01': [
    { q: 'What is the equivalent salt deposit density (ESDD)?', type: 'NUMERIC', min: 0, max: 0.1, unit: 'mg/cm²', section: TESTING, equip: 'Pollution measurement kit', critical: true },
  ],
  'COND-INSP-02': [
    { q: 'Is the conductor joint temperature differential less than 5°C?', type: 'YES_NO', section: TESTING, equip: 'Thermal camera', critical: true },
  ],
  'COND-PREV-01': [
    { q: 'Are all broken conductor strands repaired?', type: 'YES_NO', section: MECHANICAL, equip: 'Repair rods, clamps' },
    { q: 'Is the repaired conductor strength restored to 100%?', type: 'YES_NO', section: MECHANICAL, equip: 'Repair rods, clamps', critical: true },
  ],
  'COND-PREV-02': [
    { q: 'Is the conductor sag within ±2% of design?', type: 'YES_NO', section: TESTING, equip: 'Sag measuring kit', critical: true },
  ],
  'COND-PREV-03': [
    { q: 'Are the jumper connections free of overheating?', type: 'YES_NO', section: TESTING, equip: 'Thermal camera' },
    { q: 'Are the jumper clamps tight?', type: 'YES_NO', section: MECHANICAL, equip: 'Torque wrench' },
  ],
  'COND-CBM-01': [
    { q: 'Is the conductor vibration level below the limit?', type: 'YES_NO', section: TESTING, equip: 'Vibration recorder' },
  ],
  'OPGW-PREV-01': [
    { q: 'Is the OPGW fibre loss less than 0.1 dB?', type: 'YES_NO', section: TELECOM, equip: 'OTDR test set', critical: true },
    { q: 'Is the OPGW fibre free of breaks?', type: 'YES_NO', section: TELECOM, equip: 'OTDR test set', critical: true },
  ],
  'OPGW-PREV-02': [
    { q: 'Is the FO joint box properly sealed?', type: 'YES_NO', section: TELECOM, equip: 'Tools, sealing kit' },
    { q: 'Is the FO joint box free of water ingress?', type: 'YES_NO', section: TELECOM, equip: 'Tools, sealing kit' },
    { q: 'Are the splice trays intact?', type: 'YES_NO', section: TELECOM, equip: 'Tools, sealing kit' },
  ],
  'FOJB-INSP-01': [
    { q: 'Is the FO joint box free of corrosion?', type: 'YES_NO', section: TELECOM, equip: 'Camera' },
    { q: 'Is the FO joint box mounting secure?', type: 'YES_NO', section: MECHANICAL, equip: 'Camera' },
  ],
  'VEG-INSP-01': [
    { q: 'Is the minimum vegetation clearance to conductors at least 5.0 m (400 kV requirement)?', type: 'YES_NO', section: CIVIL, equip: 'Laser distance meter, camera' },
  ],
  'VEG-PREV-01': [
    { q: 'Are all trees within the right-of-way cleared?', type: 'YES_NO', section: CIVIL, equip: 'Chainsaw, brush cutter' },
    { q: 'Is the right-of-way clearance maintained?', type: 'YES_NO', section: CIVIL, equip: 'Chainsaw, brush cutter' },
  ],
  'HW-INSP-01': [
    { q: 'Are all vibration dampers present and undamaged?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, camera' },
    { q: 'Are all spacers present and undamaged?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, camera' },
    { q: 'Are all grading rings present and undamaged?', type: 'YES_NO', section: VISUAL, equip: 'Binoculars, camera' },
  ],
  'GRD-PREV-01': [
    { q: 'Is the tower grounding resistance below 10 Ohm after improvement?', type: 'YES_NO', section: ELECTRICAL, equip: 'Earth tester', critical: true },
  ],
  'TWR-CBM-02': [
    { q: 'What is the tower grounding resistance?', type: 'NUMERIC', min: 0, max: 10, unit: 'Ohm', section: ELECTRICAL, equip: 'Earth tester', critical: true },
  ],
};

const NON_MATERIAL = new Set(['visual check', 'visual walk-around']);
function uniqueTools(rows) {
  const seen = new Set();
  for (const r of rows) for (const t of r.tools.split(',').map((s) => s.trim())) {
    if (t && !NON_MATERIAL.has(t.toLowerCase())) seen.add(t);
  }
  return [...seen].join(', ');
}

// Turn a question spec into a checklist_item payload. Numeric limits and select
// options are persisted as JSON so the server can grade the captured response.
function toItem(q, sequence) {
  const response_type = q.type || 'YES_NO';
  let pass_criteria = null;
  if (response_type === 'NUMERIC') {
    pass_criteria = JSON.stringify({ min: q.min, max: q.max, ...(q.unit ? { unit: q.unit } : {}) });
  } else if (response_type === 'SELECT') {
    pass_criteria = JSON.stringify({ options: q.options, pass: q.pass });
  }
  return {
    sequence,
    section: q.section || null,
    instruction: q.q,
    response_type,
    required: 1,
    pass_criteria,
    critical_step: q.critical ? 1 : 0,
    test_equipment: q.equip || null,
  };
}

// Group the workbook rows into templates. Substation categories keep one
// template per asset category + stream + frequency; transmission-line families
// are consolidated into a single combined inspection / preventive / diagnostic
// checklist per family (see LINE_MERGE / LINE_GROUPS) so crews carry one list.
function buildWorkbookChecklists() {
  const groups = new Map();
  for (const r of ROWS) {
    const family = LINE_MERGE[r.cat];
    let key;
    if (!family) key = `${r.cat}|${r.stream}|${r.freq}`;
    else if (LINE_STREAM_SPLIT.has(family)) key = `LINE|${family}|${MAINT_STREAMS.has(r.stream) ? 'MAINT' : 'INSP'}`;
    else key = `LINE|${family}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const [key, rows] of groups) {
    const family = key.startsWith('LINE|') ? LINE_GROUPS[key.slice(5)] : null;
    let cat; let stream; let code; let name; let assetType; let voltage;
    if (family) {
      cat = { name: family.name };
      stream = family.stream
        ? STREAMS[family.stream]
        : { label: 'Inspection & Maintenance', category: 'PREVENTIVE_MAINTENANCE', task_type: 'PREVENTIVE' };
      code = family.code;
      name = family.name;
      assetType = family.asset_type;
      voltage = null;
    } else {
      const [catKey, streamKey, freqKey] = key.split('|');
      cat = CATEGORIES[catKey];
      stream = STREAMS[streamKey];
      code = CODE_OVERRIDES[key] || `CL-WB-${catKey}-${streamKey}-${freqKey}`;
      name = `${cat.name} — ${FREQUENCIES[freqKey]} ${stream.label}`;
      assetType = cat.asset_type;
      voltage = cat.voltage;
    }
    const loto = rows.some((r) => r.loto === 'Yes');
    const minutes = Math.round(Math.max(...rows.map((r) => r.days)) * 8 * 60);
    const items = [];
    for (const row of rows) {
      const questions = QUESTIONS[row.id] || [{ q: `${row.desc}?`, type: 'YES_NO' }];
      for (const q of questions) items.push(toItem(q, items.length + 1));
    }
    items.push({
      sequence: items.length + 1,
      section: 'GPS',
      instruction: `Capture the GPS position of the inspected ${cat.name}`,
      response_type: 'GPS_POINT',
      required: 1,
      pass_criteria: 'Recorded position matches the expected substation / bay geofence',
      critical_step: 1,
      test_equipment: 'GPS receiver',
    });
    const teams = [...new Set(rows.map((r) => r.team))].join(', ');
    const skills = [...new Set(rows.map((r) => r.skill))].join(', ');
    out.push({
      code,
      name,
      category: stream.category,
      asset_type: assetType,
      task_type: stream.task_type,
      applicable_voltage_kv: voltage,
      requires_supervisor_verification: loto ? 1 : 0,
      requires_gps_confirmation: 1,
      estimated_minutes: minutes,
      revision: WORKBOOK_REVISION,
      safety_notes: loto
        ? 'LOTO: Isolate, lock out and prove dead before work. Work under an approved permit.'
        : 'LOTO: Not required. Observe normal substation safety clearances.',
      materials: uniqueTools(rows),
      required_personnel: `Team: ${teams}. Skill: ${skills}.`,
      items,
    });
  }
  return out;
}

module.exports = { WORKBOOK_REVISION, CATEGORIES, STREAMS, FREQUENCIES, RAW_ROWS, QUESTIONS, buildWorkbookChecklists };
