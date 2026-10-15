'use client';

import { useState } from 'react';
import { Sun, Lightbulb, AlertTriangle, Armchair, CheckCircle2, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onSubmitted: () => void;
}

export default function QuickReportModal({ isOpen, onClose, onSubmitted }: Props) {
    const [category, setCategory] = useState<'extreme_heat' | 'broken_light' | 'uneven_pavement' | 'no_bench' | null>(null);
    const [description, setDescription] = useState('');
    const [isProxy, setIsProxy] = useState(false);
    const [loading, setLoading] = useState(false);
    const [success, setSuccess] = useState(false);

    if (!isOpen) return null;

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!category) return;

        setLoading(true);
        // Hardcoded nearby test coordinates in Elmina for demo submission
        const { error } = await supabase.from('defect_reports').insert({
            latitude: 3.1751,
            longitude: 101.5032,
            category,
            description: description || 'Reported via Resident Mobile App',
            reported_by_proxy: isProxy,
            status: 'pending'
        });

        setLoading(false);
        if (!error) {
            setSuccess(true);
            setTimeout(() => {
                setSuccess(false);
                setCategory(null);
                setDescription('');
                onSubmitted();
                onClose();
            }, 1500);
        }
    }

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4">
            <div className="bg-white w-full max-w-md rounded-3xl p-6 shadow-2xl relative animate-in slide-in-from-bottom duration-200">
                <button onClick={onClose} className="absolute right-4 top-4 text-slate-400 hover:text-slate-600">
                    <X className="w-6 h-6" />
                </button>

                {success ? (
                    <div className="py-8 text-center space-y-3">
                        <CheckCircle2 className="w-16 h-16 text-emerald-500 mx-auto animate-bounce" />
                        <h3 className="text-xl font-bold text-slate-900">Report Submitted!</h3>
                        <p className="text-sm text-slate-500">Township management has received your location flag.</p>
                    </div>
                ) : (
                    <form onSubmit={handleSubmit} className="space-y-5">
                        <div>
                            <h2 className="text-xl font-extrabold text-slate-900">Snap & Flag Walking Issue</h2>
                            <p className="text-xs text-slate-500 mt-1">Tap an issue icon to notify SDP township maintenance.</p>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            {[
                                { id: 'extreme_heat', label: 'Extreme Heat / No Shade', icon: Sun, color: 'border-amber-200 bg-amber-50 text-amber-700' },
                                { id: 'broken_light', label: 'Broken Streetlight', icon: Lightbulb, color: 'border-blue-200 bg-blue-50 text-blue-700' },
                                { id: 'uneven_pavement', label: 'Blocked / Uneven Walkway', icon: AlertTriangle, color: 'border-rose-200 bg-rose-50 text-rose-700' },
                                { id: 'no_bench', label: 'Rest Bench Needed', icon: Armchair, color: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
                            ].map((item) => {
                                const Icon = item.icon;
                                const isSelected = category === item.id;
                                return (
                                    <button
                                        key={item.id}
                                        type="button"
                                        onClick={() => setCategory(item.id as any)}
                                        className={`p-4 rounded-2xl border-2 text-left flex flex-col justify-between h-28 transition-all ${isSelected ? 'border-emerald-600 ring-2 ring-emerald-600/20 bg-emerald-50/50' : 'border-slate-100 hover:border-slate-200 bg-slate-50/50'
                                            }`}
                                    >
                                        <Icon className={`w-6 h-6 ${item.color.split(' ')[2]}`} />
                                        <span className="text-xs font-bold text-slate-800 leading-tight">{item.label}</span>
                                    </button>
                                );
                            })}
                        </div>

                        <textarea
                            placeholder="Add details (optional e.g., near shoplot entrance)"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            className="w-full text-xs p-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            rows={2}
                        />

                        <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-600">
                            <input
                                type="checkbox"
                                checked={isProxy}
                                onChange={(e) => setIsProxy(e.target.checked)}
                                className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500"
                            />
                            <span>Filing as Caregiver / Volunteer on behalf of senior</span>
                        </label>

                        <button
                            type="submit"
                            disabled={!category || loading}
                            className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-2xl shadow-lg shadow-emerald-600/20 disabled:opacity-50 transition"
                        >
                            {loading ? 'Submitting...' : 'Send Location Flag'}
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}