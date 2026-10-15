import { NextResponse } from 'next/server';

export async function GET() {
    const LAT = 3.1752;
    const LNG = 101.5038;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LNG}&current=temperature_2m,relative_humidity_2m,direct_normal_irradiance,uv_index`;

    try {
        const res = await fetch(url, { next: { revalidate: 300 } }); // Cache for 5 mins
        const data = await res.json();

        return NextResponse.json({
            air_temp_c: data.current.temperature_2m,
            humidity_percent: data.current.relative_humidity_2m,
            solar_irradiance_wm2: data.current.direct_normal_irradiance,
            uv_index: data.current.uv_index,
            timestamp: data.current.time
        });
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch live weather' }, { status: 500 });
    }
}