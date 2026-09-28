// Standard transmission tower component catalog, per utility asset-management
// practice (lattice steel tower breakdown: insulation, hardware, structure,
// fittings, foundation, earthing, identification).
const COMPONENT_CATALOG = [
  { type: 'LINE_CONDUCTOR', name: 'Line conductor (span / jumper run)', material: 'ACSR', defaultQty: 3, unit: 'span' },
  { type: 'OPGW', name: 'OPGW (optical ground wire)', material: 'OPGW', defaultQty: 1, unit: 'span' },
  { type: 'EARTH_WIRE', name: 'Shield / earth wire', material: 'GALVANIZED_STEEL', defaultQty: 1, unit: 'span' },
  { type: 'INSULATOR_STRING', name: 'Insulator string (suspension / tension disc)', material: 'PORCELAIN', defaultQty: 6, unit: 'set' },
  { type: 'CONDUCTOR_CLAMP', name: 'Conductor suspension / tension clamp', material: 'GALVANIZED_STEEL', defaultQty: 6, unit: 'pcs' },
  { type: 'OPGW_CLAMP', name: 'OPGW suspension / tension clamp', material: 'GALVANIZED_STEEL', defaultQty: 2, unit: 'pcs' },
  { type: 'DAMPER', name: 'Stockbridge vibration damper', material: 'ALUMINUM', defaultQty: 12, unit: 'pcs' },
  { type: 'SPACER', name: 'Spacer / spacer damper', material: 'ALUMINUM', defaultQty: 9, unit: 'pcs' },
  { type: 'JOINT_BOX', name: 'Jumper connection / joint box', material: 'GALVANIZED_STEEL', defaultQty: 6, unit: 'pcs' },
  { type: 'LATTICE_MEMBER', name: 'Lattice steel member (legs, cross-arm, bracing)', material: 'GALVANIZED_STEEL', defaultQty: 24, unit: 'pcs' },
  { type: 'GUSSET_PLATE', name: 'Gusset / connection plate', material: 'GALVANIZED_STEEL', defaultQty: 18, unit: 'pcs' },
  { type: 'BOLT_NUT', name: 'Galvanized bolt, nut & washer', material: 'GALVANIZED_STEEL', defaultQty: 120, unit: 'pcs' },
  { type: 'CROSS_ARM', name: 'Cross arm assembly', material: 'GALVANIZED_STEEL', defaultQty: 3, unit: 'set' },
  { type: 'PEAK_MAST', name: 'Peak / earth-wire mast', material: 'GALVANIZED_STEEL', defaultQty: 1, unit: 'pcs' },
  { type: 'EARTH_WIRE_CLAMP', name: 'Earth-wire clamp & fitting', material: 'GALVANIZED_STEEL', defaultQty: 2, unit: 'set' },
  { type: 'FOUNDATION', name: 'Concrete foundation / footing', material: 'CONCRETE', defaultQty: 4, unit: 'pcs' },
  { type: 'ANCHOR_BOLT', name: 'Anchor / stub bolt set', material: 'GALVANIZED_STEEL', defaultQty: 4, unit: 'set' },
  { type: 'STEP_BOLT', name: 'Step bolt (climbing)', material: 'GALVANIZED_STEEL', defaultQty: 40, unit: 'pcs' },
  { type: 'ANTI_CLIMBING', name: 'Anti-climbing device', material: 'GALVANIZED_STEEL', defaultQty: 2, unit: 'set' },
  { type: 'BIRD_GUARD', name: 'Bird guard', material: 'POLYMER', defaultQty: 4, unit: 'pcs' },
  { type: 'ID_PLATE', name: 'Danger / identification plate', material: 'ALUMINUM', defaultQty: 1, unit: 'pcs' },
  { type: 'TOWER_GROUNDING', name: 'Tower earthing (lead + rod)', material: 'COPPER', defaultQty: 1, unit: 'set' },
];

module.exports = { COMPONENT_CATALOG };
