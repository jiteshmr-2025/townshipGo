'use client';

import { useEffect, useMemo, useRef, useState, Suspense } from 'react';
import type { ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import {
    MapPin, Navigation, LocateFixed, Thermometer, Moon, Sun, X, Send, Share2, Check,
    Circle, CheckCircle2, ArrowLeft, Footprints, Umbrella, Lightbulb, Ban, Accessibility,
    AlertTriangle, Phone, MessageCircle, Copy, Volume2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import {
    buildGraph, planRoutes, nearestEdge, slotForHour, PROFILES,
    type Profile, type Mode, type TimeSlot, type PathNode, type PathEdge,
    type HazardReport, type HazardKind, type RouteResult,
} from '@/lib/routing';

import { estimateDefectCost } from '@/lib/scoring';

const InteractiveMap = dynamic(() => import('@/components/map/InteractiveMap'), { ssr: false });

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_ORIGIN: [number, number] = [3.1223, 101.6580];
const EMERGENCY_NUMBER = '999'; // Malaysia. Remove the "Call for help" button if you don't want it.

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

const MODES: Mode[] = ['direct', 'coolest', 'safest'];

// Plain-language names for residents
const MODE_LABEL: Record<Mode, string> = { direct: 'Shortest', coolest: 'Shadiest', safest: 'Best lit' };
const MODE_ICON: Record<Mode, LucideIcon> = { direct: Footprints, coolest: Umbrella, safest: Lightbulb };

// capexCat + severity are still saved exactly as before; residents just see plain wording
const HAZARD_OPTIONS: {
    kind: HazardKind; label: string; hint: string; Icon: LucideIcon;
    capexCat: string; severity: 'blocker' | 'comfort';
}[] = [
    { kind: 'blocked', label: 'Path is blocked', hint: 'Something is in the way', Icon: Ban, capexCat: 'Access Barrier', severity: 'blocker' },
    { kind: 'no_ramp', label: 'No ramp at the kerb', hint: 'Hard for wheelchairs and walkers', Icon: Accessibility, capexCat: 'Universal Design', severity: 'blocker' },
    { kind: 'light_out', label: 'Streetlight is not working', hint: 'Too dark to walk safely', Icon: Lightbulb, capexCat: 'Safety Electrical', severity: 'comfort' },
    { kind: 'broken_surface', label: 'Pavement is broken', hint: 'Cracked or uneven ground', Icon: AlertTriangle, capexCat: 'Pavement Renewal', severity: 'comfort' },
    { kind: 'no_shade', label: 'No shade here', hint: 'Too hot, no cover from the sun', Icon: Sun, capexCat: 'Shade Infrastructure', severity: 'comfort' },
];

type Weather = { air_temp_c?: number; feels_like_c?: number; apparent_temp_c?: number; uv_index?: number; timestamp?: string };
type Step = 'where' | 'route' | 'walking';
type TextScale = 'normal' | 'large' | 'xlarge';
type Prefs = { scale: TextScale; highContrast: boolean; reduceMotion: boolean; vibrate: boolean; speak: boolean };

const DEFAULT_PREFS: Prefs = { scale: 'normal', highContrast: false, reduceMotion: false, vibrate: true, speak: false };
const PREFS_KEY = 'townshipgo:prefs';
const SCALE_PCT: Record<TextScale, string> = { normal: '100%', large: '112.5%', xlarge: '125%' };

/* ------------------------------------------------------------------ */
/* Styles (kept in one place so the look is easy to tweak)             */
/* ------------------------------------------------------------------ */

const STYLES = `
.tg{
  --brand:#A4262C; --brand-ink:#7F1D22; --brand-soft:#F8ECEC;
  --bg:#F3F4F6; --surface:#fff; --ink:#1B1F23; --muted:#444B55; --line:#B8BFC9;
  --warn:#F2B400; --warn-ink:#2B2100; --wa:#176B3F; --bw:2px;
  font-size:1rem; line-height:1.4; color:var(--ink); background:var(--bg);
}
.tg.hc{
  --brand:#7A0F14; --brand-ink:#560A0E; --brand-soft:#fff;
  --bg:#fff; --ink:#000; --muted:#000; --line:#000; --bw:3px; --wa:#0B4A28;
}
.tg *{box-sizing:border-box}
.tg :focus-visible{outline:4px solid #1A56DB; outline-offset:3px}

.tg-header{background:var(--brand); color:#fff; display:flex; align-items:center; justify-content:space-between;
  gap:.75rem; padding:.35rem .75rem; min-height:3.25rem}
.tg-iconbtn{min-height:2.75rem; padding:0 .7rem; border-radius:14px; border:2px solid rgba(255,255,255,.85);
  background:transparent; color:#fff; font-weight:700; font-size:.9rem; display:flex; align-items:center; gap:.4rem; cursor:pointer}

.tg-banner{display:flex; align-items:center; gap:.55rem; padding:.45rem .8rem; background:#fff;
  border-bottom:var(--bw) solid var(--line); font-size:.9rem; font-weight:600; line-height:1.3}

.tg-map{position:relative; z-index:0; flex:1 1 0; min-height:10rem}

.tg-sheet{flex:0 0 auto; max-height:58dvh; overflow-y:auto; background:var(--surface);
  border-top:var(--bw) solid var(--line); border-radius:20px 20px 0 0; padding:.8rem .85rem .9rem;
  box-shadow:0 -6px 18px rgba(0,0,0,.12)}

.tg-h2{font-size:1.25rem; font-weight:800; line-height:1.2; margin:0}
.tg-label{font-size:.9rem; font-weight:700; color:var(--muted); margin:0}
.tg-small{font-size:.875rem; color:var(--muted); line-height:1.35}
.tg-stack{display:flex; flex-direction:column; gap:.6rem}

.tg-btn{width:100%; min-height:3rem; padding:.5rem .9rem; border-radius:14px; border:var(--bw) solid var(--line);
  background:#fff; color:var(--ink); font:inherit; font-weight:700; display:flex; align-items:center; justify-content:center;
  gap:.5rem; cursor:pointer; text-decoration:none; text-align:center}
.tg-btn:active{background:#E9ECF0}
.tg-btn-primary{background:var(--brand); border-color:var(--brand); color:#fff; min-height:3.25rem}
.tg-btn-primary:active{background:var(--brand-ink)}
.tg-btn-wa{background:var(--wa); border-color:var(--wa); color:#fff}
.tg-btn-outline{border-color:var(--brand); color:var(--brand)}
.tg-btn[disabled]{background:#DDE1E6; border-color:#DDE1E6; color:#3B424B; cursor:not-allowed}

.tg-card{width:100%; min-height:3.5rem; padding:.55rem .75rem; border-radius:16px; border:var(--bw) solid var(--line);
  background:#fff; color:var(--ink); font:inherit; text-align:left; display:flex; align-items:center; gap:.65rem; cursor:pointer}
.tg-card[aria-checked="true"]{border-color:var(--brand); background:var(--brand-soft); box-shadow:0 0 0 2px var(--brand)}
.tg-card-center{justify-content:center; text-align:center; min-height:3rem; font-weight:700}

.tg-badge{display:inline-block; font-size:.8rem; font-weight:800; line-height:1.2; padding:.15rem .6rem;
  border-radius:999px; border:2px solid var(--brand); color:var(--brand); background:#fff}
.tg-state{font-size:.875rem; font-weight:800; padding:.2rem .7rem; border-radius:999px; border:2px solid var(--line); background:#fff}
.tg-card[aria-checked="true"] .tg-state{background:var(--brand); border-color:var(--brand); color:#fff}

.tg-backdrop{position:fixed; inset:0; z-index:2000; background:rgba(0,0,0,.6); display:flex; align-items:flex-end; justify-content:center}
.tg-modal{width:100%; max-width:28rem; max-height:92dvh; overflow-y:auto; background:#fff; color:var(--ink);
  border-radius:20px 20px 0 0; padding:.9rem .85rem 1.1rem}

.tg-note{padding:.55rem .75rem; border-radius:12px; border:var(--bw) solid var(--line); background:#fff; font-weight:600; font-size:.9rem}
.tg-warnbox{background:#FFF6D6; border-color:var(--warn); color:var(--warn-ink)}
.tg-input{width:100%; min-height:3.75rem; padding:.55rem .7rem; border-radius:12px; border:var(--bw) solid var(--line);
  font:inherit; font-size:1rem; resize:vertical; background:#fff; color:var(--ink)}

.tg.rm *, .tg.rm *::before, .tg.rm *::after{animation:none !important; transition:none !important}
@media (prefers-reduced-motion:reduce){ .tg *{animation:none !important; transition:none !important} }
`;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

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

async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* fall through to the old method */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

function getFreshPosition(fallback: [number, number]): Promise<[number, number]> {
    return new Promise((resolve) => {
        if (!('geolocation' in navigator)) return resolve(fallback);
        navigator.geolocation.getCurrentPosition(
            (p) => resolve([p.coords.latitude, p.coords.longitude]),
            () => resolve(fallback),
            { enableHighAccuracy: true, timeout: 5000, maximumAge: 10000 },
        );
    });
}

const minutesOf = (r: RouteResult) => Math.max(1, Math.round(r.walk_min));

function reasonFor(m: Mode, r: RouteResult, night: boolean): string {
    const sun = Math.round(r.sun_exposed_min * 10) / 10;
    const dark = Math.round(r.dark_m);
    const base = night
        ? (dark < 10 ? 'Well lit all the way' : `${dark} m poorly lit`)
        : (sun < 0.5 ? 'Almost all in shade' : `${sun} min in the sun`);
    return m === 'direct' ? `Quickest way. ${base}` : base;
}

/* ------------------------------------------------------------------ */
/* Small shared components                                             */
/* ------------------------------------------------------------------ */

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
    return (
        <div className="tg-backdrop" onClick={onClose}>
            <div role="dialog" aria-modal="true" aria-label={title} className="tg-modal" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between gap-3 mb-3">
                    <h2 className="tg-h2">{title}</h2>
                    <button className="tg-btn" style={{ width: 'auto' }} onClick={onClose} autoFocus>
                        <X size={22} aria-hidden /> Close
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}

function SettingSwitch({ label, hint, checked, onChange }: {
    label: string; hint: string; checked: boolean; onChange: (v: boolean) => void;
}) {
    return (
        <button role="switch" aria-checked={checked} className="tg-card" onClick={() => onChange(!checked)}>
            <span style={{ flex: 1 }}>
                <span style={{ display: 'block', fontWeight: 800 }}>{label}</span>
                <span className="tg-small" style={{ display: 'block' }}>{hint}</span>
            </span>
            <span className="tg-state">{checked ? 'On' : 'Off'}</span>
        </button>
    );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function ResidentPageContent() {
    const searchParams = useSearchParams();

    const [userCoords, setUserCoords] = useState<[number, number]>(DEFAULT_ORIGIN);
    const [usingGPS, setUsingGPS] = useState(false);
    const [geoBusy, setGeoBusy] = useState(false);
    const [geoMsg, setGeoMsg] = useState<string | null>(null);
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
    const [step, setStep] = useState<Step>('where');
    const isNavigating = step === 'walking';

    // Hazard reporting
    const [showReportModal, setShowReportModal] = useState(false);
    const [selectedKind, setSelectedKind] = useState<HazardKind>('broken_surface');
    const [reportNotes, setReportNotes] = useState('');
    const [isSubmittingReport, setIsSubmittingReport] = useState(false);
    const [reportMsg, setReportMsg] = useState<string | null>(null);

    // Settings, sharing, confirmation
    const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
    const [prefsLoaded, setPrefsLoaded] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [showShare, setShowShare] = useState(false);
    const [shareUrl, setShareUrl] = useState('');
    const [copied, setCopied] = useState(false);
    const [shareNote, setShareNote] = useState<string | null>(null);
    const [confirmEnd, setConfirmEnd] = useState(false);
    const [canShare, setCanShare] = useState(false);
    const [canSpeak, setCanSpeak] = useState(false);

    // A mode that came from a shared link. Cleared as soon as the person changes something themselves.
    const sharedModeRef = useRef<Mode | null>(null);

    /* ---------- Preferences ---------- */
    useEffect(() => {
        let stored: Partial<Prefs> | null = null;
        try {
            const raw = localStorage.getItem(PREFS_KEY);
            if (raw) stored = JSON.parse(raw);
        } catch { /* ignore */ }
        const systemReduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        setPrefs({ ...DEFAULT_PREFS, reduceMotion: systemReduce, ...(stored ?? {}) });
        setPrefsLoaded(true);
        setCanShare(typeof navigator.share === 'function');
        setCanSpeak('speechSynthesis' in window);
    }, []);

    useEffect(() => {
        if (!prefsLoaded) return;
        try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
    }, [prefs, prefsLoaded]);

    // Text size scales the whole page because everything is sized in rem
    useEffect(() => {
        const root = document.documentElement;
        const previous = root.style.fontSize;
        root.style.fontSize = SCALE_PCT[prefs.scale];
        return () => { root.style.fontSize = previous; };
    }, [prefs.scale]);

    function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
        setPrefs((p) => ({ ...p, [key]: value }));
    }

    function buzz(ms = 40) {
        if (prefs.vibrate && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
    }

    function speak(text: string, force = false) {
        if (!force && !prefs.speak) return;
        if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 0.9;
        window.speechSynthesis.speak(u);
    }

    /* ---------- Hydrate from a shared link ---------- */
    useEffect(() => {
        if (!searchParams) return;
        let fromLink = false;

        const lat = parseFloat(searchParams.get('startLat') ?? '');
        const lng = parseFloat(searchParams.get('startLng') ?? '');
        if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
            setUserCoords([lat, lng]);
            fromLink = true;
        }

        const urlDest = searchParams.get('destId');
        if (urlDest && DESTINATIONS.some((d) => d.id === urlDest)) {
            setDestId(urlDest);
            fromLink = true;
        }

        const urlProfile = searchParams.get('profile');
        if (urlProfile && (Object.keys(PROFILES) as string[]).includes(urlProfile)) {
            setProfile(urlProfile as Profile);
        }

        const urlMode = searchParams.get('mode');
        if (urlMode && (MODES as string[]).includes(urlMode)) {
            sharedModeRef.current = urlMode as Mode;
            setActiveMode(urlMode as Mode);
        }

        if (fromLink) setStep('route');
    }, [searchParams]);

    /* ---------- Data ---------- */
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

    /* ---------- Routing ---------- */
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

    const recommended: Mode = isNight ? 'safest' : 'coolest';
    const visibleModes: Mode[] = isNight ? ['direct', 'safest'] : ['direct', 'coolest', 'safest'];

    // Pick the sensible default, unless a shared link asked for something specific
    useEffect(() => {
        const shared = sharedModeRef.current;
        if (shared && !(isNight && shared === 'coolest')) {
            setActiveMode(shared);
            return;
        }
        setActiveMode(recommended);
    }, [isNight, destId, profile, recommended]);

    const activeRoute: RouteResult | undefined =
        plan?.routes[activeMode] ?? plan?.routes.direct ?? Object.values(plan?.routes ?? {})[0];
    const shownMode: Mode = (activeRoute?.mode as Mode | undefined) ?? activeMode;

    const mapRoutes = useMemo(
        () =>
            MODES.flatMap((m) => {
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

    /* ---------- Things the person does ---------- */
    function chooseDest(id: string) {
        sharedModeRef.current = null;
        setDestId(id);
        buzz();
    }
    function chooseProfile(p: Profile) {
        sharedModeRef.current = null;
        setProfile(p);
        buzz();
    }
    function chooseMode(m: Mode) {
        sharedModeRef.current = null;
        setActiveMode(m);
        buzz();
    }

    function handleGetLocation() {
        setGeoMsg(null);
        if (!('geolocation' in navigator)) {
            setGeoMsg('This device cannot share its location. Your walk will start from PASUM / Dataran Sains.');
            return;
        }
        setGeoBusy(true);
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                setUserCoords([pos.coords.latitude, pos.coords.longitude]);
                setUsingGPS(true);
                setGeoBusy(false);
            },
            () => {
                setGeoBusy(false);
                setGeoMsg('We could not find your location. Check that location is turned on, or start from PASUM / Dataran Sains.');
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
        );
    }

    function useDefaultOrigin() {
        setUserCoords(DEFAULT_ORIGIN);
        setUsingGPS(false);
        setGeoMsg(null);
        buzz();
    }

    function startWalk() {
        buzz(80);
        setStep('walking');
        const mins = activeRoute ? minutesOf(activeRoute) : null;
        speak(`Your walk has started.${mins ? ` About ${mins} minutes to ${currentDest.name}.` : ''}`);
    }

    function endWalk() {
        setConfirmEnd(false);
        setShowReportModal(false);
        setStep('route');
        speak('Your walk has ended.');
    }

    function readRouteAloud() {
        if (!activeRoute) return;
        speak(
            `To ${currentDest.name}. ${MODE_LABEL[shownMode]} route. About ${minutesOf(activeRoute)} minutes, ` +
            `${Math.round(activeRoute.length_m)} metres. ${reasonFor(shownMode, activeRoute, isNight)}.`,
            true,
        );
    }

    /* ---------- Sharing ---------- */
    const walkMin = activeRoute ? minutesOf(activeRoute) : null;
    const shareMessage =
        `I'm walking to ${currentDest.name} on the ${MODE_LABEL[shownMode].toLowerCase()} route` +
        `${walkMin ? `, about ${walkMin} minutes` : ''}. Here is my route:`;

    function openShare() {
        const params = new URLSearchParams({
            startLat: userCoords[0].toFixed(5),
            startLng: userCoords[1].toFixed(5),
            destId,
            mode: shownMode,
            profile,
        });
        setShareUrl(`${window.location.origin}${window.location.pathname}?${params.toString()}`);
        setCopied(false);
        setShareNote(null);
        setShowShare(true);
        buzz();
    }

    async function nativeShare() {
        try {
            await navigator.share({ title: 'My walk on TownshipGo', text: shareMessage, url: shareUrl });
        } catch (err) {
            if ((err as DOMException)?.name !== 'AbortError') {
                setShareNote('Sharing did not work. Try "Copy message" instead.');
            }
        }
    }

    async function copyShare() {
        const ok = await copyText(`${shareMessage} ${shareUrl}`);
        setCopied(ok);
        setShareNote(ok ? null : 'Copying did not work. Press and hold the message above to copy it.');
        if (ok) buzz();
    }

    /* ---------- Reporting a problem ---------- */
    async function submitCapexDefect() {
        setReportMsg(null);
        setIsSubmittingReport(true);

        try {
            // While walking with GPS, report where the person is now, not where they started
            const here: [number, number] = usingGPS ? await getFreshPosition(userCoords) : userCoords;
            const near = nearestEdge(graph, here[0], here[1]);

            if (!near || near.distance_m > 150) {
                setReportMsg('You seem to be away from the mapped footpaths. Move closer to the path and try again.');
                return;
            }

            const matchedEdge = edges.find((e) => e.id === near.edge_id);
            const edgeName = matchedEdge?.name || `Walkway Edge #${near.edge_id}`;

            const selectedOpt = HAZARD_OPTIONS.find((h) => h.kind === selectedKind);
            const severity = selectedOpt?.severity ?? 'comfort';
            const estimatedCost = estimateDefectCost(selectedKind, matchedEdge?.length_m || 20);
            const category = selectedOpt?.capexCat ?? 'General Maintenance';
            const description = reportNotes || `${selectedOpt?.label} reported on ${edgeName}`;

            // 1. Live hazard table (used by the router)
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

            // 2. CAPEX maintenance queue (admin dashboard)
            const { error: dErr } = await supabase
                .from('defect_reports')
                .insert({
                    edge_id: near.edge_id,
                    lat: here[0],
                    lng: here[1],
                    latitude: here[0],
                    longitude: here[1],
                    location_name: edgeName,
                    category,
                    severity,
                    estimated_cost_rm: estimatedCost,
                    description,
                    status: 'pending_capex_review',
                });

            if (dErr) {
                console.error('Error inserting into defect_reports:', dErr.message, dErr.details, dErr.hint);
            }

            if (hData) setHazards((prev) => [...prev, hData as HazardReport]);
            // Show the new problem on the map straight away
            setReports((prev) => [
                ...prev,
                { id: `local-${Date.now()}`, lat: here[0], lng: here[1], category, kind: selectedKind, description },
            ]);

            setReportMsg(`Thank you. Your report was sent for ${edgeName}.`);
            buzz(120);
            speak('Thank you. Your report was sent.');
            setTimeout(() => {
                setShowReportModal(false);
                setReportNotes('');
                setReportMsg(null);
            }, 2200);

        } catch (err) {
            console.error('Submission failed:', err);
            setReportMsg('We could not send your report. Check your internet connection and try again.');
        } finally {
            setIsSubmittingReport(false);
        }
    }

    /* ---------- Close dialogs with Escape ---------- */
    const anyDialog = showSettings || showShare || showReportModal || confirmEnd;
    useEffect(() => {
        if (!anyDialog) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setShowSettings(false);
                setShowShare(false);
                setShowReportModal(false);
                setConfirmEnd(false);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [anyDialog]);

    /* ---------- Keep the screen on while walking ---------- */
    useEffect(() => {
        if (step !== 'walking') return;
        let lock: any = null;
        let cancelled = false;

        const acquire = async () => {
            try {
                const wl = (navigator as any).wakeLock;
                if (!wl) return;
                lock = await wl.request('screen');
                if (cancelled) lock.release?.();
            } catch { /* not supported or refused */ }
        };
        const onVisible = () => { if (document.visibilityState === 'visible') acquire(); };

        acquire();
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            cancelled = true;
            document.removeEventListener('visibilitychange', onVisible);
            try { lock?.release?.(); } catch { /* ignore */ }
        };
    }, [step]);

    /* ---------- Derived display values ---------- */
    // /api/weather returns feels_like_c. The route's built-in fallback stamps a full ISO time ending in "Z",
    // while Open-Meteo's real readings have no "Z", so that is how we tell an estimate from a live reading.
    const temp = weather?.feels_like_c ?? weather?.apparent_temp_c ?? weather?.air_temp_c;
    const isEstimate = typeof weather?.timestamp === 'string' && weather.timestamp.endsWith('Z');
    const isDefaultOrigin = userCoords[0] === DEFAULT_ORIGIN[0] && userCoords[1] === DEFAULT_ORIGIN[1];
    const originLabel = usingGPS ? 'Your current location' : isDefaultOrigin ? 'PASUM / Dataran Sains' : 'Start point from a shared link';

    const banner = (() => {
        if (isNight) return { Icon: Moon, text: 'It is dark out. We suggest the best-lit route.' };
        if (temp == null) return { Icon: Sun, text: 'We suggest the shadiest route.' };
        const t = Math.round(temp);
        const feels = isEstimate ? `about ${t}°C (estimated)` : `feels like ${t}°C`;
        const strongSun = !isEstimate && weather?.uv_index != null && weather.uv_index >= 8 ? ' The sun is very strong.' : '';
        if (t >= 32) return { Icon: Thermometer, text: `Hot today, ${feels}. We suggest the shadiest route.${strongSun}` };
        if (t >= 28) return { Icon: Thermometer, text: `Warm today, ${feels}. We suggest the shadiest route.${strongSun}` };
        return { Icon: Sun, text: `Comfortable today, ${feels}. We suggest the shadiest route.${strongSun}` };
    })();

    const ModeIcon = MODE_ICON[shownMode];

    /* ---------------------------------------------------------------- */

    return (
        <div className={`tg font-sans relative w-full max-w-md mx-auto h-[100dvh] flex flex-col overflow-hidden shadow-2xl ${prefs.highContrast ? 'hc' : ''} ${prefs.reduceMotion ? 'rm' : ''}`}>
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />

            {/* Top bar */}
            <header className="tg-header">
                <div className="flex items-center gap-2">
                    <Navigation size={22} aria-hidden />
                    <span style={{ fontWeight: 800, fontSize: '1.15rem' }}>TownshipGo</span>
                </div>
                <button className="tg-iconbtn" onClick={() => setShowSettings(true)} aria-label="Text size and display settings">
                    <span style={{ fontSize: '1.15rem', fontWeight: 800 }} aria-hidden>Aa</span>
                    <span>Display</span>
                </button>
            </header>

            {/* Friendly weather line */}
            {!isNavigating && (
                <div className="tg-banner" role="status">
                    <banner.Icon size={24} aria-hidden style={{ flexShrink: 0 }} />
                    <span>{banner.text}</span>
                </div>
            )}

            {/* Map */}
            <div className="tg-map">
                <div style={{ position: 'absolute', inset: 0 }}>
                    <InteractiveMap
                        routes={mapRoutes}
                        activeRouteId={activeRoute?.mode ?? ''}
                        reports={reports}
                        startCoords={userCoords}
                        endCoords={currentDest.coords}
                        startLabel={usingGPS ? 'You' : 'Start'}
                        reduceMotion={prefs.reduceMotion}
                        highContrast={prefs.highContrast}
                    />
                </div>
            </div>

            {/* ---------------- Bottom panel ---------------- */}
            <section className="tg-sheet" aria-live="polite">

                {/* STEP 1: where to */}
                {step === 'where' && (
                    <div className="tg-stack">
                        <h1 className="tg-h2">Where are you going?</h1>

                        <div role="radiogroup" aria-label="Destination" className="tg-stack">
                            {DESTINATIONS.map((d) => (
                                <button
                                    key={d.id}
                                    role="radio"
                                    aria-checked={destId === d.id}
                                    className="tg-card"
                                    onClick={() => chooseDest(d.id)}
                                >
                                    {destId === d.id
                                        ? <CheckCircle2 size={24} aria-hidden style={{ flexShrink: 0 }} />
                                        : <Circle size={24} aria-hidden style={{ flexShrink: 0 }} />}
                                    <span style={{ flex: 1, fontWeight: 800 }}>{d.name}</span>
                                    <MapPin size={24} aria-hidden style={{ flexShrink: 0 }} />
                                </button>
                            ))}
                        </div>

                        <div className="tg-stack" style={{ gap: '.4rem' }}>
                            <div className="flex items-center justify-between gap-2">
                                <div style={{ minWidth: 0 }}>
                                    <p className="tg-label">Starting from</p>
                                    <p style={{ fontWeight: 800, margin: 0 }}>{originLabel}</p>
                                </div>
                                {usingGPS || !isDefaultOrigin ? (
                                    <button className="tg-btn" style={{ width: 'auto', flexShrink: 0 }} onClick={useDefaultOrigin}>
                                        Use PASUM
                                    </button>
                                ) : (
                                    <button className="tg-btn" style={{ width: 'auto', flexShrink: 0 }} onClick={handleGetLocation} disabled={geoBusy}>
                                        <LocateFixed size={22} aria-hidden />
                                        {geoBusy ? 'Finding…' : 'My location'}
                                    </button>
                                )}
                            </div>
                            {geoMsg && <p className="tg-note tg-warnbox" role="alert">{geoMsg}</p>}
                        </div>

                        <div className="tg-stack" style={{ gap: '.4rem' }}>
                            <p className="tg-label">Who is walking?</p>
                            <div role="radiogroup" aria-label="Who is walking" className="grid grid-cols-2 gap-2">
                                {(Object.keys(PROFILES) as Profile[]).map((p) => (
                                    <button
                                        key={p}
                                        role="radio"
                                        aria-checked={profile === p}
                                        className="tg-card tg-card-center"
                                        onClick={() => chooseProfile(p)}
                                    >
                                        {profile === p && <Check size={22} aria-hidden />}
                                        {PROFILES[p].label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <button className="tg-btn tg-btn-primary" onClick={() => { buzz(); setStep('route'); }}>
                            Show my routes
                        </button>
                    </div>
                )}

                {/* STEP 2: choose a route */}
                {step === 'route' && (
                    <div className="tg-stack">
                        <div className="flex items-center gap-3">
                            <button className="tg-btn" style={{ width: 'auto' }} onClick={() => setStep('where')}>
                                <ArrowLeft size={22} aria-hidden /> Back
                            </button>
                            <p className="tg-small" style={{ margin: 0, flex: 1 }}>
                                To <b>{currentDest.name}</b>
                            </p>
                        </div>

                        <h1 className="tg-h2">Choose your route</h1>

                        {loadingDb ? (
                            <p className="tg-note" role="status">Loading footpaths…</p>
                        ) : !plan || !activeRoute ? (
                            <p className="tg-note tg-warnbox" role="alert">
                                We could not find a walking route from here. Go back and try a different start or destination.
                            </p>
                        ) : (
                            <>
                                <div role="radiogroup" aria-label="Route choices" className="tg-stack">
                                    {visibleModes.map((m) => {
                                        const r = plan.routes[m];
                                        if (!r) return null;
                                        const isActive = shownMode === m;
                                        const Icon = MODE_ICON[m];
                                        return (
                                            <button
                                                key={m}
                                                role="radio"
                                                aria-checked={isActive}
                                                className="tg-card"
                                                onClick={() => chooseMode(m)}
                                            >
                                                {isActive
                                                    ? <CheckCircle2 size={24} aria-hidden style={{ flexShrink: 0 }} />
                                                    : <Circle size={24} aria-hidden style={{ flexShrink: 0 }} />}
                                                <span style={{ flex: 1, minWidth: 0 }}>
                                                    <span className="flex flex-wrap items-center gap-2">
                                                        <Icon size={22} aria-hidden />
                                                        <span style={{ fontWeight: 800, fontSize: '1.05rem' }}>{MODE_LABEL[m]}</span>
                                                        {m === recommended && <span className="tg-badge">Recommended</span>}
                                                    </span>
                                                    <span className="tg-small" style={{ display: 'block', marginTop: 2 }}>
                                                        {reasonFor(m, r, isNight)}
                                                    </span>
                                                </span>
                                                <span style={{ textAlign: 'right', flexShrink: 0 }}>
                                                    <span style={{ display: 'block', fontWeight: 800, fontSize: '1.3rem', lineHeight: 1.1 }}>
                                                        {minutesOf(r)} min
                                                    </span>
                                                    <span className="tg-small" style={{ display: 'block' }}>{Math.round(r.length_m)} m</span>
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                                <p className="tg-small" style={{ margin: 0 }}>
                                    On the map: solid line is Shortest, dashed is Shadiest, dotted is Best lit. Your chosen route is thicker.
                                </p>
                            </>
                        )}

                        <div className={`grid gap-2 ${canSpeak ? 'grid-cols-2' : 'grid-cols-1'}`}>
                            {canSpeak && (
                                <button className="tg-btn" onClick={readRouteAloud} disabled={!activeRoute}>
                                    <Volume2 size={22} aria-hidden /> Read aloud
                                </button>
                            )}
                            <button className="tg-btn" onClick={openShare} disabled={!activeRoute}>
                                <Share2 size={22} aria-hidden /> Share plan
                            </button>
                        </div>

                        <button className="tg-btn tg-btn-primary" onClick={startWalk} disabled={loadingDb || !activeRoute}>
                            <Navigation size={24} aria-hidden /> Start walking
                        </button>
                    </div>
                )}

                {/* STEP 3: walking */}
                {step === 'walking' && (
                    <div className="tg-stack">
                        <div>
                            <p className="tg-label">Walking to</p>
                            <h1 className="tg-h2">{currentDest.name}</h1>
                        </div>

                        <div className="flex items-end justify-between gap-3">
                            <div>
                                <p style={{ margin: 0, fontWeight: 800, fontSize: '2.1rem', lineHeight: 1 }}>
                                    {activeRoute ? `${minutesOf(activeRoute)} min` : '--'}
                                </p>
                                <p className="tg-small" style={{ margin: '.25rem 0 0' }}>
                                    {activeRoute ? `${Math.round(activeRoute.length_m)} m in total` : 'Working it out…'}
                                </p>
                            </div>
                            <span className="tg-badge flex items-center gap-2" style={{ fontSize: '.9rem', padding: '.3rem .7rem' }}>
                                <ModeIcon size={20} aria-hidden /> {MODE_LABEL[shownMode]} route
                            </span>
                        </div>

                        <button className="tg-btn tg-btn-primary" onClick={() => { setShowReportModal(true); setReportMsg(null); buzz(); }}>
                            <AlertTriangle size={24} aria-hidden /> Report a problem
                        </button>

                        <div className="grid grid-cols-2 gap-2">
                            <button className="tg-btn" onClick={openShare}>
                                <Share2 size={22} aria-hidden /> Share
                            </button>
                            <a className="tg-btn" href={`tel:${EMERGENCY_NUMBER}`}>
                                <Phone size={22} aria-hidden /> Call for help
                            </a>
                        </div>

                        <button className="tg-btn tg-btn-outline" onClick={() => setConfirmEnd(true)}>
                            End walk
                        </button>
                    </div>
                )}
            </section>

            {/* ---------------- Dialogs ---------------- */}

            {showSettings && (
                <Sheet title="Text and display" onClose={() => setShowSettings(false)}>
                    <div className="tg-stack">
                        <p className="tg-label">Text size</p>
                        <div role="radiogroup" aria-label="Text size" className="grid grid-cols-3 gap-2">
                            {([['normal', 'Normal'], ['large', 'Large'], ['xlarge', 'Extra large']] as [TextScale, string][]).map(([v, label]) => (
                                <button
                                    key={v}
                                    role="radio"
                                    aria-checked={prefs.scale === v}
                                    className="tg-card tg-card-center"
                                    style={{ padding: '.6rem .4rem' }}
                                    onClick={() => setPref('scale', v)}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        <SettingSwitch
                            label="High contrast"
                            hint="Black text, white background, thicker borders"
                            checked={prefs.highContrast}
                            onChange={(v) => setPref('highContrast', v)}
                        />
                        <SettingSwitch
                            label="Reduce movement"
                            hint="The map jumps instead of gliding"
                            checked={prefs.reduceMotion}
                            onChange={(v) => setPref('reduceMotion', v)}
                        />
                        <SettingSwitch
                            label="Vibrate when I tap"
                            hint="A short buzz to confirm a tap"
                            checked={prefs.vibrate}
                            onChange={(v) => setPref('vibrate', v)}
                        />
                        {canSpeak && (
                            <SettingSwitch
                                label="Speak updates"
                                hint="Says out loud when your walk starts, ends or a report is sent"
                                checked={prefs.speak}
                                onChange={(v) => setPref('speak', v)}
                            />
                        )}
                        <p className="tg-small" style={{ margin: 0 }}>Your choices are saved on this device.</p>
                    </div>
                </Sheet>
            )}

            {showShare && (
                <Sheet title="Share your walk" onClose={() => setShowShare(false)}>
                    <div className="tg-stack">
                        <p className="tg-note" style={{ margin: 0, userSelect: 'text' }}>
                            {shareMessage}
                            <br />
                            <span style={{ wordBreak: 'break-all', fontWeight: 500 }}>{shareUrl}</span>
                        </p>

                        <a
                            className="tg-btn tg-btn-wa"
                            href={`https://wa.me/?text=${encodeURIComponent(`${shareMessage} ${shareUrl}`)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <MessageCircle size={24} aria-hidden /> Send on WhatsApp
                        </a>

                        {canShare && (
                            <button className="tg-btn" onClick={nativeShare}>
                                <Share2 size={22} aria-hidden /> More ways to share
                            </button>
                        )}

                        <button className="tg-btn" onClick={copyShare}>
                            {copied ? <Check size={22} aria-hidden /> : <Copy size={22} aria-hidden />}
                            {copied ? 'Copied' : 'Copy message'}
                        </button>

                        <div role="status" aria-live="polite">
                            {copied && <p className="tg-note" style={{ margin: 0 }}>Copied. You can paste it into any chat.</p>}
                            {shareNote && <p className="tg-note tg-warnbox" style={{ margin: 0 }}>{shareNote}</p>}
                        </div>

                        <p className="tg-small" style={{ margin: 0 }}>
                            Whoever opens the link sees the same route you chose. It does not track you live.
                        </p>
                    </div>
                </Sheet>
            )}

            {showReportModal && isNavigating && (
                <Sheet title="Report a problem" onClose={() => setShowReportModal(false)}>
                    <div className="tg-stack">
                        <p className="tg-label">What is the problem?</p>
                        <div role="radiogroup" aria-label="Type of problem" className="tg-stack" style={{ gap: '.5rem' }}>
                            {HAZARD_OPTIONS.map((o) => (
                                <button
                                    key={o.kind}
                                    role="radio"
                                    aria-checked={selectedKind === o.kind}
                                    className="tg-card"
                                    onClick={() => { setSelectedKind(o.kind); buzz(); }}
                                >
                                    <o.Icon size={26} aria-hidden style={{ flexShrink: 0 }} />
                                    <span style={{ flex: 1 }}>
                                        <span style={{ display: 'block', fontWeight: 800 }}>{o.label}</span>
                                        <span className="tg-small" style={{ display: 'block' }}>{o.hint}</span>
                                    </span>
                                    {selectedKind === o.kind && <CheckCircle2 size={24} aria-hidden style={{ flexShrink: 0 }} />}
                                </button>
                            ))}
                        </div>

                        <label htmlFor="report-notes" className="tg-label">Add details (optional)</label>
                        <textarea
                            id="report-notes"
                            className="tg-input"
                            value={reportNotes}
                            onChange={(e) => setReportNotes(e.target.value)}
                            placeholder="For example: near the bus stop, left side of the path"
                        />

                        <p className="tg-small" style={{ margin: 0 }}>We will use your current position as the place of the problem.</p>

                        <div role="status" aria-live="polite">
                            {reportMsg && <p className="tg-note" style={{ margin: 0 }}>{reportMsg}</p>}
                        </div>

                        <button className="tg-btn tg-btn-primary" onClick={submitCapexDefect} disabled={isSubmittingReport}>
                            <Send size={22} aria-hidden /> {isSubmittingReport ? 'Sending…' : 'Send report'}
                        </button>
                    </div>
                </Sheet>
            )}

            {confirmEnd && (
                <Sheet title="End your walk?" onClose={() => setConfirmEnd(false)}>
                    <div className="tg-stack">
                        <p style={{ margin: 0 }}>Your route will close. You can start again any time.</p>
                        <button className="tg-btn tg-btn-primary" onClick={() => setConfirmEnd(false)}>Keep walking</button>
                        <button className="tg-btn tg-btn-outline" onClick={endWalk}>Yes, end walk</button>
                    </div>
                </Sheet>
            )}
        </div>
    );
}

export default function ResidentPage() {
    return (
        <Suspense fallback={<div role="status" style={{ padding: '1.5rem', textAlign: 'center', fontSize: '1rem', fontWeight: 700, color: '#444B55' }} className="font-sans">Loading your walk…</div>}>
            <ResidentPageContent />
        </Suspense>
    );
}