import { GraphNode, GraphEdge, RoutingOptions, RouteResult, UserProfile } from './types';

// Speed Matrix in meters per second
const PROFILE_SPEEDS: Record<UserProfile, number> = {
    standard: 1.25,  // 75 m/min
    senior: 0.65,    // 39 m/min (Senior / Elderly pace)
    wheelchair: 0.80 // 48 m/min (PWD / Manual wheelchair)
};

export class PedestrianRouter {
    private nodes: Map<string, GraphNode> = new Map();
    private adjacencyList: Map<string, GraphEdge[]> = new Map();

    constructor(nodes: GraphNode[], edges: GraphEdge[]) {
        nodes.forEach((n) => {
            this.nodes.set(n.id, n);
            this.adjacencyList.set(n.id, []);
        });

        edges.forEach((edge) => {
            // Add bidirectional connections for pedestrian walkways
            this.adjacencyList.get(edge.source)?.push(edge);

            // Reverse direction edge copy
            const reversedEdge: GraphEdge = {
                ...edge,
                source: edge.target,
                target: edge.source,
                coordinates: [...edge.coordinates].reverse(),
            };
            this.adjacencyList.get(edge.target)?.push(reversedEdge);
        });
    }

    /**
     * Calculates the profile and objective-aware edge cost (in effective penalty seconds)
     */
    private calculateEdgeCost(edge: GraphEdge, options: RoutingOptions): { cost: number; isTraversable: boolean; reason?: string } {
        const speed = PROFILE_SPEEDS[options.profile];
        const baseTimeSec = edge.length_m / speed;

        // --- MS 1184 Accessibility Hard Constraints ---
        if (options.profile === 'wheelchair') {
            if (edge.has_steps && !edge.has_ramp) {
                return { cost: Infinity, isTraversable: false, reason: 'Unassisted steps present without ramp' };
            }
            if (edge.max_slope_pct > 8.3) { // MS 1184 max ramp incline limit
                return { cost: Infinity, isTraversable: false, reason: `Slope (${edge.max_slope_pct}%) exceeds MS 1184 limit (8.3%)` };
            }
        }

        let penaltyMultiplier = 0;

        // --- Crossing Delay & Safety Penalty ---
        let crossingDelay = 0;
        if (edge.crossing_type === 'uncontrolled') crossingDelay = 15;
        if (edge.crossing_type === 'signalized') crossingDelay = 25;

        if (options.mode === 'coolest') {
            // Heat Penalty: Base time scaled by unshaded fraction (1 - shade)
            const heatWeight = options.profile === 'senior' ? 3.0 : 2.0;
            penaltyMultiplier += (1 - edge.shade_factor) * heatWeight;
        } else if (options.mode === 'safest') {
            // Dark / Lighting Penalty: Base time scaled by unlit fraction (1 - lit)
            const darkWeight = 2.5;
            penaltyMultiplier += (1 - edge.lit_ratio) * darkWeight;

            // Penalty for dangerous dark stretches
            if (edge.max_dark_gap_m > 30) {
                penaltyMultiplier += (edge.max_dark_gap_m / 10);
            }
        }

        const totalCost = baseTimeSec * (1 + penaltyMultiplier) + crossingDelay;
        return { cost: totalCost, isTraversable: true };
    }

    /**
     * Runs Dijkstra's shortest path algorithm
     */
    public findRoute(startNodeId: string, endNodeId: string, options: RoutingOptions): RouteResult | null {
        if (!this.nodes.has(startNodeId) || !this.nodes.has(endNodeId)) {
            return null;
        }

        const distances: Map<string, number> = new Map();
        const previousNode: Map<string, string | null> = new Map();
        const previousEdge: Map<string, GraphEdge | null> = new Map();
        const unvisited: Set<string> = new Set();

        this.nodes.forEach((_, id) => {
            distances.set(id, Infinity);
            previousNode.set(id, null);
            previousEdge.set(id, null);
            unvisited.add(id);
        });

        distances.set(startNodeId, 0);

        while (unvisited.size > 0) {
            // Find node with minimum distance
            let currentNodeId: string | null = null;
            let minDistance = Infinity;

            unvisited.forEach((nodeId) => {
                const dist = distances.get(nodeId)!;
                if (dist < minDistance) {
                    minDistance = dist;
                    currentNodeId = nodeId;
                }
            });

            if (currentNodeId === null || minDistance === Infinity) break;
            if (currentNodeId === endNodeId) break; // Destination reached

            unvisited.delete(currentNodeId);

            const neighbors = this.adjacencyList.get(currentNodeId) || [];
            for (const edge of neighbors) {
                if (!unvisited.has(edge.target)) continue;

                const { cost, isTraversable } = this.calculateEdgeCost(edge, options);
                if (!isTraversable) continue;

                const newDist = distances.get(currentNodeId)! + cost;
                if (newDist < distances.get(edge.target)!) {
                    distances.set(edge.target, newDist);
                    previousNode.set(edge.target, currentNodeId);
                    previousEdge.set(edge.target, edge);
                }
            }
        }

        // Reconstruct Route
        if (distances.get(endNodeId) === Infinity) {
            return null; // No accessible route exists
        }

        const pathEdges: GraphEdge[] = [];
        const pathNodeIds: string[] = [];
        let curr: string | null = endNodeId;

        while (curr !== null) {
            pathNodeIds.unshift(curr);
            const edge = previousEdge.get(curr);
            if (edge) pathEdges.unshift(edge);
            curr = previousNode.get(curr) ?? null;
        }

        // Calculate defensible route metrics
        const speed = PROFILE_SPEEDS[options.profile];
        let totalLengthMeters = 0;
        let sunExposedMinutes = 0;
        let litDistanceMeters = 0;
        let maxDarkGapMeters = 0;
        let confidenceSum = 0;
        const coordinates: [number, number][] = [];
        const accessibilityIssues: string[] = [];

        pathEdges.forEach((edge) => {
            totalLengthMeters += edge.length_m;

            const edgeTimeMin = (edge.length_m / speed) / 60;
            sunExposedMinutes += edgeTimeMin * (1 - edge.shade_factor);

            litDistanceMeters += edge.length_m * edge.lit_ratio;
            maxDarkGapMeters = Math.max(maxDarkGapMeters, edge.max_dark_gap_m);
            confidenceSum += edge.confidence_score;

            if (edge.has_steps && !edge.has_ramp) accessibilityIssues.push(`Steps at ${edge.id}`);
            if (edge.max_slope_pct > 8.3) accessibilityIssues.push(`Steep slope (${edge.max_slope_pct}%) at ${edge.id}`);

            edge.coordinates.forEach((coord) => coordinates.push(coord));
        });

        const totalTimeSeconds = Math.round(totalLengthMeters / speed);
        const averageConfidence = pathEdges.length > 0 ? Number((confidenceSum / pathEdges.length).toFixed(2)) : 1.0;

        return {
            edgeIds: pathEdges.map((e) => e.id),
            nodeIds: pathNodeIds,
            coordinates,
            totalLengthMeters: Math.round(totalLengthMeters),
            totalTimeSeconds,
            sunExposedMinutes: Number(sunExposedMinutes.toFixed(1)),
            litDistanceMeters: Math.round(litDistanceMeters),
            maxDarkGapMeters: Math.round(maxDarkGapMeters),
            isAccessible: accessibilityIssues.length === 0,
            accessibilityIssues,
            averageConfidence,
            primaryDataSource: pathEdges[0]?.data_source || 'audited',
        };
    }
}