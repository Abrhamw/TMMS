// Operational Technology (OT) department model.
//
// The OT department looks after the *electronic and indoor* systems of a
// substation — protection & control, metering, SCADA/RTU automation, telecom
// and DC/auxiliary supplies — plus the optical-fiber assets of the network
// (OPGW spans and joint boxes) that the transmission-line crews only host.
//
// This module is pure (no database access) so authority.js, the API and the UI
// all agree on one taxonomy. It is the single source of truth for:
//   * the OT sub-domains and their labels,
//   * which asset type belongs to which domain,
//   * which crew type maintains which domain,
//   * which org-unit type owns which domain.
//
// Domains are deliberately finer than departments so a child department can
// own one slice. The parent OT unit owns all of them; a child unit owns one.

// The four operating domains all OT assets fall into. DC & auxiliary has no
// child department of its own and stays directly under the OT department.
const OT_DOMAINS = ['OT_PROTECTION', 'OT_SCADA', 'OT_TELECOM', 'OT_DC'];

const DOMAIN_LABEL = {
  SUBSTATION: 'Substation (HV yard & switchgear)',
  LINE: 'Transmission line',
  OT_PROTECTION: 'Protection & Control',
  OT_SCADA: 'SCADA & Automation',
  OT_TELECOM: 'Telecom & Fiber',
  OT_DC: 'DC & Auxiliary',
};

// Asset type -> domain. Anything not listed falls back to the location of the
// asset (a line/tower asset is LINE, a substation asset is SUBSTATION), so the
// tower-part vocabulary never has to be enumerated here.
const ASSET_TYPE_DOMAIN = {
  // Protection & control
  PROTECTION_RELAY: 'OT_PROTECTION',
  RELAY_PANEL: 'OT_PROTECTION',
  METER: 'OT_PROTECTION',
  // SCADA / automation
  SUBSTATION_CONTROLLER: 'OT_SCADA',
  SCADA_RTU: 'OT_SCADA',
  RTU: 'OT_SCADA',
  IED: 'OT_SCADA',
  NETWORK_SWITCH: 'OT_SCADA',
  // Telecom & fiber
  COMMUNICATION_RADIO: 'OT_TELECOM',
  COMMUNICATION: 'OT_TELECOM',
  TELECOM: 'OT_TELECOM',
  OPTICAL_FIBER: 'OT_TELECOM',
  FIBER: 'OT_TELECOM',
  OPGW_SPAN: 'OT_TELECOM',
  OPGW_TERMINAL: 'OT_TELECOM',
  JOINT_BOX: 'OT_TELECOM',
  // DC & auxiliary
  BATTERY_BANK: 'OT_DC',
  BATTERY_CHARGER: 'OT_DC',
  DC_DISTRIBUTION_PANEL: 'OT_DC',
  AUXILIARY_TRANSFORMER: 'OT_DC',
  UPS: 'OT_DC',
  // Substation (non-OT) explicit entries keep the fallback unambiguous
  SWITCHGEAR: 'SUBSTATION',
  GIS: 'SUBSTATION',
  MV_CIRCUIT_BREAKER: 'SUBSTATION',
  MV_DISCONNECTOR: 'SUBSTATION',
  // Line
  CONDUCTOR_SPAN: 'LINE',
  TOWER: 'LINE',
  POLE: 'LINE',
};

// Crew type -> domain. A crew's type tells which domain it maintains, so a
// department's domains can be inferred from the crews under its command.
const DOMAIN_CREW_TYPES = {
  SUBSTATION: 'SUBSTATION',
  MAINTENANCE: 'SUBSTATION',
  LINE: 'LINE',
  INSPECTION: 'LINE',
  OPGW: 'OT_TELECOM',
  RELAY_AND_PROTECTION: 'OT_PROTECTION',
  PROTECTION_CONTROL: 'OT_PROTECTION',
  SCADA_RTU: 'OT_SCADA',
  SCADA_AUTOMATION: 'OT_SCADA',
  TELECOM: 'OT_TELECOM',
  TELECOM_FIBER: 'OT_TELECOM',
  DC_SYSTEMS: 'OT_DC',
};

// Org-unit type -> domains it owns, independent of the crews raised under it.
const UNIT_DOMAINS = {
  DEPARTMENT: [],
  SUBSTATION_UNIT: ['SUBSTATION'],
  SUBSTATION_MAINTENANCE: ['SUBSTATION'],
  TRANSMISSION_MAINTENANCE: ['LINE'],
  RELAY_SCADA_TELECOM: [...OT_DOMAINS],
  OPERATIONAL_TECHNOLOGY: [...OT_DOMAINS],
  OT_PROTECTION_CONTROL: ['OT_PROTECTION'],
  OT_SCADA_AUTOMATION: ['OT_SCADA'],
  OT_TELECOM_FIBER: ['OT_TELECOM'],
};

// Crew types that carry functional (cross-region) authority.
const FUNCTIONAL_CREW_TYPES = new Set([
  'RELAY_AND_PROTECTION', 'PROTECTION_CONTROL',
  'SCADA_RTU', 'SCADA_AUTOMATION',
  'TELECOM', 'TELECOM_FIBER', 'OPGW',
  'DC_SYSTEMS',
]);

// All OT org-unit types. Only a *root* OT unit (one whose parent is not itself
// an OT unit) keeps cross-region functional authority; a child department under
// it is scoped to its own unit subtree and domain.
const OT_UNIT_TYPES = new Set([
  'RELAY_SCADA_TELECOM', 'OPERATIONAL_TECHNOLOGY',
  'OT_PROTECTION_CONTROL', 'OT_SCADA_AUTOMATION', 'OT_TELECOM_FIBER',
]);

function isOtDomain(domain) {
  return OT_DOMAINS.includes(domain);
}

function domainLabel(domain) {
  return DOMAIN_LABEL[domain] || domain;
}

module.exports = {
  OT_DOMAINS,
  DOMAIN_LABEL,
  ASSET_TYPE_DOMAIN,
  DOMAIN_CREW_TYPES,
  UNIT_DOMAINS,
  FUNCTIONAL_CREW_TYPES,
  OT_UNIT_TYPES,
  isOtDomain,
  domainLabel,
};
