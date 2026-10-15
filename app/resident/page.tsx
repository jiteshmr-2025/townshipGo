'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Sun, Shield, Navigation, AlertCircle, Thermometer, Clock, PhoneCall, Plus } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import QuickReportModal from '@/components/resident/QuickReportModal';

// Dynamically import map with SSR disabled
const InteractiveMap = dynamic(() => import('@/components/map/InteractiveMap'), { ssr: false });

export default function ResidentPage() {
    const [routes, setRoutes] = useState<any[]>([]);
    const [activeRouteId, setActiveRouteId] = useState<string>('');
    const [weather, setWeather] = useState<{ air_temp_c: number; uv_index: number } | null>(null);
    const [reports, setReports] = useState<any[]>([]);
    const [reportModalOpen, setReportModalOpen] = useState(false);

    useEffect(() => {
        fetchData();
    }, []);

    async function fetchData() {
        // 1. Fetch Routes
        const { data: routeData } = await supabase.from('route_segments').select('*');
        if (routeData && routeData.length > 0) {
            setRoutes(routeData);
            // Default to 'coolest' route if available
            const coolest = routeData.find((r) => r.route_type === 'coolest') || routeData[0];
            setActiveRouteId(coolest.id);
        }

        // 2. Fetch Live Weather API
        try {
            const res = await fetch('/api/weather');
            const wData = await res.json();
            setWeather(wData);
        } catch (e) {
            console.warn('Weather fetch fallback');
        }

        // 3. Fetch Defect Reports
        const { data: repData } = await supabase.from('defect_reports').select('*');
        if (repData) setReports(repData);
    }

    const activeRoute = routes.find((r) => r.id === activeRouteId);

    return (
        <div className="min-h-screen bg-slate-50 text-slate-900 pb-24 max-w-md mx-auto shadow-2xl border-x border-slate-200">
            {/* Header Banner */}
            <header className="bg-emerald-700 text-white p-5 rounded-b-3xl shadow-lg space-y-3">
                <div className="flex justify-between items-center">
                    <div>
                        <span className="text-xs uppercase tracking-wider text-emerald-200 font-semibold">City of Elmina</span>
                        <h1 className="text-xl font-black flex items-center gap-2">
                            AksesTenang <span className="text-xs bg-emerald-600 px-2 py-0.5 rounded-full font-normal">Resident PWA</span>
                        </h1>
                    </div>
                    <button className="bg-emerald-800 p-2 rounded-full text-emerald-100 hover:bg-emerald-900">
                        <PhoneCall className="w-5 h-5" />
                    </button>
                </div>

                {/* Live Weather & Walk Recommendation */}
                <div className="bg-emerald-800/80 rounded-2xl p-3 flex items-center justify-between text-xs backdrop-blur-sm">
                    <div className="flex items-center gap-2">
                        <Thermometer className="w-5 h-5 text-amber-300" />
                        <div>
                            <p className="font-bold text-white">{weather ? `${weather.air_temp_c}°C Ambient Air` : '31.5°C Ambient'}</p>
                            <p className="text-emerald-200">UV Index: {weather ? weather.uv_index : 4} (Moderate)</p>
                        </div>
                    </div>
                    <div className="text-right border-l border-emerald-600/60 pl-3">
                        <p className="font-bold text-amber-200">Best Walk Window</p>
                        <p className="text-emerald-100">Before 10:15 AM</p>
                    </div>
                </div>
            </header>

            <main className="p-4 space-y-4">
                {/* Route Selector Tabs */}
                <div className="bg-white p-1.5 rounded-2xl shadow-sm border border-slate-200 grid grid-cols-3 gap-1">
                    {routes.map((r) => {
                        const isActive = r.id === activeRouteId;
                        let label = 'Coolest';
                        let icon = Sun;
                        if (r.route_type === 'direct') { label = 'Direct'; icon = Navigation; }
                        if (r.route_type === 'night_safe') { label = 'Night Safe'; icon = Shield; }
                        const Icon = icon;

                        return (
                            <button
                                key={r.id}
                                onClick={() => setActiveRouteId(r.id)}
                                className={`py-2.5 px-2 rounded-xl text-xs font-bold flex flex-col items-center gap-1 transition-all ${isActive
                                        ? 'bg-emerald-600 text-white shadow-md'
                                        : 'text-slate-600 hover:bg-slate-100'
                                    }`}
                            >
                                <Icon className="w-4 h-4" />
                                <span>{label}</span>
                            </button>
                        );
                    })}
                </div>

                {/* Interactive Map Canvas */}
                <InteractiveMap routes={routes} activeRouteId={activeRouteId} reports={reports} />

                {/* Selected Route Info Card */}
                {activeRoute && (
                    <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm space-y-3">
                        <div className="flex justify-between items-start">
                            <div>
                                <h3 className="font-bold text-slate-900 text-sm">{activeRoute.name}</h3>
                                <p className="text-xs text-slate-500 mt-0.5">Elmina Valley 3/1 → Temu Shoplots ({activeRoute.length_meters}m)</p>
                            </div>
                            <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${activeRoute.route_type === 'coolest' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                                }`}>
                                {activeRoute.route_type === 'coolest' ? 'Shaded' : 'Exposed'}
                            </span>
                        </div>

                        <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-100 text-center">
                            <div className="p-2 bg-slate-50 rounded-xl">
                                <span className="text-[10px] text-slate-400 uppercase font-semibold block">Surface Heat</span>
                                <span className={`text-sm font-black ${activeRoute.surface_temp_base_c > 35 ? 'text-rose-600' : 'text-emerald-600'}`}>
                                    {activeRoute.surface_temp_base_c}°C
                                </span>
                            </div>
                            <div className="p-2 bg-slate-50 rounded-xl">
                                <span className="text-[10px] text-slate-400 uppercase font-semibold block">Shade Index</span>
                                <span className="text-sm font-black text-slate-800">{Math.round(activeRoute.shade_factor * 100)}%</span>
                            </div>
                            <div className="p-2 bg-slate-50 rounded-xl">
                                <span className="text-[10px] text-slate-400 uppercase font-semibold block">Est. Time</span>
                                <span className="text-sm font-black text-slate-800">8 mins</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Action Button: Snap & Flag */}
                <button
                    onClick={() => setReportModalOpen(true)}
                    className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-3.5 px-4 rounded-2xl flex items-center justify-center gap-2 shadow-lg transition"
                >
                    <Plus className="w-5 h-5 text-emerald-400" />
                    <span>Report Broken Light / Heat Trap</span>
                </button>
            </main>

            {/* Floating Modal */}
            <QuickReportModal
                isOpen={reportModalOpen}
                onClose={() => setReportModalOpen(false)}
                onSubmitted={fetchData}
            />
        </div>
    );
}