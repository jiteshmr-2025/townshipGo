#!/usr/bin/env node
/**
 * Overpass JSON ("out geom") -> pedestrian graph.
 *
 *   node scripts/osm-to-graph.mjs --in precinct.json \
 *        --out-json graph.json --out-sql graph.sql --out-audit-csv edges_for_audit.csv [--no-streets]
 *
 * What it does:
 *  - drops motorways, trunk, primary, secondary and tertiary roads, so routes can never run along a highway
 *    (a pedestrian only meets a major road at a mapped crossing, which arrives as its own footway=crossing way)
 *  - splits every way at junctions, so edges run junction to junction
 *  - copies the few useful OSM tags (steps, crossing type, kerb, incline, lit, covered)
 *  - marks every OSM-derived hint as "modelled" so a field audit can overwrite it
 *  - writes an audit list: edge id, name, length, midpoint, Google Maps link
 *
 * Edge ids are sequential per run. Run once per precinct, import once, and do not re-import after audits begin.
 */
import fs from 'node:fs';

// ---------------------------------------------------------------- args
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const inFile = get('--in');
const outJson = get('--out-json');
const outSql = get('--out-sql');
const outAudit = get('--out-audit-csv');
const includeStreets = !args.includes('--no-streets');
if (!inFile) {
  console.error('Usage: node scripts/osm-to-graph.mjs --in overpass.json [--out-json f] [--out-sql f] [--out-audit-csv f] [--no-streets]');
  process.exit(1);
}

const EXCLUDED_ROADS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
]);
const STREETS = new Set(['residential', 'living_street', 'unclassified']);
const WALKWAYS = new Set(['footway', 'path', 'pedestrian', 'steps', 'service', 'track', 'cycleway']);

// ---------------------------------------------------------------- helpers
const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function parseIncline(v) {
  if (!v) return null;
  const pct = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(v);
  if (pct) return Math.abs(Number(pct[1]));
  const deg = /^(-?\d+(?:\.\d+)?)\s*°$/.exec(v);
  if (deg) return Math.abs(Math.tan(rad(Number(deg[1]))) * 100);
  return null;
}
const sqlStr = (s) => (s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`);
const sqlNum = (n) => (n == null ? 'null' : String(n));
const sqlBool = (b) => (b == null ? 'null' : b ? 'true' : 'false');

// ---------------------------------------------------------------- load + filter
const raw = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const ways = (raw.elements || []).filter((el) => {
  if (el.type !== 'way' || !el.nodes || !el.geometry || el.nodes.length !== el.geometry.length) return false;
  const hw = el.tags?.highway;
  if (!hw || EXCLUDED_ROADS.has(hw)) return false;
  if (el.tags.foot === 'no' || el.tags.access === 'private' || el.tags.access === 'no') return false;
  if (STREETS.has(hw)) return includeStreets;
  return WALKWAYS.has(hw);
});

// ---------------------------------------------------------------- break nodes
const usage = new Map();
for (const w of ways) for (const id of w.nodes) usage.set(id, (usage.get(id) || 0) + 1);
const isBreak = (w, i) => i === 0 || i === w.nodes.length - 1 || usage.get(w.nodes[i]) > 1;

// ---------------------------------------------------------------- split into edges
const nodes = new Map();
const edges = [];

function tagsToAttrs(t) {
  const hw = t.highway;
  const isCrossing = t.footway === 'crossing' || t.highway === 'crossing' || t.crossing != null;
  const isSteps = hw === 'steps';
  let crossingType = null;
  if (isCrossing) {
    if (t.crossing === 'traffic_signals' || t['crossing:signals'] === 'yes') crossingType = 'signalised';
    else if (t.crossing === 'zebra' || t.crossing === 'marked') crossingType = 'zebra';
    else crossingType = 'uncontrolled';
  }
  const kind = isCrossing ? 'crossing' : isSteps ? 'steps' : STREETS.has(hw) ? 'street'
    : ['footway', 'path', 'pedestrian', 'service'].includes(hw) ? hw : 'path';
  let kerb = null;
  if (t.kerb === 'lowered' || t.kerb === 'flush') kerb = true;
  else if (t.kerb === 'raised') kerb = false;

  const attrs = {
    kind, surface: t.surface ?? null,
    has_steps: isSteps, slope_pct: parseIncline(t.incline),
    is_crossing: isCrossing, crossing_type: crossingType,
    has_kerb_ramp: isCrossing ? kerb : null,
    has_tactile: t.tactile_paving ? t.tactile_paving === 'yes' : null,
    shade_morning: null, shade_midday: null, shade_afternoon: null, shade_source: null,
    lit_ratio: null, lighting_source: null,
  };
  // Weak hints from OSM, labelled "modelled" so an audit overwrites them.
  if (t.covered === 'yes') {
    attrs.shade_morning = attrs.shade_midday = attrs.shade_afternoon = 1;
    attrs.shade_source = 'modelled';
  }
  if (t.lit === 'yes') { attrs.lit_ratio = 0.8; attrs.lighting_source = 'modelled'; }
  else if (t.lit === 'no') { attrs.lit_ratio = 0.1; attrs.lighting_source = 'modelled'; }
  return attrs;
}

for (const w of ways) {
  const attrs = tagsToAttrs(w.tags);
  let startIdx = 0;
  let part = 0;
  for (let i = 1; i < w.nodes.length; i++) {
    if (!isBreak(w, i)) continue;
    const slice = w.geometry.slice(startIdx, i + 1);
    let len = 0;
    for (let k = 0; k + 1 < slice.length; k++) len += haversine(slice[k], slice[k + 1]);
    const fromId = w.nodes[startIdx];
    const toId = w.nodes[i];
    nodes.set(fromId, { id: fromId, lat: w.geometry[startIdx].lat, lng: w.geometry[startIdx].lon });
    nodes.set(toId, { id: toId, lat: w.geometry[i].lat, lng: w.geometry[i].lon });
    if (len > 0) {
      edges.push({
        osm_way_id: w.id, part: part++, name: w.tags.name ?? null,
        from_node: fromId, to_node: toId,
        geometry: slice.map((p) => [p.lon, p.lat]),
        length_m: Math.round(len * 10) / 10,
        ...attrs,
      });
    }
    startIdx = i;
  }
}

edges.sort((a, b) => a.osm_way_id - b.osm_way_id || a.part - b.part);
edges.forEach((e, i) => { e.id = i + 1; delete e.part; });

// ---------------------------------------------------------------- outputs
const nodeList = [...nodes.values()];
const summary = `${nodeList.length} nodes, ${edges.length} edges ` +
  `(${edges.filter((e) => e.is_crossing).length} crossings, ${edges.filter((e) => e.has_steps).length} steps, ` +
  `${edges.filter((e) => e.kind === 'street').length} street segments), ` +
  `${Math.round(edges.reduce((s, e) => s + e.length_m, 0))} m total`;
console.log(summary);

if (outJson) fs.writeFileSync(outJson, JSON.stringify({ nodes: nodeList, edges }, null, 2));

if (outSql) {
  const lines = ['-- generated by scripts/osm-to-graph.mjs', 'begin;'];
  for (const n of nodeList) lines.push(`insert into path_nodes (id, lat, lng) values (${n.id}, ${n.lat}, ${n.lng}) on conflict (id) do nothing;`);
  for (const e of edges) {
    lines.push(
      'insert into path_edges (id, from_node, to_node, osm_way_id, name, geometry, length_m, kind, surface, has_steps, slope_pct, ' +
      'is_crossing, crossing_type, has_kerb_ramp, has_tactile, shade_morning, shade_midday, shade_afternoon, shade_source, lit_ratio, lighting_source) values (' +
      [e.id, e.from_node, e.to_node, e.osm_way_id, sqlStr(e.name), `${sqlStr(JSON.stringify(e.geometry))}::jsonb`, e.length_m,
       sqlStr(e.kind), sqlStr(e.surface), sqlBool(e.has_steps), sqlNum(e.slope_pct),
       sqlBool(e.is_crossing), sqlStr(e.crossing_type), sqlBool(e.has_kerb_ramp), sqlBool(e.has_tactile),
       sqlNum(e.shade_morning), sqlNum(e.shade_midday), sqlNum(e.shade_afternoon), sqlStr(e.shade_source),
       sqlNum(e.lit_ratio), sqlStr(e.lighting_source)].join(', ') +
      ') on conflict (id) do nothing;',
    );
  }
  lines.push('commit;');
  fs.writeFileSync(outSql, lines.join('\n'));
}

if (outAudit) {
  const rows = [['edge_id', 'name', 'kind', 'length_m', 'mid_lat', 'mid_lng', 'maps_link', 'osm_hint']];
  for (const e of edges) {
    const half = e.length_m / 2;
    let acc = 0, mid = e.geometry[0];
    for (let k = 0; k + 1 < e.geometry.length; k++) {
      const [x0, y0] = e.geometry[k];
      const [x1, y1] = e.geometry[k + 1];
      const seg = haversine({ lat: y0, lon: x0 }, { lat: y1, lon: x1 });
      if (acc + seg >= half) {
        const t = seg === 0 ? 0 : (half - acc) / seg;
        mid = [x0 + t * (x1 - x0), y0 + t * (y1 - y0)];
        break;
      }
      acc += seg;
    }
    const hints = [e.has_steps && 'steps', e.is_crossing && `crossing:${e.crossing_type}`, e.lit_ratio != null && 'lit-tag', e.shade_source && 'covered-tag'].filter(Boolean).join(' ');
    rows.push([`E${e.id}`, e.name ?? '', e.kind, e.length_m, mid[1].toFixed(6), mid[0].toFixed(6),
      `https://www.google.com/maps?q=${mid[1].toFixed(6)},${mid[0].toFixed(6)}`, hints]);
  }
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  fs.writeFileSync(outAudit, rows.map((r) => r.map(esc).join(',')).join('\n'));
}
