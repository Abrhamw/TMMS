export interface ReadinessBlocker {
  code: string;
  message: string;
  recommendation?: string;
}

export interface DispatchGate {
  ready?: boolean;
  blockers?: ReadinessBlocker[];
  warnings?: { code: string; message: string }[];
}

export interface ReadinessSummary {
  ready: boolean;
  missing: string[];
  recommendations: string[];
  blockers: ReadinessBlocker[];
  warnings: { code: string; message: string }[];
}

export function readinessSummary(gate?: DispatchGate | null): ReadinessSummary {
  const blockers = Array.isArray(gate?.blockers) ? gate!.blockers! : [];
  const warnings = Array.isArray(gate?.warnings) ? gate!.warnings! : [];
  const missing = blockers.map((b) => b.message).filter(Boolean);
  const recommendations = blockers.map((b) =>
    b.recommendation ? b.recommendation : `Resolve: ${b.message}.`,
  );
  return {
    ready: !gate || gate.ready !== false,
    missing,
    recommendations,
    blockers,
    warnings,
  };
}
