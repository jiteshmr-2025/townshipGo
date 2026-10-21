import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Auto-load .env.local if variables are missing
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    try {
        const envPath = path.resolve(process.cwd(), '.env.local');
        if (fs.existsSync(envPath)) {
            const envConfig = fs.readFileSync(envPath, 'utf8');
            envConfig.split('\n').forEach((line) => {
                const [key, ...value] = line.split('=');
                if (key && value.length > 0) {
                    process.env[key.trim()] = value.join('=').trim().replace(/^["']|["']$/g, '');
                }
            });
        }
    } catch (err) {
        console.warn('Could not auto-load .env.local file');
    }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Error: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_KEY in .env.local');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function seedGraph() {
    const jsonPath = path.resolve(process.cwd(), 'graph.json');
    if (!fs.existsSync(jsonPath)) {
        console.error('❌ Error: graph.json not found in project root. Run osm-to-graph.mjs first.');
        process.exit(1);
    }

    console.log('📖 Reading graph.json...');
    const { nodes, edges } = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    const BATCH_SIZE = 200;

    // 1. Upload Path Nodes
    console.log(`📡 Uploading ${nodes.length} nodes to path_nodes...`);
    for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
        const batch = nodes.slice(i, i + BATCH_SIZE);
        const { error } = await supabase.from('path_nodes').upsert(batch);
        if (error) {
            console.error(`❌ Failed on nodes batch ${i}-${i + batch.length}:`, error.message);
            process.exit(1);
        }
        console.log(`   Progress: ${Math.min(i + BATCH_SIZE, nodes.length)} / ${nodes.length} nodes uploaded`);
    }

    // 2. Upload Path Edges
    console.log(`📡 Uploading ${edges.length} edges to path_edges...`);
    for (let i = 0; i < edges.length; i += BATCH_SIZE) {
        const batch = edges.slice(i, i + BATCH_SIZE);
        const { error } = await supabase.from('path_edges').upsert(batch);
        if (error) {
            console.error(`❌ Failed on edges batch ${i}-${i + batch.length}:`, error.message);
            process.exit(1);
        }
        console.log(`   Progress: ${Math.min(i + BATCH_SIZE, edges.length)} / ${edges.length} edges uploaded`);
    }

    console.log('✅ Graph successfully seeded into Supabase!');
}

seedGraph();