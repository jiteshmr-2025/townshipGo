import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET() {
    try {
        const { data: routes, error: routesErr } = await supabase
            .from('route_segments')
            .select('*');

        const { data: capex, error: capexErr } = await supabase
            .from('capex_interventions')
            .select('*');

        if (routesErr || capexErr) {
            return NextResponse.json({ error: routesErr || capexErr }, { status: 500 });
        }

        return NextResponse.json({
            status: 'success',
            routes_count: routes?.length || 0,
            capex_count: capex?.length || 0,
            sample_route: routes?.[0]?.name || null
        });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}