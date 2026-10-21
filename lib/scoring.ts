/**
 * Physical environmental metrics and CapEx ROI intervention scoring.
 */

/** Apparent ("feels like") temperature, Steadman fallback formula */
export function apparentTempC(tempC: number, rhPct: number, windMps = 1): number {
    const e = (rhPct / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
    return tempC + 0.33 * e - 0.7 * windMps - 4.0;
}

/** Minutes a walker spends in direct sun on a segment */
export function sunExposedMinutes(lengthM: number, speedMps: number, shade: number): number {
    const s = Math.max(0, Math.min(1, shade));
    return (lengthM / speedMps / 60) * (1 - s);
}

// ---------------------------------------------------------------------------
// Municipal Costing & Financial Benchmarks (JKR / DBKL Precinct Standards)
// ---------------------------------------------------------------------------
export const COST_BENCHMARKS = {
    RAMP_RETROFIT_FIXED: 3500,       // PWD ramp + tactile tiles
    OBSTACLE_CLEARANCE_FIXED: 2500,  // Clearing + localized path realignment
    LIGHT_FIXTURE_FIXED: 2000,       // LED luminaire / lamp head swap
    PAVEMENT_PER_METER: 120,         // RM 120/m repaving (Min RM 1,500)
    SHADE_PER_METER: 350,            // RM 350/m covered canopy (Min RM 5,000)
};

export type ExtendedHazardKind =
    | 'shade' | 'light' | 'crossing' | 'ramp'
    | 'blocked' | 'no_ramp' | 'light_out' | 'broken_surface' | 'no_shade';

/** Calculates estimated RM budget based on hazard kind and physical GIS edge length */
export function estimateDefectCost(kind: ExtendedHazardKind, edgeLengthM: number = 20): number {
    const len = Math.max(5, edgeLengthM);

    switch (kind) {
        case 'ramp':
        case 'no_ramp':
            return COST_BENCHMARKS.RAMP_RETROFIT_FIXED;

        case 'crossing':
        case 'blocked':
            return COST_BENCHMARKS.OBSTACLE_CLEARANCE_FIXED;

        case 'light':
        case 'light_out':
            return COST_BENCHMARKS.LIGHT_FIXTURE_FIXED;

        case 'broken_surface':
            return Math.max(1500, Math.round(len * COST_BENCHMARKS.PAVEMENT_PER_METER));

        case 'shade':
        case 'no_shade':
            return Math.max(5000, Math.round(len * COST_BENCHMARKS.SHADE_PER_METER));

        default:
            return 2000;
    }
}

// ---------------------------------------------------------------------------
// Intervention ranking for the management dashboard
// ---------------------------------------------------------------------------
export type InterventionKind = 'shade' | 'light' | 'crossing' | 'ramp';

export interface Intervention {
    id: string;
    label: string;
    kind: InterventionKind;
    cost_rm: number;
    users_low: number;
    users_high: number;
    trips_per_week: number;
    severity: 'blocker' | 'comfort';
    exposure_per_trip: number;
}

export const EXPOSURE_UNIT: Record<InterventionKind, string> = {
    shade: 'sun-minutes avoided per trip',
    light: 'dark metres lit per trip',
    crossing: 'seconds of green-time shortfall closed per trip',
    ramp: 'trips unlocked per trip (1 = route becomes usable)',
};

export interface RankedIntervention extends Intervention {
    rank: number;
    score_low: number;
    score_mid: number;
    score_high: number;
    annual_exposure_removed: number;
    overlaps_next: boolean;
}

export function rankInterventions(items: Intervention[]): RankedIntervention[] {
    const scored = items.map((i) => {
        if (!(i.cost_rm > 0)) throw new Error(`Intervention "${i.id}" needs a cost above zero`);
        if (i.users_high < i.users_low) throw new Error(`Intervention "${i.id}": users_high is below users_low`);
        const per = (users: number) => ((users * i.trips_per_week) / i.cost_rm) * 1000;
        const mid = (i.users_low + i.users_high) / 2;
        return {
            ...i,
            rank: 0,
            score_low: per(i.users_low),
            score_mid: per(mid),
            score_high: per(i.users_high),
            annual_exposure_removed: mid * i.trips_per_week * 52 * i.exposure_per_trip,
            overlaps_next: false,
        };
    });

    scored.sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === 'blocker' ? -1 : 1;
        return b.score_mid - a.score_mid;
    });

    scored.forEach((s, idx) => {
        s.rank = idx + 1;
        const next = scored[idx + 1];
        if (next && next.severity === s.severity) s.overlaps_next = s.score_low <= next.score_high;
    });
    return scored;
}