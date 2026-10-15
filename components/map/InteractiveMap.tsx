'use client';

import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Polyline, Marker, Popup } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// Fix default Leaflet marker icon issue in Next.js
const defaultIcon = L.icon({
    iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
    iconSize: [25, 41],
    iconAnchor: [12, 41],
});

interface RouteData {
    id: string;
    name: string;
    route_type: string;
    coordinates: [number, number][]; // [lng, lat]
    shade_factor: number;
    surface_temp_base_c: number;
}

interface MapProps {
    routes: RouteData[];
    activeRouteId: string;
    reports?: { id: string; latitude: number; longitude: number; category: string; description: string }[];
}

export default function InteractiveMap({ routes, activeRouteId, reports = [] }: MapProps) {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) {
        return <div className="h-[350px] w-full bg-slate-100 animate-pulse flex items-center justify-center text-slate-400">Loading Map...</div>;
    }

    // City of Elmina center coordinates [lat, lng]
    const center: [number, number] = [3.1752, 101.5038];

    return (
        <MapContainer center={center} zoom={15} scrollWheelZoom={false} className="h-[350px] w-full rounded-2xl z-0 border border-slate-200 shadow-sm">
            <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            {routes.map((route) => {
                // Convert GeoJSON [lng, lat] to Leaflet [lat, lng]
                const positions: [number, number][] = route.coordinates.map(([lng, lat]) => [lat, lng]);

                const isActive = route.id === activeRouteId;

                let color = '#94a3b8'; // default gray
                if (route.route_type === 'coolest') color = '#16a34a'; // green
                if (route.route_type === 'direct') color = '#dc2626';  // red
                if (route.route_type === 'night_safe') color = '#2563eb'; // blue

                return (
                    <Polyline
                        key={route.id}
                        positions={positions}
                        pathOptions={{
                            color,
                            weight: isActive ? 7 : 4,
                            opacity: isActive ? 0.9 : 0.4,
                            dashArray: route.route_type === 'direct' ? '6, 8' : undefined,
                        }}
                    >
                        <Popup>
                            <div className="font-sans text-xs">
                                <p className="font-bold">{route.name}</p>
                                <p>Est. Surface Heat: {route.surface_temp_base_c}°C</p>
                                <p>Shade Coverage: {Math.round(route.shade_factor * 100)}%</p>
                            </div>
                        </Popup>
                    </Polyline>
                );
            })}

            {reports.map((rep) => (
                <Marker key={rep.id} position={[rep.latitude, rep.longitude]} icon={defaultIcon}>
                    <Popup>
                        <div className="text-xs">
                            <span className="font-bold text-red-600 uppercase">{rep.category.replace('_', ' ')}</span>
                            <p className="mt-1">{rep.description}</p>
                        </div>
                    </Popup>
                </Marker>
            ))}
        </MapContainer>
    );
}