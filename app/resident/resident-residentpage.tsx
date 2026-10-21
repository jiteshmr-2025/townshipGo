'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import {
    MapPin, Navigation, ChevronDown, LocateFixed,
    Thermometer, Moon, X, Send, Wrench, ShieldAlert, Share2
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import {
    buildGraph, planRoutes, nearestEdge, slotForHour, PROFILES,
    type Profile, type Mode, type TimeSlot, type PathNode, type PathEdge,
    type HazardReport, type HazardKind, type RouteResult,
} from '@/lib/routing';

import { estimateDefectCost } from '@/lib/scoring';

const InteractiveMap = dynamic(() => import('@/components/map/InteractiveMap'), { ssr: false });

const DESTINATIONS = [
    {
        id: 'lrt_universiti',
        name: 'LRT Universiti / KL Gateway Bridge',
        coords: [3.1143, 101.6613] as [number, number],
    },
    {
        id: 'kl_gateway_mall',
        name: 'KL Gateway Mall Promenade',
        coords: [3.1138, 101.6626] as [number, number],
    }
];

const MODE_LABEL: Record<Mode, string> = { direct: 'Direct', coolest: 'Coolest', safest: 'Safest' };
const SLOT_LABEL: Record<TimeSlot, string> = {
    morning: 'Morning shade', midday: 'Midday shade', afternoon: 'Afternoon shade', night: 'Night lighting',
};

const HAZARD_OPTIONS: { kind: HazardKind; label: string; capexCat: string; severity: 'blocker' | 'comfort' }[] = [
    { kind: 'blocked', label: 'Path blocked / obstacle', capexCat: 'Access Barrier', severity: 'blocker' },
    { kind: 'no_ramp', label: 'Curb ramp missing', capexCat: 'Universal Design', severity: 'blocker' },
    { kind: 'light_out', label: 'Streetlight malfunction', capexCat: 'Safety Electrical', severity: 'comfort' },
    { kind: 'broken_surface', label: 'Broken / uneven pavement', capexCat: 'Pavement Renewal', severity: 'comfort' },
    { kind: 'no_shade', label: 'Uncovered / heat gap', capexCat: 'Shade Infrastructure', severity: 'comfort' },
];

type Weather = { air_temp_c?: number; apparent_temp_c?: number; uv_index?: number };

function parseGeometry(g: unknown): [number, number][] {
    if (!g) return [];
    try {
        return typeof g === 'string' ? JSON.parse(g) : (g as [number, number][]);
    } catch {
        console.warn("Invalid geometry format skipped:", g);
        return [];
    }
}

async function fetchAllRows(table: string) {
    let allData: any[] = [];
    let from = 0;
    const limit = 1000;
    let hasMore = true;

    while (hasMore) {
        const { data, error } = await supabase
            .from(table)
            .select('*')
            .range(from, from + limit - 1);

        if (error) {
            console.error(`Error fetching ${table}:`, error);
            break;
        }

        if (data && data.length > 0) {
            allData.push(...data);
            from += limit;
        }

        if (!data || data.length < limit) {
            hasMore = false;
        }
    }
    return allData;
}

function ResidentPageContent() {
    const searchParams = useSearchParams();

    const [userCoords, setUserCoords] = useState<[number, number]>([3.1223, 101.6580]);
    const [usingGPS, setUsingGPS] = useState(false);
    const [destId, setDestId] = useState<string>('lrt_universiti');
    const [profile, setProfile] = useState<Profile>('senior');

    const [hour, setHour] = useState<number | null>(null);
    const [slotMode] = useState<'auto' | 'day' | 'night'>('auto');

    const [nodes, setNodes] = useState<PathNode[]>([]);
    const [edges, setEdges] = useState<PathEdge[]>([]);
    const [hazards, setHazards] = useState<HazardReport[]>([]);
    const [reports, setReports] = useState<any[]>([]);
    const [loadingDb, setLoadingDb] = useState(true);

    const [weather, setWeather] = useState<Weather | null>(null);
    const [activeMode, setActiveMode] = useState<Mode>('coolest');
    const [isNavigating, setIsNavigating] = useState(false);

    // In-Walk CAPEX & Hazard Reporting State
    const [showReportModal, setShowReportModal] = useState(false);
    const [selectedKind, setSelectedKind] = useState<HazardKind>('broken_surface');
    const [reportNotes, setReportNotes] = useState('');
    const [isSubmittingReport, setIsSubmittingReport] = useState(false);
    const [reportMsg, setReportMsg] = useState<string | null>(null);

    // Auto-Hydrate Walk Parameters from Share Link
    useEffect(() => {
        if (!searchParams) return;
        const urlLat = searchParams.get('startLat');
        const urlLng = searchParams.get('startLng');
        const urlDest = searchParams.get('destId');
        const urlMode = searchParams.get('mode') as Mode;
        const urlProfile = searchParams.get('profile') as Profile;

        if (urlLat && urlLng) {
            const lat = parseFloat(urlLat);
            const lng = parseFloat(urlLng);
            if (!isNaN(lat) && !isNaN(lng)) {
                setUserCoords([lat, lng]);
            }
        }
        if (urlDest && DESTINATIONS.some((d) => d.id === urlDest)) {
            setDestId(urlDest);
        }
        if (urlProfile && PROFILES[urlProfile]) {
            setProfile(urlProfile);
        }
        if (urlMode) {
            setActiveMode(urlMode);
        }
    }, [searchParams]);

    useEffect(() => {
        setHour(new Date().getHours());
        loadWeather();
        loadGraph();
    }, []);

    async function loadWeather() {
        try {
            const res = await fetch('/api/weather');
            if (!res.ok) throw new Error(String(res.status));
            setWeather(await res.json());
        } catch {
            setWeather(null);
        }
    }

    async function loadGraph() {
        setLoadingDb(true);
        try {
            const [nData, eData, hRes, dRes] = await Promise.all([
                fetchAllRows('path_nodes'),
                fetchAllRows('path_edges'),
                supabase.from('hazard_reports').select('id, edge_id, kind, status').neq('status', 'fixed'),
                supabase.from('defect_reports').select('*'),
            ]);

            const nodesArray = Array.isArray(nData) ? nData : (nData as any).data || [];
            const edgesArray = Array.isArray(eData) ? eData : (eData as any).data || [];

            setNodes(nodesArray as PathNode[]);

            const parsedEdges = edgesArray.map((row: any) => ({
                ...row,
                geometry: parseGeometry(row.geometry)
            })).filter((row: any) => row.geometry && row.geometry.length > 0);

            setEdges(parsedEdges as PathEdge[]);
            setHazards((hRes.data ?? []) as HazardReport[]);
            setReports(dRes.data ?? []);
        } catch (error) {
            console.error("Data processing error:", error);
        } finally {
            setLoadingDb(false);
        }
    }

    const autoSlot = slotForHour(hour ?? 12);
    const slot: TimeSlot =
        slotMode === 'night' ? 'night' : slotMode === 'day' ? (autoSlot === 'night' ? 'midday' : autoSlot) : autoSlot;
    const isNight = slot === 'night';

    const graph = useMemo(() => buildGraph(nodes, edges), [nodes, edges]);
    const currentDest = DESTINATIONS.find((d) => d.id === destId) || DESTINATIONS[0];

    const plan = useMemo(() => {
        if (graph.nodes.size === 0) return null;
        return planRoutes(graph, userCoords, currentDest.coords, profile, slot, hazards);
    }, [graph, userCoords, currentDest.coords, profile, slot, hazards]);

    useEffect(() => {
        setActiveMode(isNight ? 'safest' : 'coolest');
    }, [isNight, destId, profile]);

    const visibleModes: Mode[] = isNight ? ['direct', 'safest'] : ['direct', 'coolest', 'safest'];
    const activeRoute: RouteResult | undefined =
        plan?.routes[activeMode] ?? plan?.routes.direct ?? Object.values(plan?.routes ?? {})[0];

    const mapRoutes = useMemo(
        () =>
            (['direct', 'coolest', 'safest'] as Mode[]).flatMap((m) => {
                const r = plan?.routes[m];
                return r
                    ? [{
                        id: m,
                        name: MODE_LABEL[m],
                        route_type: m === 'safest' ? 'night_safe' : m,
                        coordinates: r.coordinates,
                        shade_factor: isNight ? r.avg_lit : r.avg_shade,
                        surface_temp_base_c: 0,
                        length_meters: Math.round(r.length_m),
                    }]
                    : [];
            }),
        [plan, isNight],
    );

    function handleGetLocation() {
        if ('geolocation' in navigator) {
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    setUserCoords([pos.coords.latitude, pos.coords.longitude]);
                    setUsingGPS(true);
                },
                () => alert('Location unavailable. Using default origin at PASUM / Dataran Sains.'),
            );
        }
    }

    // One-Click Share Walk Functionality
    async function handleShareWalk() {
        const baseUrl = window.location.origin + window.location.pathname;
        const params = new URLSearchParams({
            startLat: userCoords[0].toFixed(5),
            startLng: userCoords[1].toFixed(5),
            destId,
            mode: activeMode,
            profile,
        });

        const shareUrl = `${baseUrl}?${params.toString()}`;

        const shareData = {
            title: 'TownshipGo Live Walk',
            text: `I'm walking to ${currentDest.name} via ${MODE_LABEL[activeMode]} mode. Track my route here:`,
            url: shareUrl,
        };

        try {
            if (navigator.share) {
                await navigator.share(shareData);
            } else {
                await navigator.clipboard.writeText(shareUrl);
                alert('Walk link copied to clipboard!');
            }
        } catch (err) {
            console.error('Error sharing walk:', err);
        }
    }

    // CAPEX Defect Reporting (Integrates with defect_reports table + auto cost estimator)
    async function submitCapexDefect() {
        setReportMsg(null);
        setIsSubmittingReport(true);

        try {
            const here: [number, number] = userCoords;
            const near = nearestEdge(graph, here[0], here[1]);

            if (!near || near.distance_m > 150) {
                setReportMsg('Too far from a registered precinct footpath.');
                setIsSubmittingReport(false);
                return;
            }

            // Find matching edge details from map graph
            const matchedEdge = edges.find((e) => e.id === near.edge_id);
            const edgeName = matchedEdge?.name || `Walkway Edge #${near.edge_id}`;

            const selectedOpt = HAZARD_OPTIONS.find((h) => h.kind === selectedKind);
            const severity = selectedOpt?.severity ?? 'comfort';
            const estimatedCost = estimateDefectCost(selectedKind, matchedEdge?.length_m || 20);

            // 1. Submit to Live Hazard Table (Dijkstra Routing)
            const { data: hData, error: hErr } = await supabase
                .from('hazard_reports')
                .insert({
                    edge_id: near.edge_id,
                    lat: here[0],
                    lng: here[1],
                    kind: selectedKind,
                    status: 'open',
                    reporter_role: 'resident',
                })
                .select('id, edge_id, kind, status')
                .single();

            if (hErr) throw hErr;

            // 2. Submit to CAPEX Maintenance Queue Table (Admin Dashboard)
            const { error: dErr } = await supabase
                .from('defect_reports')
                .insert({
                    edge_id: near.edge_id,
                    lat: here[0],
                    lng: here[1],
                    latitude: here[0],
                    longitude: here[1],
                    location_name: edgeName,
                    category: selectedOpt?.capexCat ?? 'General Maintenance',
                    severity,
                    estimated_cost_rm: estimatedCost,
                    description: reportNotes || `${selectedOpt?.label} reported on ${edgeName}`,
                    status: 'pending_capex_review',
                });

            if (dErr) {
                console.error('Error inserting into defect_reports:', dErr.message, dErr.details, dErr.hint);
            }

            if (hData) setHazards((prev) => [...prev, hData as HazardReport]);

            setReportMsg(`Logged! Location: ${edgeName} (Est. RM ${estimatedCost.toLocaleString()})`);
            setTimeout(() => {
                setShowReportModal(false);
                setReportNotes('');
                setReportMsg(null);
            }, 1500);

        } catch (err) {
            console.error('Submission failed:', err);
            setReportMsg('Submission failed. Check network connection.');
        } finally {
            setIsSubmittingReport(false);
        }
    }

    const temp = weather?.apparent_temp_c ?? weather?.air_temp_c;
    const tempLabel = weather?.apparent_temp_c != null ? 'Feels like' : 'Air';
    const pace = PROFILES[profile].speed_mps;

    return (
        <div className="relative w-full max-w-md mx-auto h-screen bg-slate-100 overflow-hidden shadow-2xl border-x border-slate-200 font-sans">
            {/* Header Control Panel */}
            <div className="absolute top-3 left-3 right-3 z-30 space-y-2">
                {!isNavigating ? (
                    <div className="bg-white rounded-3xl p-3.5 shadow-xl border border-slate-100 space-y-2.5">
                        <div className="flex justify-between items-center text-[10px] bg-red-50 text-red-700 px-3 py-1 rounded-xl border border-red-100 font-bold">
                            <span className="flex items-center gap-1">
                                {isNight ? (
                                    <>
                                        <Moon className="w-3.5 h-3.5 text-blue-600" />
                                        <span>Night Mode (Lighting Audited)</span>
                                    </>
                                ) : (
                                    <>
                                        <Thermometer className="w-3.5 h-3.5 text-red-500" />
                                        <span>{temp != null ? <>{tempLabel} <b>{Math.round(temp)}°C</b></> : 'Weather unavailable'}</span>
                                    </>
                                )}
                            </span>
                            <span>{isNight ? 'Lighting' : weather?.uv_index != null ? <>UV <b>{weather.uv_index}</b></> : SLOT_LABEL[slot]}</span>
                        </div>

                        <div className="flex gap-1.5">
                            {(Object.keys(PROFILES) as Profile[]).map((p) => (
                                <button
                                    key={p}
                                    onClick={() => setProfile(p)}
                                    className={`flex-1 text-[10px] font-extrabold py-1.5 rounded-xl border transition ${profile === p ? 'bg-red-500 text-white border-red-500' : 'bg-slate-50 text-slate-600 border-slate-200'}`}
                                >
                                    {PROFILES[p].label}
                                </button>
                            ))}
                        </div>

                        <div className="flex items-center justify-between bg-slate-50 p-2 rounded-2xl border border-slate-100">
                            <div className="flex items-center gap-2 overflow-hidden">
                                <div className="w-2.5 h-2.5 rounded-full bg-blue-600 ml-1 flex-shrink-0 animate-pulse" />
                                <span className="text-xs font-bold text-slate-800 truncate">
                                    {usingGPS ? 'GPS Location Selected' : 'Point A: UM PASUM / Dataran Sains'}
                                </span>
                            </div>
                            <button
                                onClick={handleGetLocation}
                                className="text-red-500 hover:text-red-600 p-1 flex items-center gap-1 text-[10px] font-extrabold bg-red-50 px-2 py-0.5 rounded-xl"
                            >
                                <LocateFixed className="w-3 h-3" />
                                <span>{usingGPS ? 'Active' : 'GPS'}</span>
                            </button>
                        </div>

                        <div className="relative flex items-center bg-slate-50 rounded-2xl border border-red-200 p-2">
                            <MapPin className="w-4 h-4 text-red-500 flex-shrink-0 mr-2" />
                            <select
                                value={destId}
                                onChange={(e) => setDestId(e.target.value)}
                                className="w-full text-xs font-extrabold text-slate-900 bg-transparent focus:outline-none appearance-none cursor-pointer pr-6"
                            >
                                {DESTINATIONS.map((d) => (
                                    <option key={d.id} value={d.id}>Point B: {d.name}</option>
                                ))}
                            </select>
                            <ChevronDown className="w-4 h-4 text-slate-400 absolute right-3 pointer-events-none" />
                        </div>
                    </div>
                ) : (
                    /* Active Navigation Header Panel */
                    <div className="bg-red-600 text-white rounded-3xl p-4 shadow-xl space-y-2">
                        <div className="flex justify-between items-center">
                            <span className="text-[11px] font-black text-red-100 flex items-center gap-1.5 uppercase tracking-wider">
                                <Navigation className="w-4 h-4 text-white" /> Walk in progress
                            </span>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handleShareWalk}
                                    className="bg-white/20 hover:bg-white/30 px-3 py-1 rounded-xl text-[10px] font-extrabold text-white backdrop-blur-md flex items-center gap-1.5 transition"
                                >
                                    <Share2 className="w-3.5 h-3.5" />
                                    <span>Share</span>
                                </button>
                                <button
                                    onClick={() => { setIsNavigating(false); setShowReportModal(false); }}
                                    className="bg-white/20 hover:bg-white/30 px-3 py-1 rounded-xl text-[10px] font-black text-white backdrop-blur-md"
                                >
                                    End Walk
                                </button>
                            </div>
                        </div>
                        <div className="flex justify-between items-baseline pt-1">
                            <div>
                                <p className="text-2xl font-black">
                                    {activeRoute ? `${Math.round(activeRoute.length_m)}m` : '--'}
                                </p>
                                <p className="text-[10px] font-bold text-red-100">
                                    {activeRoute ? `Total (~${Math.max(1, Math.round(activeRoute.walk_min))} min)` : 'Calculating...'}
                                </p>
                            </div>
                            <span className="text-xs font-extrabold bg-red-700/60 px-2.5 py-1 rounded-lg">
                                {MODE_LABEL[activeMode]} Mode
                            </span>
                        </div>
                    </div>
                )}
            </div>

            {/* Interactive Leaflet Map */}
            <div className="w-full h-full absolute inset-0 z-0">
                <InteractiveMap
                    routes={mapRoutes}
                    activeRouteId={activeRoute?.mode ?? ''}
                    reports={reports}
                    startCoords={userCoords}
                    endCoords={currentDest.coords}
                />
            </div>

            {/* Floating CAPEX / Defect Reporting Button — ONLY SHOWN WHILE WALKING */}
            {isNavigating && !showReportModal && (
                <button
                    onClick={() => { setShowReportModal(true); setReportMsg(null); }}
                    className="absolute bottom-6 right-4 z-30 bg-red-500 hover:bg-red-600 text-white font-extrabold px-4 py-3 rounded-2xl shadow-2xl flex items-center gap-2 text-xs border-2 border-white animate-bounce"
                >
                    <Wrench className="w-4 h-4" />
                    <span>Report Hazard / CAPEX</span>
                </button>
            )}

            {/* In-Walk CAPEX Infrastructure Reporting Modal */}
            {isNavigating && showReportModal && (
                <div className="absolute bottom-0 left-0 right-0 z-40 p-5 bg-white rounded-t-3xl border-t border-slate-200 shadow-2xl space-y-3.5 max-h-[85vh] overflow-y-auto">
                    <div className="flex justify-between items-center border-b border-slate-100 pb-2.5">
                        <div className="flex items-center gap-2 text-slate-900">
                            <ShieldAlert className="w-4 h-4 text-red-500" />
                            <h3 className="text-xs font-black uppercase tracking-wider">Report On-The-Way Hazard</h3>
                        </div>
                        <button onClick={() => setShowReportModal(false)} className="p-1 text-slate-400 hover:text-slate-700">
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="space-y-2">
                        <label className="text-[10px] font-extrabold text-slate-500 uppercase">1. Issue Category</label>
                        <div className="grid grid-cols-2 gap-1.5">
                            {HAZARD_OPTIONS.map((o) => (
                                <button
                                    key={o.kind}
                                    onClick={() => setSelectedKind(o.kind)}
                                    className={`text-left p-2.5 rounded-xl border text-[11px] font-bold transition ${selectedKind === o.kind
                                        ? 'bg-red-50 border-red-500 text-red-700 ring-2 ring-red-500/20'
                                        : 'bg-slate-50 border-slate-200 text-slate-700'
                                        }`}
                                >
                                    <p className="leading-tight">{o.label}</p>
                                    <div className="flex justify-between items-center mt-1">
                                        <span className="text-[9px] font-semibold text-slate-400">{o.capexCat}</span>
                                        <span className={`text-[8px] font-bold px-1.5 py-0.2 rounded ${o.severity === 'blocker' ? 'bg-red-100 text-red-800' : 'bg-slate-200 text-slate-700'}`}>
                                            {o.severity}
                                        </span>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-[10px] font-extrabold text-slate-500 uppercase">2. Notes / Details</label>
                        <textarea
                            value={reportNotes}
                            onChange={(e) => setReportNotes(e.target.value)}
                            placeholder="Describe exact physical location or issue..."
                            className="w-full text-xs font-medium p-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-red-400 h-16 resize-none"
                        />
                    </div>

                    {reportMsg && (
                        <div className="p-2.5 rounded-xl text-[11px] font-bold bg-slate-100 text-slate-800 text-center">
                            {reportMsg}
                        </div>
                    )}

                    <button
                        onClick={submitCapexDefect}
                        disabled={isSubmittingReport}
                        className="w-full bg-red-500 hover:bg-red-600 text-white font-black py-3 rounded-xl shadow-lg shadow-red-500/30 text-xs flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                        <Send className="w-3.5 h-3.5" />
                        <span>{isSubmittingReport ? 'Submitting...' : 'Submit Report'}</span>
                    </button>
                </div>
            )}

            {/* Bottom Route Summary Drawer (Only visible when NOT walking) */}
            {!isNavigating && (
                <div className="absolute bottom-12 left-0 right-0 z-20 p-4 bg-white/95 backdrop-blur-md rounded-t-3xl border-t border-slate-200 shadow-2xl space-y-3">
                    <div className="flex justify-between items-center">
                        <div>
                            <h3 className="text-xs font-extrabold text-slate-900">
                                {activeRoute ? `${Math.round(activeRoute.length_m)}m • ~${Math.max(1, Math.round(activeRoute.walk_min))} min` : 'Routes'}
                            </h3>
                            <p className="text-[10px] text-slate-500">Pace: {pace}m/s</p>
                        </div>
                    </div>

                    {loadingDb ? (
                        <div className="text-center py-4 text-xs font-bold text-slate-400">Loading UM paths…</div>
                    ) : (
                        <div className={`grid gap-2 ${visibleModes.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
                            {visibleModes.map((m) => {
                                const r = plan?.routes[m];
                                if (!r) return null;
                                const isActive = activeRoute?.mode === m;
                                return (
                                    <button
                                        key={m}
                                        onClick={() => setActiveMode(m)}
                                        className={`p-2.5 rounded-2xl border text-left flex flex-col justify-between h-24 transition ${isActive ? 'border-red-500 bg-red-50/50 ring-2 ring-red-500/20' : 'border-slate-200 bg-slate-50'}`}
                                    >
                                        <span className={`text-[8px] font-extrabold px-1.5 py-0.5 rounded-full self-start text-white ${m === 'direct' ? 'bg-red-500' : m === 'coolest' ? 'bg-emerald-600' : 'bg-blue-600'}`}>
                                            {MODE_LABEL[m]}
                                        </span>
                                        <div>
                                            <p className="text-[11px] font-black text-slate-900 leading-tight">
                                                {isNight ? `${Math.round(r.dark_m)}m dark` : `${Math.round(r.sun_exposed_min * 10) / 10} min sun`}
                                            </p>
                                            <p className="text-[9px] text-slate-500">{Math.round(r.length_m)}m</p>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    <button
                        onClick={() => setIsNavigating(true)}
                        disabled={loadingDb || !activeRoute}
                        className="w-full bg-red-500 hover:bg-red-600 text-white font-black py-3.5 rounded-2xl shadow-lg shadow-red-500/30 text-xs flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                        <Navigation className="w-4 h-4" />
                        <span>Start walk</span>
                    </button>
                </div>
            )}
        </div>
    );
}

export default function ResidentPage() {
    return (
        <Suspense fallback={<div className="p-4 text-center text-xs font-bold text-slate-400">Loading walk navigation…</div>}>
            <ResidentPageContent />
        </Suspense>
    );
}