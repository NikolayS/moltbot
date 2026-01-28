#!/usr/bin/env node
/**
 * Migrate memories from SQLite to PostgreSQL
 * Usage: node migrate-memories.mjs <sqlite-path> <agent-id>
 */

import { execSync } from 'child_process';
import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;

async function getEmbedding(text, apiKey) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: text, model: 'text-embedding-3-small' }),
  });
  
  if (!res.ok) throw new Error(`OpenAI error: ${res.status}`);
  const data = await res.json();
  return data.data[0].embedding;
}

function categorize(text, path) {
  const lower = text.toLowerCase();
  if (lower.includes('prefer') || lower.includes('favorite')) return 'preference';
  if (lower.includes('decided') || lower.includes('decision')) return 'decision';
  if (path.includes('contact') || /@\w+\.\w+/.test(text)) return 'entity';
  return 'fact';
}

async function main() {
  const [,, sqlitePath, agentId] = process.argv;
  
  if (!sqlitePath || !agentId) {
    console.log('Usage: node migrate-memories.mjs <sqlite-path> <agent-id>');
    process.exit(1);
  }
  
  const pgUrl = process.env.DATABASE_URL || 'postgresql://postgres:test@localhost:5433/postgres';
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    console.error('OPENAI_API_KEY required');
    process.exit(1);
  }
  
  console.log(`Migrating ${sqlitePath} → agent: ${agentId}`);
  
  // Read chunks from SQLite
  const json = execSync(`sqlite3 -json "${sqlitePath}" "SELECT id, path, text, updated_at FROM chunks"`, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024
  });
  
  const chunks = JSON.parse(json);
  console.log(`Found ${chunks.length} chunks`);
  
  // Connect to PostgreSQL
  const pool = new Pool({ connectionString: pgUrl });
  
  let imported = 0, skipped = 0, errors = 0;
  
  for (const chunk of chunks) {
    try {
      // Check if exists
      const existing = await pool.query(
        'SELECT id FROM memories WHERE agent_id = $1 AND text = $2',
        [agentId, chunk.text]
      );
      
      if (existing.rows.length > 0) {
        console.log(`  Skip (exists): ${chunk.text.slice(0, 50).replace(/\n/g, ' ')}...`);
        skipped++;
        continue;
      }
      
      console.log(`  Embedding: ${chunk.text.slice(0, 50).replace(/\n/g, ' ')}...`);
      
      // Get embedding
      const embedding = await getEmbedding(chunk.text, apiKey);
      
      // Insert
      const uuid = crypto.randomUUID();
      await pool.query(`
        INSERT INTO memories (id, agent_id, text, embedding, importance, category, source, metadata, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9))
      `, [
        uuid,
        agentId,
        chunk.text,
        `[${embedding.join(',')}]`,
        0.7,
        categorize(chunk.text, chunk.path),
        'migrated',
        JSON.stringify({ originalPath: chunk.path, originalId: chunk.id }),
        chunk.updated_at / 1000  // Convert ms to seconds
      ]);
      
      imported++;
      await new Promise(r => setTimeout(r, 300)); // Rate limit
      
    } catch (err) {
      console.error(`  Error: ${err.message}`);
      errors++;
    }
  }
  
  console.log(`\nDone: ${imported} imported, ${skipped} skipped, ${errors} errors`);
  await pool.end();
}

main().catch(console.error);
