/**
 * Migration tool: Import memories from memory-core SQLite to memory-pgvector
 * Re-embeds text with configured model (dimensions may differ)
 * 
 * Usage: npx ts-node migrate.ts <sqlite-path> <agent-id> [--dry-run]
 */

import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

interface Chunk {
  id: string;
  path: string;
  text: string;
  updated_at: number;
}

async function getEmbedding(text: string, apiKey: string, model = 'text-embedding-3-small'): Promise<number[]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: text, model }),
  });
  
  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.data[0].embedding;
}

function categorize(text: string, path: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('prefer') || lower.includes('like') || lower.includes('want')) {
    return 'preference';
  }
  if (lower.includes('decided') || lower.includes('decision') || lower.includes('chose')) {
    return 'decision';
  }
  if (path.includes('contact') || lower.includes('@') || lower.includes('email:')) {
    return 'entity';
  }
  return 'fact';
}

async function migrate(
  sqlitePath: string,
  agentId: string,
  connectionString: string,
  apiKey: string,
  dryRun = false
) {
  console.log(`Migrating ${sqlitePath} → agent_id: ${agentId}`);
  
  // Read from SQLite
  const sqlite = new Database(sqlitePath, { readonly: true });
  const chunks: Chunk[] = sqlite.prepare(`
    SELECT id, path, text, updated_at FROM chunks ORDER BY updated_at
  `).all() as Chunk[];
  
  console.log(`Found ${chunks.length} chunks`);
  
  if (dryRun) {
    console.log('Dry run - would import:');
    for (const chunk of chunks.slice(0, 5)) {
      const cat = categorize(chunk.text, chunk.path);
      console.log(`  [${cat}] ${chunk.path}: ${chunk.text.slice(0, 80).replace(/\n/g, ' ')}...`);
    }
    sqlite.close();
    return;
  }
  
  // Connect to PostgreSQL
  const pool = new Pool({ connectionString });
  
  // Ensure partition exists
  const partitionName = `memories_agent_${agentId.replace(/[^a-z0-9]/gi, '_')}`;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${partitionName} PARTITION OF memories FOR VALUES IN ($1)
  `, [agentId]).catch(() => {
    // Partition may already exist
  });
  
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  
  for (const chunk of chunks) {
    try {
      // Check if already exists
      const existing = await pool.query(
        `SELECT id FROM memories WHERE agent_id = $1 AND text = $2`,
        [agentId, chunk.text]
      );
      
      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }
      
      // Get new embedding
      console.log(`  Embedding: ${chunk.text.slice(0, 50).replace(/\n/g, ' ')}...`);
      const embedding = await getEmbedding(chunk.text, apiKey);
      
      // Insert
      await pool.query(`
        INSERT INTO memories (id, agent_id, text, embedding, importance, category, source, metadata, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        uuidv4(),
        agentId,
        chunk.text,
        `[${embedding.join(',')}]`,
        0.7,
        categorize(chunk.text, chunk.path),
        'migrated',
        JSON.stringify({ originalPath: chunk.path, originalId: chunk.id }),
        new Date(chunk.updated_at)
      ]);
      
      imported++;
      
      // Rate limit: ~3 req/sec
      await new Promise(r => setTimeout(r, 350));
    } catch (err) {
      console.error(`  Error: ${err}`);
      errors++;
    }
  }
  
  console.log(`\nDone: ${imported} imported, ${skipped} skipped, ${errors} errors`);
  
  sqlite.close();
  await pool.end();
}

// CLI
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: npx ts-node migrate.ts <sqlite-path> <agent-id> [--dry-run]');
  console.log('');
  console.log('Environment:');
  console.log('  DATABASE_URL - PostgreSQL connection string');
  console.log('  OPENAI_API_KEY - For re-embedding text');
  process.exit(1);
}

const sqlitePath = args[0];
const agentId = args[1];
const dryRun = args.includes('--dry-run');
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:test@localhost:5433/postgres';
const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey && !dryRun) {
  console.error('Error: OPENAI_API_KEY required for re-embedding');
  process.exit(1);
}

migrate(sqlitePath, agentId, connectionString, apiKey!, dryRun).catch(console.error);
