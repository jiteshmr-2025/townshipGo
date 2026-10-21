'use client';

import { useCallback, useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Plus, Minus, Route as RouteIcon } from 'lucide-react';

interface RouteItem {
    id: string;
    name: string;
    route_type: string;
    coordinates: [number, number][];
}

/** A ranked defect pin for the admin dashboard */
interface OverviewPin {
    id: string | number;
    lat: number;
    lng: number;
    rank: number;
    severity: 'blocker' | 'comfort';
    title: string;
    detail?: string;
}

interface InteractiveMapProps {
    routes?: RouteItem[];
    activeRouteId?: string;
    reports?: any[];
    startCoords?: [number, number];
    endCoords?: [number, number];
    /** "Start" for the default origin, "You" when using GPS */
    startLabel?: string;
    reduceMotion?: boolean;
    highContrast?: boolean;

    /**
     * Admin dashboard mode. When `pins` is given the map shows numbered, ranked defect pins
     * instead of the start / destination / route display, and ignores routes, reports and endCoords.
     */
    pins?: OverviewPin[];
    selectedPinId?: string | number | null;
    hoveredPinId?: string | number | null;
    onPinSelect?: (id: string | number) => void;
    /** Text of the "fit everything" button */
    fitLabel?: string;
}

/* ---------- Brand colours (muted Sime Darby red) ---------- */
const BRAND = '#A4262C';
const BRAND_HC = '#7A0F14';
const WARN = '#F2B400';
const INK = '#1B1F23';

/* ---------- Walk mode pins: shape + text label, never colour alone ---------- */
function labelPill(text: string, bg: string, fg: string) {
    return `<div style="margin-top:4px;padding:2px 10px;border-radius:999px;background:${bg};color:${fg};
        font:800 13px/1.3 system-ui,sans-serif;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);
        white-space:nowrap">${text}</div>`;
}

function makePin(kind: 'start' | 'end' | 'hazard', label: string, brand: string, dx = 0) {
    let circle = '';
    let pill = '';

    if (kind === 'start') {
        circle = `<div style="width:44px;height:44px;border-radius:50%;background:${brand};border:4px solid #fff;
            box-shadow:0 2px 6px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center">
            <div style="width:14px;height:14px;border-radius:50%;background:#fff"></div></div>`;
        pill = labelPill(label, brand, '#fff');
    } else if (kind === 'end') {
        circle = `<div style="width:44px;height:44px;border-radius:50%;background:${INK};border:4px solid #fff;
            box-shadow:0 2px 6px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M6 3v18"/><path d="M6 4h12l-3 4 3 4H6" fill="#fff"/></svg></div>`;
        pill = labelPill(label, INK, '#fff');
    } else {
        circle = `<svg width="46" height="42" viewBox="0 0 46 42" aria-hidden="true">
            <path d="M23 3 L43 38 H3 Z" fill="${WARN}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>
            <rect x="21" y="15" width="4" height="12" rx="2" fill="${INK}"/>
            <circle cx="23" cy="32" r="2.4" fill="${INK}"/></svg>`;
        pill = labelPill(label, WARN, INK);
    }

    return L.divIcon({
        className: '',
        html: `<div style="display:flex;flex-direction:column;align-items:center;width:130px">${circle}${pill}</div>`,
        iconSize: [130, 76],
        iconAnchor: [65 + dx, 22], // dx > 0 shifts the pin to the left of its real position
        popupAnchor: [-dx, -20],
    });
}

/* ---------- Overview mode pins: numbered by priority. Circle = critical, rounded square = moderate ---------- */
function makeRankPin(rank: number, severity: 'blocker' | 'comfort', state: 'normal' | 'hover' | 'selected', brand: string) {
    const critical = severity === 'blocker';
    const size = state === 'selected' ? 44 : state === 'hover' ? 38 : 32;
    const bg = critical ? brand : WARN;
    const fg = critical ? '#fff' : INK;
    const radius = critical ? '50%' : '9px';
    const shadow = state === 'selected' ? `0 0 0 3px #fff, 0 0 0 6px ${INK}` : '0 2px 5px rgba(0,0,0,.45)';
    const fontSize = state === 'selected' ? 18 : 14;

    return L.divIcon({
        className: '',
        html: `<div style="width:${size}px;height:${size}px;border-radius:${radius};background:${bg};color:${fg};
            border:3px solid #fff;box-shadow:${shadow};display:flex;align-items:center;justify-content:center;
            font:800 ${fontSize}px/1 system-ui,sans-serif">${Number(rank)}</div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
    });
}

/* Gives a pin a spoken name without Leaflet's hover tooltip (which was covering other pins) */
function ariaLabelOnAdd(label: string) {
    return (e: L.LeafletEvent) => {
        (e.target as L.Marker).getElement()?.setAttribute('aria-label', label);
    };
}

/* ---------- Camera + zoom buttons ---------- */
function MapBehavior({
    points,
    focus,
    reduceMotion,
    brand,
    fitLabel,
    maxZoom,
}: {
    points: [number, number][];
    focus: [number, number] | null;
    reduceMotion: boolean;
    brand: string;
    fitLabel: string;
    maxZoom: number;
}) {
    const map = useMap();

    const fit = useCallback(
        (animate: boolean) => {
            if (points.length === 0) return;
            map.fitBounds(L.latLngBounds(points), {
                paddingTopLeft: [40, 40],
                paddingBottomRight: [76, 76],
                maxZoom,
                animate: animate && !reduceMotion,
                duration: 1,
            });
        },
        [map, points, reduceMotion, maxZoom],
    );

    // Fly to the focused point if there is one, otherwise show everything
    const focusKey = focus ? `${focus[0]},${focus[1]}` : '';
    useEffect(() => {
        if (focus) {
            const zoom = Math.max(map.getZoom(), 17);
            if (reduceMotion) map.setView(focus, zoom, { animate: false });
            else map.flyTo(focus, zoom, { duration: 0.8 });
        } else {
            fit(true);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fit, focusKey]);

    // The panels around the map can change size, so keep Leaflet in sync
    useEffect(() => {
        const el = map.getContainer();
        const ro = new ResizeObserver(() => map.invalidateSize());
        ro.observe(el);
        return () => ro.disconnect();
    }, [map]);

    // Taps on our buttons must not reach the map
    const stopPropagation = useCallback((el: HTMLDivElement | null) => {
        if (el) {
            L.DomEvent.disableClickPropagation(el);
            L.DomEvent.disableScrollPropagation(el);
        }
    }, []);

    const squareBtn: CSSProperties = {
        width: 48,
        height: 48,
        borderRadius: 14,
        border: '3px solid #1B1F23',
        background: '#fff',
        color: '#1B1F23',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(0,0,0,.3)',
    };

    return (
        <>
            {/* Zoom: top right */}
            <div
                ref={stopPropagation}
                style={{ position: 'absolute', top: 12, right: 12, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 10 }}
            >
                <button type="button" aria-label="Zoom in" style={squareBtn} onClick={() => map.zoomIn()}>
                    <Plus size={26} strokeWidth={3} aria-hidden />
                </button>
                <button type="button" aria-label="Zoom out" style={squareBtn} onClick={() => map.zoomOut()}>
                    <Minus size={26} strokeWidth={3} aria-hidden />
                </button>
            </div>

            {/* Fit everything: bottom left, away from the pins and the zoom buttons */}
            <div ref={stopPropagation} style={{ position: 'absolute', left: 12, bottom: 12, zIndex: 1000 }}>
                <button
                    type="button"
                    aria-label={fitLabel}
                    onClick={() => fit(true)}
                    style={{
                        ...squareBtn,
                        width: 'auto',
                        padding: '0 14px',
                        gap: 8,
                        background: brand,
                        borderColor: '#fff',
                        color: '#fff',
                        font: '800 14px system-ui,sans-serif',
                    }}
                >
                    <RouteIcon size={20} aria-hidden />
                    <span>{fitLabel}</span>
                </button>
            </div>
        </>
    );
}

/* Dash patterns give each route its own look without relying on colour */
const DASH: Record<string, string | undefined> = {
    direct: undefined, // solid
    coolest: '18 12', // dashed
    safest: '1 16', // dotted (round caps)
};

export default function InteractiveMap({
    routes = [],
    activeRouteId = '',
    reports = [],
    startCoords = [3.1223, 101.6580],
    endCoords = [3.1143, 101.6613],
    startLabel = 'Start',
    reduceMotion = false,
    highContrast = false,
    pins,
    selectedPinId = null,
    hoveredPinId = null,
    onPinSelect,
    fitLabel,
}: InteractiveMapProps) {
    const brand = highContrast ? BRAND_HC : BRAND;
    const overview = pins !== undefined;

    /* ----- Walk mode ----- */
    const startIcon = useMemo(() => makePin('start', startLabel, brand), [startLabel, brand]);
    const endIcon = useMemo(() => makePin('end', 'Destination', brand), [brand]);

    // Group problems reported at (almost) the same spot, and nudge a group aside if it sits on the start or destination pin
    const hazardGroups = useMemo(() => {
        if (overview) return [];
        const groups = new Map<string, { lat: number; lng: number; items: any[] }>();
        reports.forEach((r) => {
            const lat = r.lat ?? r.latitude;
            const lng = r.lng ?? r.longitude;
            if (lat == null || lng == null) return;
            const key = `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
            const g = groups.get(key);
            if (g) g.items.push(r);
            else groups.set(key, { lat, lng, items: [r] });
        });
        const NEAR_M = 40;
        const SHIFT_PX = 66;
        return [...groups.values()].map((g) => {
            const here = L.latLng(g.lat, g.lng);
            const nearStart = here.distanceTo(L.latLng(startCoords)) < NEAR_M;
            const nearEnd = here.distanceTo(L.latLng(endCoords)) < NEAR_M;
            const dx = nearStart ? SHIFT_PX : nearEnd ? -SHIFT_PX : 0; // start: pin goes left, destination: pin goes right
            const label = g.items.length > 1 ? `${g.items.length} problems` : 'Problem';
            return { ...g, label, icon: makePin('hazard', label, brand, dx) };
        });
    }, [overview, reports, startCoords, endCoords, brand]);

    // Draw the chosen route last so it sits on top
    const ordered = useMemo(
        () => [...routes].sort((a, b) => Number(a.id === activeRouteId) - Number(b.id === activeRouteId)),
        [routes, activeRouteId],
    );

    /* ----- Overview mode ----- */
    const pinMarkers = useMemo(
        () =>
            (pins ?? []).map((pin) => {
                const state: 'normal' | 'hover' | 'selected' =
                    String(pin.id) === String(selectedPinId) ? 'selected'
                        : String(pin.id) === String(hoveredPinId) ? 'hover'
                            : 'normal';
                return { pin, state, icon: makeRankPin(pin.rank, pin.severity, state, brand) };
            }),
        [pins, selectedPinId, hoveredPinId, brand],
    );

    const selectedPin = overview ? (pins ?? []).find((p) => String(p.id) === String(selectedPinId)) : undefined;

    /* ----- What the camera should frame ----- */
    const activeRoute = routes.find((r) => r.id === activeRouteId) ?? routes[0];
    const routeCoords = activeRoute?.coordinates ?? [];
    const fitSignature = overview
        ? `o:${(pins ?? []).map((p) => `${p.id}@${p.lat},${p.lng}`).join('|')}`
        : `w:${activeRoute?.id}:${routeCoords.length}:${routeCoords[0]?.join(',')}:${routeCoords[routeCoords.length - 1]?.join(',')}:${startCoords.join(',')}:${endCoords.join(',')}`;

    const fitPoints = useMemo<[number, number][]>(() => {
        if (overview) {
            const list = (pins ?? []).map((p) => [p.lat, p.lng] as [number, number]);
            return list.length > 0 ? list : [startCoords];
        }
        const list: [number, number][] = routeCoords.length > 1 ? [...routeCoords] : [];
        list.push(startCoords, endCoords);
        return list;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fitSignature]);

    const focus = useMemo<[number, number] | null>(
        () => (selectedPin ? [selectedPin.lat, selectedPin.lng] : null),
        [selectedPin?.lat, selectedPin?.lng], // eslint-disable-line react-hooks/exhaustive-deps
    );

    const popupText: CSSProperties = { fontSize: 15, lineHeight: 1.4, fontFamily: 'system-ui,sans-serif' };
    const popupProps = { maxWidth: 260, autoPanPaddingTopLeft: [16, 16] as [number, number], autoPanPaddingBottomRight: [76, 16] as [number, number] };

    return (
        <div className="w-full h-full relative z-0">
            <MapContainer
                center={startCoords}
                zoom={16}
                scrollWheelZoom
                className="w-full h-full"
                zoomControl={false}
            >
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />

                <MapBehavior
                    points={fitPoints}
                    focus={focus}
                    reduceMotion={reduceMotion}
                    brand={brand}
                    fitLabel={fitLabel ?? (overview ? 'Show all' : 'Whole route')}
                    maxZoom={overview ? 17 : 18}
                />

                {/* ======== Overview mode (admin) ======== */}
                {overview && pinMarkers.map(({ pin, state, icon }) => (
                    <Marker
                        key={String(pin.id)}
                        position={[pin.lat, pin.lng]}
                        icon={icon}
                        zIndexOffset={state === 'selected' ? 1000 : state === 'hover' ? 500 : 0}
                        eventHandlers={{
                            click: () => onPinSelect?.(pin.id),
                            add: ariaLabelOnAdd(`${pin.rank}. ${pin.title}`),
                        }}
                    >
                        <Tooltip direction="top" offset={[0, -(state === 'selected' ? 22 : 16)]}>
                            <div style={popupText}>
                                <b>{pin.rank}. {pin.title}</b>
                                {pin.detail && <div>{pin.detail}</div>}
                            </div>
                        </Tooltip>
                    </Marker>
                ))}

                {/* ======== Walk mode (resident) ======== */}
                {!overview && (
                    <>
                        {/* Routes: white outline first, then the coloured line on top */}
                        {ordered.map((route) => {
                            const isActive = route.id === activeRouteId;
                            return (
                                <Polyline
                                    key={`${route.id}-casing`}
                                    positions={route.coordinates}
                                    pathOptions={{
                                        color: '#fff',
                                        weight: isActive ? 14 : 8,
                                        opacity: 0.95,
                                        lineCap: 'round',
                                        lineJoin: 'round',
                                    }}
                                />
                            );
                        })}
                        {ordered.map((route) => {
                            const isActive = route.id === activeRouteId;
                            const dash = DASH[route.id];
                            return (
                                <Polyline
                                    key={route.id}
                                    positions={route.coordinates}
                                    pathOptions={{
                                        color: isActive ? brand : '#4B5563',
                                        weight: isActive ? 8 : 4,
                                        opacity: isActive ? 1 : 0.8,
                                        dashArray: dash,
                                        lineCap: 'round',
                                        lineJoin: 'round',
                                    }}
                                />
                            );
                        })}

                        {/* Problems reported by residents (drawn under the start and destination pins) */}
                        {hazardGroups.map((g) => (
                            <Marker
                                key={`${g.lat},${g.lng}`}
                                position={[g.lat, g.lng]}
                                icon={g.icon}
                                zIndexOffset={0}
                                eventHandlers={{ add: ariaLabelOnAdd(g.label) }}
                            >
                                <Popup {...popupProps}>
                                    <div style={popupText}>
                                        {g.items.slice(0, 3).map((report, i) => (
                                            <div key={report.id ?? i} style={{ marginTop: i ? 8 : 0 }}>
                                                <p style={{ fontWeight: 800, margin: 0 }}>
                                                    {report.category || report.kind || 'Reported problem'}
                                                </p>
                                                <p style={{ margin: '2px 0 0' }}>
                                                    {report.description || 'A resident reported an issue here.'}
                                                </p>
                                            </div>
                                        ))}
                                        {g.items.length > 3 && (
                                            <p style={{ margin: '8px 0 0', fontWeight: 700 }}>and {g.items.length - 3} more</p>
                                        )}
                                    </div>
                                </Popup>
                            </Marker>
                        ))}

                        <Marker position={endCoords} icon={endIcon} zIndexOffset={900} eventHandlers={{ add: ariaLabelOnAdd('Destination') }}>
                            <Popup {...popupProps}>
                                <div style={{ ...popupText, fontWeight: 800 }}>Where you are going</div>
                            </Popup>
                        </Marker>

                        <Marker position={startCoords} icon={startIcon} zIndexOffset={1000} eventHandlers={{ add: ariaLabelOnAdd(startLabel) }}>
                            <Popup {...popupProps}>
                                <div style={{ ...popupText, fontWeight: 800 }}>
                                    {startLabel === 'You' ? 'You are here' : 'Where your walk starts'}
                                </div>
                            </Popup>
                        </Marker>
                    </>
                )}
            </MapContainer>
        </div>
    );
}