export function readinessSummary(gate) {
  const blockers = (gate && Array.isArray(gate.blockers)) ? gate.blockers : [];
  const warnings = (gate && Array.isArray(gate.warnings)) ? gate.warnings : [];
  const missing = blockers.map((b) => b.message).filter(Boolean);
  const recommendations = blockers.map((b) => (
    b.recommendation ? b.recommendation : `Resolve: ${b.message}.`
  ));
  return {
    ready: !gate || gate.ready !== false,
    missing,
    recommendations,
    blockers,
    warnings,
  };
}
