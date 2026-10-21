/**
 * AksesMy routing engine.
 *
 * Replaces hand-drawn route_segments with real shortest-path search over a pedestrian graph.
 * One engine, three weight sets (direct / coolest / safest), four user profiles.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type DataSource = 'audited' | 'reported' | 'modelled' | 'assumed';
export type Profile = 'senior' | 'cane_walker' | 'wheelchair';
export type TimeSlot = 'morning' | 'midday' | 'afternoon' | 'night';
export type Mode = 'direct' | 'coolest' | 'safest';
export type HazardKind = 'blocked' | 'no_ramp' | 'light_out' | 'no_shade' | 'broken_surface';
export type HazardStatus = 'open' | 'verified' | 'fixed';

export interface PathNode {
    id: number;
    lat: number;
    lng: number;
}

export interface PathEdge {
    id: number;
    from_node: number;
    to_node: number;
    name?: string | null;
    geometry: [number, number][]; // [lng, lat]
    length_m: number;
    kind: 'footway' | 'path' | 'pedestrian' | 'steps' | 'street' | 'crossing' | 'service';
    has_steps: boolean;
    slope_pct: number | null;
    surface_rating: number | null; // 1 smooth, 2 uneven, 3 broken
    is_crossing: boolean;
    crossing_type: 'signalised' | 'zebra' | 'uncontrolled' | null;
    crossing_width_m: number | null;
    ped_green_s: number | null;
    cycle_s: number | null;
    has_kerb_ramp: boolean | null;
    has_refuge?: boolean | null;
    shade_morning: number | null;
    shade_midday: number | null;
    shade_afternoon: number | null;
    shade_source: DataSource | null;
    lit_ratio: number | null;
    lighting_source: DataSource | null;
}

export interface HazardReport {
    id: number;
    edge_id: number | null;
    kind: HazardKind;
    status: HazardStatus;
}

export interface Graph {
    nodes: Map<number, PathNode>;
    edges: Map<number, PathEdge>;
    adj: Map<number, Array<{ edge: PathEdge; to: number }>>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
export interface ProfileConfig {
    label: string;
    speed_mps: number;
    step_penalty_s: number;
    hard_steps: boolean;
    hard_slope: boolean;
    hard_rough: boolean;
    needs_kerb_ramp: boolean;
}

export const PROFILES: Record<Profile, ProfileConfig> = {
    senior: { label: 'Senior', speed_mps: 0.8, step_penalty_s: 90, hard_steps: false, hard_slope: false, hard_rough: false, needs_kerb_ramp: false },
    cane_walker: { label: 'Cane / walker', speed_mps: 0.6, step_penalty_s: 150, hard_steps: false, hard_slope: false, hard_rough: false, needs_kerb_ramp: false },
    wheelchair: { label: 'Wheelchair', speed_mps: 0.7, step_penalty_s: 0, hard_steps: true, hard_slope: true, hard_rough: true, needs_kerb_ramp: true },
};

export const ASSUMPTIONS = {
    max_ramp_slope_pct: 8.33,
    default_shade: 0.3,
    default_lit: 0.3,
    default_crossing_width_m: 7,
    slope_free_pct: 3,
    slope_time_gain_per_pct: 0.05,
    rough_time_factor: 1.3,
    street_factor: { direct: 1.0, coolest: 1.2, safest: 1.8 } as Record<Mode, number>,
    unsignalised_wait_s: 10,
    unknown_signal_wait_s: 30,
    wide_unsignalised_m: 10,
    wide_unsignalised_penalty_s: 45,
    unverified_ramp_penalty_s: 60,
    open_report_penalty_s: 600,
    hard_block_penalty_s: 5000,
};

export const MODE_WEIGHTS: Record<Mode, { heat: number; dark: number; risk: number }> = {
    direct: { heat: 0, dark: 0, risk: 1 },
    coolest: { heat: 6.0, dark: 1.0, risk: 2 },
    safest: { heat: 1.0, dark: 12.0, risk: 30 },
};

// ---------------------------------------------------------------------------
// Time slots
// ---------------------------------------------------------------------------
export function slotForHour(hour: number): TimeSlot {
    if (hour >= 19 || hour < 7) return 'night';
    if (hour < 10) return 'morning';
    if (hour < 15) return 'midday';
    return 'afternoon';
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------
export function buildGraph(nodes: PathNode[], edges: PathEdge[]): Graph {
    const nm = new Map<number, PathNode>();
    for (const rawN of nodes) {
        const id = Number(rawN.id);
        if (!isNaN(id)) {
            nm.set(id, { ...rawN, id, lat: Number(rawN.lat), lng: Number(rawN.lng) });
        }
    }

    const em = new Map<number, PathEdge>();
    const adj = new Map<number, Array<{ edge: PathEdge; to: number }>>();

    const link = (from: number, edge: PathEdge, to: number) => {
        const list = adj.get(from);
        if (list) list.push({ edge, to });
        else adj.set(from, [{ edge, to }]);
    };

    for (const rawE of edges) {
        const id = Number(rawE.id);
        const from_node = Number(rawE.from_node);
        const to_node = Number(rawE.to_node);
        let length_m = Number(rawE.length_m);

        if (isNaN(length_m) || length_m <= 0) {
            length_m = 10; // Fallback estimate for uncalculated segments
        }

        if (!nm.has(from_node) || !nm.has(to_node)) continue;

        const cleanEdge: PathEdge = {
            ...rawE,
            id,
            from_node,
            to_node,
            length_m,
        };

        em.set(id, cleanEdge);
        link(from_node, cleanEdge, to_node);
        if (to_node !== from_node) link(to_node, cleanEdge, from_node);
    }

    return { nodes: nm, edges: em, adj };
}

function localMetres(lat: number) {
    return { kx: 111320 * Math.cos((lat * Math.PI) / 180), ky: 110574 };
}

/** Traverses reachable network to evaluate graph component size (filters isolated islands). */
function getComponentSize(graph: Graph, startNodeId: number, maxCount = 50): number {
    const visited = new Set<number>([startNodeId]);
    const queue: number[] = [startNodeId];
    while (queue.length > 0 && visited.size < maxCount) {
        const curr = queue.shift()!;
        for (const neighbor of graph.adj.get(curr) ?? []) {
            if (!visited.has(neighbor.to)) {
                visited.add(neighbor.to);
                queue.push(neighbor.to);
            }
        }
    }
    return visited.size;
}

/** Returns nearest graph nodes prioritized by network component size to avoid isolated graph islands. */
export function snapToNodes(
    graph: Graph,
    lat: number,
    lng: number,
    limit = 5
): Array<{ node_id: number; distance_m: number; component_size: number }> {
    if (!graph || !graph.nodes || typeof lat !== 'number' || typeof lng !== 'number') {
        return [];
    }
    const { kx, ky } = localMetres(lat);
    const candidates: Array<{ node_id: number; distance_m: number; component_size: number }> = [];

    for (const n of graph.nodes.values()) {
        const nid = Number(n.id);
        if (!graph.adj.has(nid)) continue;
        const d = Math.hypot((n.lng - lng) * kx, (n.lat - lat) * ky);

        if (d < 1000) {
            const size = getComponentSize(graph, nid, 50);
            candidates.push({ node_id: nid, distance_m: d, component_size: size });
        }
    }

    // Prioritize nodes connected to the main network (component_size >= 10), then by physical proximity
    return candidates
        .sort((a, b) => {
            const aIsMain = a.component_size >= 10;
            const bIsMain = b.component_size >= 10;
            if (aIsMain !== bIsMain) return aIsMain ? -1 : 1;
            return a.distance_m - b.distance_m;
        })
        .slice(0, limit);
}

/** Backward-compatible single-node snapping. */
export function snapToNode(
    graph: Graph,
    lat: number,
    lng: number
): { node_id: number; distance_m: number } | null {
    const nodes = snapToNodes(graph, lat, lng, 1);
    return nodes.length > 0 ? { node_id: nodes[0].node_id, distance_m: nodes[0].distance_m } : null;
}

function distPointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function nearestEdge(graph: Graph, lat: number, lng: number): { edge_id: number; distance_m: number } | null {
    const { kx, ky } = localMetres(lat);
    let best: { edge_id: number; distance_m: number } | null = null;
    for (const e of graph.edges.values()) {
        if (!e.geometry || !Array.isArray(e.geometry) || e.geometry.length < 2) continue;
        for (let i = 0; i + 1 < e.geometry.length; i++) {
            const [lng1, lat1] = e.geometry[i];
            const [lng2, lat2] = e.geometry[i + 1];
            const d = distPointToSegment(
                (lng - lng1) * kx, (lat - lat1) * ky,
                0, 0,
                (lng2 - lng1) * kx, (lat2 - lat1) * ky,
            );
            if (!best || d < best.distance_m) best = { edge_id: Number(e.id), distance_m: d };
        }
    }
    return best;
}

export function indexHazards(reports: HazardReport[]): Map<number, HazardReport[]> {
    const m = new Map<number, HazardReport[]>();
    for (const r of reports) {
        if (r.status === 'fixed' || r.edge_id == null) continue;
        const edgeId = Number(r.edge_id);
        const list = m.get(edgeId);
        if (list) list.push(r);
        else m.set(edgeId, [r]);
    }
    return m;
}

// ---------------------------------------------------------------------------
// Edge cost
// ---------------------------------------------------------------------------
export interface CostContext {
    profile: Profile;
    mode: Mode;
    slot: TimeSlot;
    hazards: Map<number, HazardReport[]>;
    strictUnknown?: boolean;
}

export interface EdgeEval {
    cost: number;
    walk_s: number;
    wait_s: number;
    hard: string[];
    notes: string[];
    shade: number;
    shade_src: DataSource;
    lit: number;
    lit_src: DataSource;
    sun_s: number;
    dark_m: number;
    shortfall: { need_s: number; given_s: number; short_s: number } | null;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function shadeFor(e: PathEdge, slot: TimeSlot): { v: number; src: DataSource } {
    const raw =
        slot === 'morning' ? e.shade_morning :
            slot === 'midday' ? e.shade_midday :
                slot === 'afternoon' ? e.shade_afternoon : null;
    if (raw == null) return { v: ASSUMPTIONS.default_shade, src: 'assumed' };
    return { v: clamp01(Number(raw)), src: e.shade_source ?? 'assumed' };
}

function litFor(e: PathEdge): { v: number; src: DataSource } {
    if (e.lit_ratio == null) return { v: ASSUMPTIONS.default_lit, src: 'assumed' };
    return { v: clamp01(Number(e.lit_ratio)), src: e.lighting_source ?? 'assumed' };
}

export function evaluateEdge(e: PathEdge, ctx: CostContext): EdgeEval {
    const p = PROFILES[ctx.profile];
    const w = MODE_WEIGHTS[ctx.mode];
    const A = ASSUMPTIONS;
    const hard: string[] = [];
    const notes: string[] = [];
    let penalty = 0;
    let timeFactor = 1;

    const slope_pct = e.slope_pct != null ? Number(e.slope_pct) : null;
    const surface_rating = e.surface_rating != null ? Number(e.surface_rating) : null;
    const length_m = Number(e.length_m) > 0 ? Number(e.length_m) : 10;

    const has_steps = e.has_steps === true || String(e.has_steps) === 'true';
    const is_crossing = e.is_crossing === true || String(e.is_crossing) === 'true';
    const has_kerb_ramp = e.has_kerb_ramp == null ? null : (e.has_kerb_ramp === true || String(e.has_kerb_ramp) === 'true');

    // --- terrain ---
    if (slope_pct != null && !isNaN(slope_pct)) {
        if (slope_pct > A.slope_free_pct) timeFactor += A.slope_time_gain_per_pct * (slope_pct - A.slope_free_pct);
        if (p.hard_slope && slope_pct > A.max_ramp_slope_pct) hard.push(`Slope ${slope_pct.toFixed(1)}% is above the wheelchair limit`);
    }
    if (surface_rating === 3) {
        if (p.hard_rough) hard.push('Broken surface');
        else { timeFactor *= A.rough_time_factor; notes.push('Broken surface'); }
    }
    if (e.kind === 'street') timeFactor *= A.street_factor[ctx.mode];

    if (has_steps) {
        if (p.hard_steps) hard.push('Steps');
        else { penalty += p.step_penalty_s; notes.push('Steps'); }
    }

    // --- crossings ---
    let wait_s = 0;
    let shortfall: EdgeEval['shortfall'] = null;
    if (is_crossing) {
        const width = e.crossing_width_m != null ? Number(e.crossing_width_m) : A.default_crossing_width_m;
        const need = width / p.speed_mps;
        if (e.crossing_type === 'signalised') {
            if (e.ped_green_s != null) {
                const pedGreen = Number(e.ped_green_s);
                const cycleS = e.cycle_s != null ? Number(e.cycle_s) : null;
                const short = Math.max(0, need - pedGreen);
                if (cycleS != null && cycleS > 0) {
                    const red = Math.max(0, cycleS - pedGreen);
                    wait_s = (red * red) / (2 * cycleS);
                } else wait_s = A.unknown_signal_wait_s;
                if (short > 0) {
                    shortfall = { need_s: need, given_s: pedGreen, short_s: short };
                    penalty += short * w.risk;
                    notes.push(`Green phase ${Math.round(short)}s too short for this walking pace`);
                }
            } else {
                wait_s = A.unknown_signal_wait_s;
                notes.push('Signal timing not measured');
            }
        } else {
            wait_s = A.unsignalised_wait_s;
            if (width >= A.wide_unsignalised_m) {
                penalty += A.wide_unsignalised_penalty_s;
                notes.push('Wide crossing without a signal');
            }
        }
        if (has_kerb_ramp === false) {
            if (p.needs_kerb_ramp) hard.push('No kerb ramp');
            else penalty += 30;
        } else if (has_kerb_ramp == null && p.needs_kerb_ramp) {
            if (ctx.strictUnknown) hard.push('Kerb ramp not verified');
            else { penalty += A.unverified_ramp_penalty_s; notes.push('Kerb ramp not verified'); }
        }
    }

    // --- live hazard reports ---
    let shadeCap: number | null = null;
    let litMult = 1;
    const edgeHazards = ctx.hazards.get(Number(e.id)) ?? [];
    for (const h of edgeHazards) {
        const verified = h.status === 'verified';
        switch (h.kind) {
            case 'blocked':
                if (verified) hard.push('Blocked (verified report)');
                else { penalty += A.open_report_penalty_s; notes.push('Reported blocked'); }
                break;
            case 'no_ramp':
                if (p.needs_kerb_ramp) {
                    if (verified) hard.push('No ramp (verified report)');
                    else { penalty += A.open_report_penalty_s; notes.push('Ramp reported missing'); }
                } else penalty += 30;
                break;
            case 'broken_surface':
                penalty += p.hard_rough ? A.open_report_penalty_s : 30;
                notes.push('Surface reported broken');
                break;
            case 'light_out':
                litMult = 0.5;
                notes.push('Light reported out');
                break;
            case 'no_shade':
                shadeCap = 0.1;
                break;
        }
    }

    // --- time, heat, darkness ---
    const walk_s = (length_m / p.speed_mps) * timeFactor;
    const sh = shadeFor(e, ctx.slot);
    const li = litFor(e);
    const shade = shadeCap != null ? Math.min(sh.v, shadeCap) : sh.v;
    const lit = li.v * litMult;
    const isNight = ctx.slot === 'night';
    const sun_s = isNight ? 0 : walk_s * (1 - shade);
    const dark_m = isNight ? length_m * (1 - lit) : 0;
    const heat = isNight ? 0 : sun_s * w.heat;
    const dark = isNight ? walk_s * (1 - lit) * w.dark : 0;

    return {
        cost: walk_s + wait_s + penalty + heat + dark,
        walk_s, wait_s, hard, notes,
        shade, shade_src: sh.src, lit, lit_src: li.src,
        sun_s, dark_m, shortfall,
    };
}

// ---------------------------------------------------------------------------
// Dijkstra
// ---------------------------------------------------------------------------
class MinHeap {
    private a: Array<[number, number]> = [];
    get size() { return this.a.length; }
    push(d: number, n: number) {
        const a = this.a;
        a.push([d, n]);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p][0] <= a[i][0]) break;
            [a[p], a[i]] = [a[i], a[p]];
            i = p;
        }
    }
    pop(): [number, number] | undefined {
        const a = this.a;
        if (!a.length) return undefined;
        const top = a[0];
        const last = a.pop()!;
        if (a.length) {
            a[0] = last;
            let i = 0;
            for (; ;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let m = i;
                if (l < a.length && a[l][0] < a[m][0]) m = l;
                if (r < a.length && a[r][0] < a[m][0]) m = r;
                if (m === i) break;
                [a[m], a[i]] = [a[i], a[m]];
                i = m;
            }
        }
        return top;
    }
}

export interface PathResult {
    nodes: number[];
    edges: PathEdge[];
}

export function shortestPath(graph: Graph, from: number, to: number, ctx: CostContext, relax = false): PathResult | null {
    const fromId = Number(from);
    const toId = Number(to);

    if (!graph.nodes.has(fromId) || !graph.nodes.has(toId)) return null;
    if (fromId === toId) return { nodes: [fromId], edges: [] };

    const evalCache = new Map<number, EdgeEval>();
    const evalOf = (e: PathEdge) => {
        const eid = Number(e.id);
        let v = evalCache.get(eid);
        if (!v) { v = evaluateEdge(e, ctx); evalCache.set(eid, v); }
        return v;
    };

    const dist = new Map<number, number>([[fromId, 0]]);
    const prev = new Map<number, { node: number; edge: PathEdge }>();
    const done = new Set<number>();
    const heap = new MinHeap();
    heap.push(0, fromId);

    while (heap.size) {
        const [d, u] = heap.pop()!;
        if (done.has(u)) continue;
        done.add(u);
        if (u === toId) break;
        for (const { edge, to: v } of graph.adj.get(u) ?? []) {
            const vId = Number(v);
            if (done.has(vId)) continue;
            const ev = evalOf(edge);
            let c = ev.cost;
            if (ev.hard.length) {
                if (!relax) continue;
                c += ASSUMPTIONS.hard_block_penalty_s * ev.hard.length;
            }
            const nd = d + c;
            if (nd < (dist.get(vId) ?? Infinity)) {
                dist.set(vId, nd);
                prev.set(vId, { node: u, edge });
                heap.push(nd, vId);
            }
        }
    }

    if (!prev.has(toId)) return null;
    const nodes: number[] = [toId];
    const edges: PathEdge[] = [];
    for (let cur = toId; cur !== fromId;) {
        const p = prev.get(cur)!;
        edges.push(p.edge);
        nodes.push(p.node);
        cur = p.node;
    }
    nodes.reverse();
    edges.reverse();
    return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Route summary
// ---------------------------------------------------------------------------
export interface RouteResult {
    mode: Mode;
    profile: Profile;
    slot: TimeSlot;
    node_ids: number[];
    edge_ids: number[];
    coordinates: [number, number][];
    length_m: number;
    walk_min: number;
    sun_exposed_min: number;
    dark_m: number;
    avg_shade: number;
    avg_lit: number;
    crossings: number;
    shortfall_crossings: Array<{ edge_id: number; name: string | null; need_s: number; given_s: number }>;
    warnings: string[];
    quality: Record<DataSource, number>;
    same_as?: Mode;
}

export function buildRoute(graph: Graph, path: PathResult, ctx: CostContext): RouteResult {
    let length = 0, walk = 0, sun = 0, dark = 0, shadeW = 0, litW = 0, crossings = 0;
    const quality: Record<DataSource, number> = { audited: 0, reported: 0, modelled: 0, assumed: 0 };
    const warnings = new Set<string>();
    const shortfall_crossings: RouteResult['shortfall_crossings'] = [];
    const coords: [number, number][] = [];

    const push = (lat: number, lng: number) => {
        const last = coords[coords.length - 1];
        if (!last || last[0] !== lat || last[1] !== lng) coords.push([lat, lng]);
    };
    const start = graph.nodes.get(Number(path.nodes[0]));
    if (start) push(start.lat, start.lng);

    path.edges.forEach((e, i) => {
        const ev = evaluateEdge(e, ctx);
        const eLength = Number(e.length_m) > 0 ? Number(e.length_m) : 10;
        length += eLength;
        walk += ev.walk_s + ev.wait_s;
        sun += ev.sun_s;
        dark += ev.dark_m;
        shadeW += ev.shade * eLength;
        litW += ev.lit * eLength;
        if (e.is_crossing === true || String(e.is_crossing) === 'true') crossings++;
        quality[ctx.slot === 'night' ? ev.lit_src : ev.shade_src] += eLength;
        ev.notes.forEach((n) => warnings.add(n));
        ev.hard.forEach((n) => warnings.add(`Barrier: ${n}`));
        if (ev.shortfall) shortfall_crossings.push({ edge_id: Number(e.id), name: e.name ?? null, need_s: ev.shortfall.need_s, given_s: ev.shortfall.given_s });

        const forward = Number(e.from_node) === Number(path.nodes[i]);
        const pts = forward ? e.geometry : [...e.geometry].reverse();
        pts.forEach(([lng, lat]) => push(lat, lng));
    });

    const total = length || 1;
    (Object.keys(quality) as DataSource[]).forEach((k) => { quality[k] = quality[k] / total; });

    return {
        mode: ctx.mode, profile: ctx.profile, slot: ctx.slot,
        node_ids: path.nodes, edge_ids: path.edges.map((e) => Number(e.id)),
        coordinates: coords,
        length_m: length,
        walk_min: walk / 60,
        sun_exposed_min: sun / 60,
        dark_m: dark,
        avg_shade: shadeW / total,
        avg_lit: litW / total,
        crossings,
        shortfall_crossings,
        warnings: [...warnings].slice(0, 6),
        quality,
    };
}

// ---------------------------------------------------------------------------
// Blockage diagnosis
// ---------------------------------------------------------------------------
export interface Blocker {
    edge_id: number;
    name: string | null;
    kind: PathEdge['kind'];
    length_m: number;
    reasons: string[];
}

export interface Diagnosis {
    connected: boolean;
    blockers: Blocker[];
}

export function diagnoseBlockage(graph: Graph, from: number, to: number, ctx: CostContext): Diagnosis {
    const relaxed = shortestPath(graph, from, to, ctx, true);
    if (!relaxed) return { connected: false, blockers: [] };
    const blockers: Blocker[] = [];
    for (const e of relaxed.edges) {
        const ev = evaluateEdge(e, ctx);
        if (ev.hard.length) blockers.push({ edge_id: Number(e.id), name: e.name ?? null, kind: e.kind, length_m: Number(e.length_m), reasons: ev.hard });
    }
    return { connected: true, blockers };
}

// ---------------------------------------------------------------------------
// Plan Routes API
// ---------------------------------------------------------------------------
export interface PlanResult {
    routes: Partial<Record<Mode, RouteResult>>;
    diagnosis: Diagnosis | null;
}

export function planRoutes(
    graph: Graph,
    fromInput: number | [number, number] | null | undefined,
    toInput: number | [number, number] | null | undefined,
    profile: Profile,
    slot: TimeSlot,
    hazards: HazardReport[],
    opts: { strictUnknown?: boolean } = {},
): PlanResult {
    if (!graph || graph.nodes.size === 0 || !fromInput || !toInput) {
        return { routes: {}, diagnosis: null };
    }

    let fromCandidates: Array<{ node_id: number; distance_m: number }> = [];
    let toCandidates: Array<{ node_id: number; distance_m: number }> = [];

    if (typeof fromInput === 'number') {
        fromCandidates = [{ node_id: fromInput, distance_m: 0 }];
    } else if (Array.isArray(fromInput) && fromInput.length >= 2) {
        fromCandidates = snapToNodes(graph, fromInput[0], fromInput[1], 5);
    }

    if (typeof toInput === 'number') {
        toCandidates = [{ node_id: toInput, distance_m: 0 }];
    } else if (Array.isArray(toInput) && toInput.length >= 2) {
        toCandidates = snapToNodes(graph, toInput[0], toInput[1], 5);
    }

    if (!fromCandidates.length || !toCandidates.length) {
        return { routes: {}, diagnosis: { connected: false, blockers: [] } };
    }

    const hz = indexHazards(hazards);

    // Search candidate pairs until a connected path across the main graph is found
    for (const from of fromCandidates) {
        for (const to of toCandidates) {
            const testCtx: CostContext = { profile, mode: 'direct', slot, hazards: hz, strictUnknown: opts.strictUnknown };
            const path = shortestPath(graph, from.node_id, to.node_id, testCtx);

            if (path) {
                const routes: Partial<Record<Mode, RouteResult>> = {};
                const seen = new Map<string, Mode>();

                for (const mode of ['direct', 'coolest', 'safest'] as Mode[]) {
                    const ctx: CostContext = { profile, mode, slot, hazards: hz, strictUnknown: opts.strictUnknown };
                    const mPath = shortestPath(graph, from.node_id, to.node_id, ctx) || path;
                    const r = buildRoute(graph, mPath, ctx);
                    const sig = r.edge_ids.join('-');
                    const earlier = seen.get(sig);
                    if (earlier) r.same_as = earlier;
                    else seen.set(sig, mode);
                    routes[mode] = r;
                }

                console.log(`Connected route found! Start Node: ${from.node_id}, End Node: ${to.node_id}`);
                return { routes, diagnosis: null };
            }
        }
    }

    const primaryFrom = fromCandidates[0].node_id;
    const primaryTo = toCandidates[0].node_id;
    const diagnosis = diagnoseBlockage(
        graph,
        primaryFrom,
        primaryTo,
        { profile, mode: 'direct', slot, hazards: hz, strictUnknown: opts.strictUnknown }
    );

    return { routes: {}, diagnosis };
}