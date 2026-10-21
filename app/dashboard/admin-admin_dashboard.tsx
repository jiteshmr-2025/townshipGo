'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import {
    Leaf, Footprints, AlertTriangle, ArrowUpDown,
    Lightbulb, Flame, MapPin
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import {
    rankInterventions,
    estimateDefectCost,
    type Intervention,
    type RankedIntervention
} from '@/lib/scoring';

const InteractiveMap = dynamic(() => import('@/components/map/InteractiveMap'), { ssr: false });

const SEED_DEFECTS = [
    { id: 'demo-1', category: 'Universal Design', severity: 'blocker', description: 'Missing Curb Ramp / Bad Sidewalk', location_name: 'Lengkok Cendakia', estimated_cost_rm: estimateDefectCost('no_ramp', 20), edge_id: 102, lat: 3.1215, lng: 101.6565 },
    { id: 'demo-2', category: 'Safety Electrical', severity: 'comfort', description: 'Malfunctioning Lamp Post', location_name: 'PASUM / Dataran Sains', estimated_cost_rm: estimateDefectCost('light_out', 20), edge_id: 104, lat: 3.1225, lng: 101.6585 },
    { id: 'demo-3', category: 'Safety Electrical', severity: 'comfort', description: 'Broken Streetlight', location_name: 'Dewan Kuliah 3 Walkway', estimated_cost_rm: estimateDefectCost('light_out', 20), edge_id: 101, lat: 3.1230, lng: 101.6575 },
    { id: 'demo-4', category: 'Shade Infrastructure', severity: 'comfort', description: 'Uncovered Heat Gap', location_name: 'Lingkungan Budi', estimated_cost_rm: estimateDefectCost('no_shade', 35), edge_id: 103, lat: 3.1205, lng: 101.6590 },
];

export default function AdminDashboardPage() {
    const [defects, setDefects] = useState<any[]>([]);
    const [reports, setReports] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [sortBy, setSortBy] = useState<'roi' | 'recent'>('roi');
    const [selectedEdgeId, setSelectedEdgeId] = useState<number | string | null>(null);

    useEffect(() => {
        loadData();
    }, []);

    async function loadData() {
        setLoading(true);
        try {
            const [dRes, rRes] = await Promise.all([
                supabase.from('defect_reports').select('*').neq('status', 'fixed'),
                supabase.from('hazard_reports').select('*').neq('status', 'fixed'),
            ]);

            const liveDefects = dRes.data || [];
            setDefects(liveDefects.length > 0 ? liveDefects : SEED_DEFECTS);
            setReports(rRes.data || []);
        } catch (err) {
            console.error('Error fetching admin dashboard data:', err);
            setDefects(SEED_DEFECTS);
        } finally {
            setLoading(false);
        }
    }

    const interventions: Intervention[] = useMemo(() => {
        return defects.map((d) => {
            const isBlocker = d.severity === 'blocker' || d.category === 'Access Barrier' || d.category === 'Universal Design';
            const kind = d.category === 'Shade Infrastructure' ? 'shade'
                : d.category === 'Safety Electrical' ? 'light'
                    : d.category === 'Universal Design' ? 'ramp' : 'crossing';

            const cost = d.estimated_cost_rm && d.estimated_cost_rm > 0
                ? d.estimated_cost_rm
                : estimateDefectCost(kind, 20);

            return {
                id: d.id,
                label: d.description || d.category,
                kind,
                cost_rm: cost,
                users_low: 400,
                users_high: 1200,
                trips_per_week: 14,
                severity: isBlocker ? 'blocker' : 'comfort',
                exposure_per_trip: isBlocker ? 1 : 120,
            };
        });
    }, [defects]);

    const rankedItems: RankedIntervention[] = useMemo(() => {
        if (interventions.length === 0) return [];
        const ranked = rankInterventions(interventions);
        return sortBy === 'recent' ? [...ranked].reverse() : ranked;
    }, [interventions, sortBy]);

    const maxScore = useMemo(() => {
        if (rankedItems.length === 0) return 1;
        return Math.max(...rankedItems.map((i) => i.score_mid));
    }, [rankedItems]);

    // Grounded Pedestrian Impact Metrics
    const metrics = useMemo(() => {
        const totalUsersProtected = rankedItems.reduce((acc, curr) => acc + (curr.users_low + curr.users_high) / 2, 0);
        const totalAnnualExposureRemoved = rankedItems.reduce((acc, curr) => acc + curr.annual_exposure_removed, 0);

        return {
            vulnerableFootfall: Math.round(totalUsersProtected) || 1000,
            sunHoursRemoved: Math.round(totalAnnualExposureRemoved / 60).toLocaleString() || '1,250',
            activeDefectsCount: rankedItems.length,
        };
    }, [rankedItems]);

    // Identify active defect selected from the queue
    const activeSelectedDefect = useMemo(() => {
        if (!selectedEdgeId) return null;
        return defects.find((d) => String(d.edge_id) === String(selectedEdgeId) || String(d.id) === String(selectedEdgeId));
    }, [selectedEdgeId, defects]);

    // Extract coordinates with fallback for both schema variants (lat/lng and latitude/longitude)
    const mapStartCoords = useMemo<[number, number]>(() => {
        if (!activeSelectedDefect) return [3.1223, 101.6580];
        const lat = activeSelectedDefect.lat ?? activeSelectedDefect.latitude;
        const lng = activeSelectedDefect.lng ?? activeSelectedDefect.longitude;
        if (lat != null && lng != null) {
            return [Number(lat), Number(lng)];
        }
        return [3.1223, 101.6580];
    }, [activeSelectedDefect]);

    async function handleMarkFixed(id: string, e: React.MouseEvent) {
        e.stopPropagation(); // Prevent triggering row select
        try {
            if (!id.startsWith('demo-')) {
                await supabase.from('defect_reports').update({ status: 'fixed' }).eq('id', id);
            }
            setDefects((prev) => prev.filter((item) => item.id !== id));
            if (selectedEdgeId === id) setSelectedEdgeId(null);
        } catch (err) {
            console.error('Failed to update defect state:', err);
        }
    }

    return (
        <div className="min-h-screen bg-[#f8f5f5] text-slate-800 font-sans pb-12">
            {/* Header */}
            <header className="bg-white border-b border-slate-200/80 px-8 py-4 flex items-center justify-between sticky top-0 z-50">
                <h1 className="text-xl font-extrabold tracking-tight text-slate-900 flex items-center gap-2">
                    TownshipGo <span className="text-slate-300 font-normal">◆</span> <span className="text-slate-500 font-semibold text-base">Command Center</span>
                </h1>
                <div className="flex items-center gap-2 bg-slate-100 px-3.5 py-1.5 rounded-full border border-slate-200/60">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-xs font-bold text-slate-700">UM Precinct Live Feed</span>
                </div>
            </header>

            {/* Main Content Layout */}
            <main className="max-w-7xl mx-auto px-6 mt-6 grid grid-cols-1 lg:grid-cols-12 gap-6">

                {/* Left Side: Interactive Precinct Map View */}
                <div className="lg:col-span-5 bg-white rounded-3xl p-3 border border-slate-200/60 shadow-sm relative min-h-[580px] flex flex-col">
                    <div className="absolute top-6 left-6 z-20 bg-white/95 backdrop-blur-md shadow-md rounded-2xl px-3 py-2 border border-slate-200/80 flex items-center gap-2">
                        <MapPin className="w-4 h-4 text-red-500" />
                        <span className="text-xs font-bold text-slate-800">
                            {activeSelectedDefect ? activeSelectedDefect.location_name : 'Universiti Malaya Precinct'}
                        </span>
                    </div>

                    <div className="w-full h-full rounded-2xl overflow-hidden relative flex-1 min-h-[520px]">
                        <InteractiveMap
                            routes={[]}
                            activeRouteId=""
                            reports={reports}
                            startCoords={mapStartCoords}
                            endCoords={[3.1143, 101.6613]}
                        />
                    </div>
                </div>

                {/* Right Side: Grounded Pedestrian KPIs & Queue */}
                <div className="lg:col-span-7 space-y-6">
                    <h2 className="text-2xl font-black text-slate-900 tracking-tight">Dashboard</h2>

                    {/* KPI Cards Row */}
                    <div className="grid grid-cols-3 gap-4">
                        <div className="bg-white rounded-3xl p-5 border border-slate-200/60 shadow-sm flex flex-col items-center text-center space-y-2">
                            <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center">
                                <Leaf className="w-5 h-5 text-red-500" />
                            </div>
                            <span className="text-[11px] font-bold text-slate-600 leading-tight">Annual Sun Exposure<br />Avoided</span>
                            <div className="pt-1">
                                <p className="text-2xl font-black text-red-500">{metrics.sunHoursRemoved} hrs</p>
                                <p className="text-[10px] font-semibold text-slate-400">Pedestrian Heat Reduction</p>
                            </div>
                        </div>

                        <div className="bg-white rounded-3xl p-5 border border-slate-200/60 shadow-sm flex flex-col items-center text-center space-y-2">
                            <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center">
                                <Footprints className="w-5 h-5 text-red-500" />
                            </div>
                            <span className="text-[11px] font-bold text-slate-600 leading-tight">Vulnerable Footfall<br />Protected</span>
                            <div className="pt-1">
                                <p className="text-2xl font-black text-red-500">{metrics.vulnerableFootfall.toLocaleString()}</p>
                                <p className="text-[10px] font-semibold text-slate-400">Estimated/Week</p>
                            </div>
                        </div>

                        <div className="bg-white rounded-3xl p-5 border border-slate-200/60 shadow-sm flex flex-col items-center text-center space-y-2">
                            <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center">
                                <AlertTriangle className="w-5 h-5 text-red-500" />
                            </div>
                            <span className="text-[11px] font-bold text-slate-600 leading-tight">Active Backlog<br />Defects</span>
                            <div className="pt-1">
                                <p className="text-2xl font-black text-red-500">{metrics.activeDefectsCount}</p>
                                <p className="text-[10px] font-semibold text-slate-400">Pending Infrastructure Fixes</p>
                            </div>
                        </div>
                    </div>

                    {/* Infrastructure Investment Queue */}
                    <div className="bg-white rounded-3xl p-6 border border-slate-200/60 shadow-sm space-y-4">
                        <div className="flex justify-between items-center">
                            <h3 className="text-lg font-black text-slate-900">Infrastructure Investment Queue</h3>
                            <button
                                onClick={() => setSortBy(sortBy === 'roi' ? 'recent' : 'roi')}
                                className="bg-red-500 hover:bg-red-600 text-white font-extrabold px-4 py-2 rounded-2xl text-xs flex items-center gap-1.5 transition shadow-sm"
                            >
                                <ArrowUpDown className="w-3.5 h-3.5" />
                                <span>{sortBy === 'roi' ? 'Sort by Recent' : 'Sort by ROI Score'}</span>
                            </button>
                        </div>

                        {/* Interactive Queue Table */}
                        <div className="overflow-x-auto">
                            <table className="w-full text-left border-collapse">
                                <thead>
                                    <tr className="text-[11px] font-black text-slate-500 border-b border-slate-200 pb-2 uppercase tracking-wider">
                                        <th className="py-2.5 px-2">Location</th>
                                        <th className="py-2.5 px-2">Primary Defect</th>
                                        <th className="py-2.5 px-2">Estimated Cost</th>
                                        <th className="py-2.5 px-2">Score</th>
                                        <th className="py-2.5 px-2 text-right">Action</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {loading ? (
                                        <tr>
                                            <td colSpan={5} className="py-8 text-center text-xs font-bold text-slate-400">
                                                Loading ranking queue...
                                            </td>
                                        </tr>
                                    ) : (
                                        rankedItems.map((item) => {
                                            const rawDefect = defects.find((d) => d.id === item.id);
                                            const locationName = rawDefect?.location_name || `Walkway Edge #${rawDefect?.edge_id || '101'}`;
                                            const isSelected = String(selectedEdgeId) === String(rawDefect?.edge_id) || String(selectedEdgeId) === String(item.id);

                                            const displayScore = item.severity === 'blocker'
                                                ? 99
                                                : Math.min(88, Math.max(15, Math.round((item.score_mid / maxScore) * 85)));

                                            return (
                                                <tr
                                                    key={item.id}
                                                    onClick={() => setSelectedEdgeId(rawDefect?.edge_id || item.id)}
                                                    className={`cursor-pointer transition text-xs font-semibold ${isSelected ? 'bg-red-50/80 ring-1 ring-red-300' : 'hover:bg-slate-50/80 text-slate-700'
                                                        }`}
                                                >
                                                    <td className="py-3.5 px-2 font-bold text-slate-900 max-w-[150px] truncate">
                                                        {locationName}
                                                    </td>
                                                    <td className="py-3.5 px-2 flex items-center gap-2">
                                                        {item.kind === 'light' ? (
                                                            <Lightbulb className="w-4 h-4 text-amber-500 flex-shrink-0" />
                                                        ) : item.kind === 'ramp' ? (
                                                            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
                                                        ) : item.kind === 'shade' ? (
                                                            <Flame className="w-4 h-4 text-orange-500 flex-shrink-0" />
                                                        ) : (
                                                            <Footprints className="w-4 h-4 text-slate-600 flex-shrink-0" />
                                                        )}
                                                        <span className="capitalize truncate max-w-[180px]">{item.label}</span>
                                                    </td>
                                                    <td className="py-3.5 px-2 font-bold text-slate-800">
                                                        RM {item.cost_rm.toLocaleString()}
                                                    </td>
                                                    <td className="py-3.5 px-2">
                                                        <span className={`inline-block px-3 py-1 rounded-full text-xs font-black text-white ${item.severity === 'blocker' ? 'bg-red-600' : 'bg-stone-800'
                                                            }`}>
                                                            {displayScore}
                                                        </span>
                                                    </td>
                                                    <td className="py-3.5 px-2 text-right">
                                                        <button
                                                            onClick={(e) => handleMarkFixed(item.id, e)}
                                                            className="bg-red-500 hover:bg-red-600 text-white font-extrabold px-3 py-1.5 rounded-xl text-[11px] transition shadow-sm"
                                                        >
                                                            Mark Fixed
                                                        </button>
                                                    </td>
                                                </tr>
                                            );
                                        })
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>

                </div>
            </main>
        </div>
    );
}