-- 1. Enable PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;

-- 2. Nodes Table (Path Nodes / Snapping points)
CREATE TABLE IF NOT EXISTS public.path_nodes (
    id BIGINT PRIMARY KEY,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    geom GEOMETRY(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)) STORED,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Edges Table (Footways, overpasses, zebra crossings)
CREATE TABLE IF NOT EXISTS public.path_edges (
    id BIGINT PRIMARY KEY,
    from_node BIGINT REFERENCES public.path_nodes(id) ON DELETE CASCADE,
    to_node BIGINT REFERENCES public.path_nodes(id) ON DELETE CASCADE,
    name TEXT,
    geometry JSONB NOT NULL, -- Array of [lng, lat] coordinates
    length_m DOUBLE PRECISION NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('footway', 'path', 'pedestrian', 'steps', 'street', 'crossing', 'service')),
    has_steps BOOLEAN DEFAULT FALSE,
    slope_pct DOUBLE PRECISION,
    surface_rating INT CHECK (surface_rating IN (1, 2, 3)), -- 1: smooth, 2: uneven, 3: broken
    is_crossing BOOLEAN DEFAULT FALSE,
    crossing_type TEXT CHECK (crossing_type IN ('signalised', 'zebra', 'uncontrolled')),
    crossing_width_m DOUBLE PRECISION,
    ped_green_s DOUBLE PRECISION,
    cycle_s DOUBLE PRECISION,
    has_kerb_ramp BOOLEAN,
    has_refuge BOOLEAN,
    shade_morning DOUBLE PRECISION,
    shade_midday DOUBLE PRECISION,
    shade_afternoon DOUBLE PRECISION,
    shade_source TEXT CHECK (shade_source IN ('audited', 'reported', 'modelled', 'assumed')),
    lit_ratio DOUBLE PRECISION,
    lighting_source TEXT CHECK (lighting_source IN ('audited', 'reported', 'modelled', 'assumed')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Citizen Hazard Reports Table
CREATE TABLE IF NOT EXISTS public.hazard_reports (
    id BIGSERIAL PRIMARY KEY,
    edge_id BIGINT REFERENCES public.path_edges(id) ON DELETE SET NULL,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('blocked', 'no_ramp', 'light_out', 'no_shade', 'broken_surface')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'verified', 'fixed')),
    reporter_role TEXT DEFAULT 'resident',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Defect Reports Table (For Management Dashboard)
CREATE TABLE IF NOT EXISTS public.defect_reports (
    id BIGSERIAL PRIMARY KEY,
    edge_id BIGINT REFERENCES public.path_edges(id) ON DELETE SET NULL,
    description TEXT,
    severity TEXT DEFAULT 'comfort' CHECK (severity IN ('blocker', 'comfort')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Spatial and Performance Indexes
CREATE INDEX IF NOT EXISTS idx_path_nodes_geom ON public.path_nodes USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_path_edges_from ON public.path_edges(from_node);
CREATE INDEX IF NOT EXISTS idx_path_edges_to ON public.path_edges(to_node);
CREATE INDEX IF NOT EXISTS idx_hazard_reports_status ON public.hazard_reports(status);