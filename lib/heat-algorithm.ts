// 1. Calculate Heat Risk Index (HRI) from 1 to 10
export function calculateHeatRiskIndex(
    airTempC: number,
    surfaceTempC: number,
    shadeFactor: number
): number {
    const airTerm = (airTempC / 35) * 0.3;
    const shadeTerm = (1 - shadeFactor) * 0.5;
    const surfaceTerm = Math.max(0, (surfaceTempC - airTempC) / 15) * 0.2;

    const rawScore = (airTerm + shadeTerm + surfaceTerm) * 10;
    return Math.min(10, Math.max(1, parseFloat(rawScore.toFixed(1))));
}

// 2. Calculate CapEx Priority Score for Management Dashboard
export function calculateCapExPriorityScore(
    seniorFootfall: number,
    heatRiskScore: number,
    safetyRiskScore: number,
    costRM: number
): number {
    if (costRM <= 0) return 0;
    const esgMultiplier = 1.2;
    const rawPriority = ((seniorFootfall * (heatRiskScore + safetyRiskScore)) / costRM) * esgMultiplier;

    return parseFloat(Math.min(10, rawPriority * 10).toFixed(1));
}