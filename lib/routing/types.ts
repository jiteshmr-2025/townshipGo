export type UserProfile = 'standard' | 'senior' | 'wheelchair';

export type DataSource = 'audited' | 'remote_sensed' | 'modelled' | 'reported';

export interface GraphNode {
    id: string;
    lat: number;
    lng: number;
    name?: string;
}

export interface GraphEdge {
    id: string;
    source: string;
    target: string;
    length_m: number;
    shade_factor: number;      // 0.0 (no canopy/roof) to 1.0 (full shade)
    lit_ratio: number;         // 0.0 (dark) to 1.0 (100% lit within 25m of active lamp)
    max_dark_gap_m: number;    // Longest unlit stretch on edge
    has_steps: boolean;
    has_ramp: boolean;
    max_slope_pct: number;     // e.g., 5.0 for 5% incline
    crossing_type: 'none' | 'zebra' | 'signalized' | 'uncontrolled';
    coordinates: [number, number][]; // [[lat, lng], [lat, lng], ...]
    data_source: DataSource;
    confidence_score: number;  // 0.0 to 1.0
    last_verified: string;     // YYYY-MM-DD
}

export interface RoutingOptions {
    profile: UserProfile;
    mode: 'direct' | 'coolest' | 'safest';
    isNightTime?: boolean;
}

export interface RouteResult {
    edgeIds: string[];
    nodeIds: string[];
    coordinates: [number, number][];
    totalLengthMeters: number;
    totalTimeSeconds: number;
    sunExposedMinutes: number;
    litDistanceMeters: number;
    maxDarkGapMeters: number;
    isAccessible: boolean;
    accessibilityIssues: string[];
    averageConfidence: number;
    primaryDataSource: DataSource;
}