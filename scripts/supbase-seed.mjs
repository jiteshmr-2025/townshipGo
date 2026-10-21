import { createClient } from '@supabase/supabase-js';
import shapefile from 'shapefile';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// Haversine distance helper for edge lengths (in meters)
function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcLineLength(coords) {
    let len = 0;
    for (let i = 0; i < coords.length - 1; i++) {
        len += haversineMeters(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
    }
    return len;
}

function parseTags(rawTags) {
    if (!rawTags) return {};
    if (typeof rawTags === 'object') return rawTags;
    try {
        return JSON.parse(rawTags.replace(/'/g, '"'));
    } catch {
        return {};
    }
}

async function seed() {
    console.log('--- Starting Supabase Seed Process ---');

    // 1. Ingest Nodes
    console.log('1/2 Reading output_points.shp...');
    const pointSource = await shapefile.open('paths/output_points.shp');
    const nodeMap = new Map(); // coordinate string -> node ID
    const nodeRows = [];

    let pResult = await pointSource.read();
    while (!pResult.done) {
        const f = pResult.value;
        const osmId = parseInt(f.properties?.osm_id || Math.floor(Math.random() * 1e9), 10);
        const lng = f.geometry.coordinates[0];
        const lat = f.geometry.coordinates[1];

        const coordKey = `${lat.toFixed(6)},${lng.toFixed(6)}`;
        nodeMap.set(coordKey, osmId);

        nodeRows.push({ id: osmId, lat, lng });
        pResult = await pointSource.read();
    }

    console.log(`Inserting ${nodeRows.length} nodes into Supabase...`);
    for (let i = 0; i < nodeRows.length; i += 500) {
        const chunk = nodeRows.slice(i, i + 500);
        const { error } = await supabase.from('path_nodes').upsert(chunk);
        if (error) console.error('Error inserting nodes:', error.message);
    }

    // 2. Ingest Edges
    console.log('2/2 Reading output_lines.shp...');
    const lineSource = await shapefile.open('paths/output_lines.shp');
    const edgeRows = [];
    const missingNodes = []; // Added to batch fallback nodes

    let lResult = await lineSource.read();
    while (!lResult.done) {
        const f = lResult.value;
        const osmId = parseInt(f.properties?.osm_id || Math.floor(Math.random() * 1e9), 10);
        const coords = f.geometry.coordinates; // Array of [lng, lat]
        if (!coords || coords.length < 2) {
            lResult = await lineSource.read();
            continue;
        }

        const startCoord = `${coords[0][1].toFixed(6)},${coords[0][0].toFixed(6)}`;
        const endCoord = `${coords[coords.length - 1][1].toFixed(6)},${coords[coords.length - 1][0].toFixed(6)}`;

        // Match or create fallback start/end nodes
        let fromNode = nodeMap.get(startCoord);
        let toNode = nodeMap.get(endCoord);

        if (!fromNode) {
            fromNode = Math.floor(Math.random() * 1e9);
            missingNodes.push({ id: fromNode, lat: coords[0][1], lng: coords[0][0] }); // Push to batch instead of awaiting insert
            nodeMap.set(startCoord, fromNode);
        }
        if (!toNode) {
            toNode = Math.floor(Math.random() * 1e9);
            missingNodes.push({ id: toNode, lat: coords[coords.length - 1][1], lng: coords[coords.length - 1][0] }); // Push to batch instead of awaiting insert
            nodeMap.set(endCoord, toNode);
        }

        const tags = parseTags(f.properties?.all_tags);
        const lengthM = calcLineLength(coords);
        const isCovered = tags.covered === 'yes' || tags.building === 'yes';

        edgeRows.push({
            id: osmId,
            from_node: fromNode,
            to_node: toNode,
            name: tags.name || null,
            geometry: JSON.stringify(coords),
            length_m: Math.round(lengthM * 100) / 100,
            kind: tags.highway || 'footway',
            has_steps: tags.highway === 'steps' || tags.step_count != null,
            slope_pct: tags.incline ? parseFloat(tags.incline) : null,
            surface_rating: tags.surface === 'paved' || tags.surface === 'paving_stones' ? 1 : 2,
            is_crossing: tags.highway === 'crossing' || tags.footway === 'crossing',
            crossing_type: tags.crossing || null,
            crossing_width_m: 7,
            ped_green_s: null,
            cycle_s: null,
            has_kerb_ramp: tags.kerb === 'flush' || tags.kerb === 'lowered',
            has_refuge: tags.crossing_refuge === 'yes',
            shade_morning: isCovered ? 1.0 : 0.3,
            shade_midday: isCovered ? 1.0 : 0.2,
            shade_afternoon: isCovered ? 1.0 : 0.3,
            shade_source: 'assumed',
            lit_ratio: tags.lit === 'yes' ? 1.0 : 0.3,
            lighting_source: 'assumed'
        });

        lResult = await lineSource.read();
    }

    // Insert missing nodes BEFORE edges
    if (missingNodes.length > 0) {
        console.log(`Inserting ${missingNodes.length} missing fallback nodes...`);
        for (let i = 0; i < missingNodes.length; i += 500) {
            const chunk = missingNodes.slice(i, i + 500);
            const { error } = await supabase.from('path_nodes').upsert(chunk);
            if (error) console.error('Error inserting missing nodes chunk:', error.message);
        }
    }

    console.log(`Inserting ${edgeRows.length} edges into Supabase...`);
    for (let i = 0; i < edgeRows.length; i += 300) {
        const chunk = edgeRows.slice(i, i + 300);
        const { error } = await supabase.from('path_edges').upsert(chunk);
        if (error) console.error('Error inserting edges chunk:', error.message);
    }

    console.log('--- Database Seed Completed Successfully ---');
}

seed().catch(console.error);