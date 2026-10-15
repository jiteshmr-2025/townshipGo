export interface RouteProperties {
    id: string;
    name: string;
    route_type: 'direct' | 'coolest' | 'night_safe';
    shade_factor: number; // 0.0 to 1.0
    is_lit: boolean;
    surface_temp_base_c: number;
    senior_footfall_daily: number;
    length_meters: number;
    defects: string[];
}

export interface DefectReport {
    id?: string;
    latitude: number;
    longitude: number;
    category: 'extreme_heat' | 'broken_light' | 'uneven_pavement' | 'no_bench';
    description?: string;
    reported_by_proxy: boolean;
    status: 'pending' | 'approved' | 'resolved';
    created_at?: string;
}

export interface CapExIntervention {
    id: string;
    segment_id: string;
    location_name: string;
    intervention_type: 'tree_planting' | 'solar_light' | 'composite_bench';
    estimated_cost_rm: number;
    senior_footfall_daily: number;
    heat_risk_score: number;
    priority_score: number;
    status: 'proposed' | 'funded' | 'completed';
}