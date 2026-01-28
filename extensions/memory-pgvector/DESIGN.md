# Clawdbot Memory Plugin: pgvector

## Overview

A memory plugin for Clawdbot that stores embeddings in PostgreSQL + pgvector instead of the default sqlite-vec/LanceDB backends.

**Why pgvector?**
- PostgresAI brand alignment (we eat our own dogfood)
- Production-ready vector search at scale
- Full PostgreSQL ecosystem (replication, backups, extensions)
- Remote storage - memories persist across machines
- Hybrid search via PostgreSQL's built-in full-text search (tsvector)

## Architecture Decision

After reviewing the existing implementations:

1. **memory-core** - Thin wrapper that delegates to `api.runtime.tools` (uses core sqlite-vec)
2. **memory-lancedb** - Full standalone implementation with LanceDB vector store

**Approach: Full standalone implementation (like memory-lancedb)**

Rationale:
- The core memory system is tightly coupled to SQLite
- A plugin can't easily swap just the vector store without forking core code
- LanceDB plugin proves this pattern works well
- Full control over schema, queries, and features

## Design

### Plugin Structure

```
extensions/memory-pgvector/
├── clawdbot.plugin.json    # Plugin manifest
├── package.json            # npm package config
├── index.ts                # Main plugin entry
├── config.ts               # Configuration schema & types
├── db.ts                   # PostgreSQL/pgvector operations
├── embeddings.ts           # Embedding provider wrapper
└── README.md               # Usage documentation
```

### Database Schema

```sql
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Main memories table
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding vector(1536),  -- dimension matches embedding model
  importance FLOAT DEFAULT 0.7,
  category TEXT DEFAULT 'other',
  source TEXT DEFAULT 'manual',  -- 'manual', 'auto-capture', 'session'
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vector similarity index (IVFFlat or HNSW)
CREATE INDEX IF NOT EXISTS memories_embedding_idx 
  ON memories USING hnsw (embedding vector_cosine_ops);

-- Full-text search index for hybrid search
ALTER TABLE memories ADD COLUMN IF NOT EXISTS fts_vector tsvector 
  GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;
CREATE INDEX IF NOT EXISTS memories_fts_idx ON memories USING GIN (fts_vector);

-- Agent isolation
CREATE INDEX IF NOT EXISTS memories_agent_idx ON memories (agent_id);

-- Category filtering
CREATE INDEX IF NOT EXISTS memories_category_idx ON memories (category);
```

### Configuration

```json5
{
  plugins: {
    entries: {
      "memory-pgvector": {
        enabled: true,
        config: {
          // PostgreSQL connection
          connection: {
            host: "localhost",
            port: 5432,
            database: "clawdbot_memory",
            user: "clawdbot",
            password: "${PGVECTOR_PASSWORD}",  // env var support
            ssl: false  // or { rejectUnauthorized: false }
          },
          // Alternative: connection string
          // connectionString: "${DATABASE_URL}",
          
          // Embedding configuration
          embedding: {
            provider: "openai",  // or "gemini"
            model: "text-embedding-3-small",
            apiKey: "${OPENAI_API_KEY}"
          },
          
          // Features
          autoCapture: true,    // Auto-capture from conversations
          autoRecall: true,     // Inject relevant memories into context
          
          // Search tuning
          search: {
            hybrid: true,       // Enable hybrid (vector + full-text) search
            vectorWeight: 0.7,
            textWeight: 0.3,
            minScore: 0.3,
            limit: 5
          },
          
          // Vector index type
          indexType: "hnsw"  // or "ivfflat"
        }
      }
    },
    slots: {
      memory: "memory-pgvector"
    }
  }
}
```

### Tools

| Tool | Description |
|------|-------------|
| `memory_recall` | Semantic search through memories |
| `memory_store` | Save information to long-term memory |
| `memory_forget` | Delete memories (GDPR-compliant) |

Same interface as memory-lancedb for familiarity.

### Lifecycle Hooks

1. **`before_agent_start`** - Auto-recall: inject relevant memories based on user prompt
2. **`agent_end`** - Auto-capture: extract and store important information from conversations

### Embedding Providers

Reuse pattern from memory-lancedb:
- OpenAI (`text-embedding-3-small`, `text-embedding-3-large`)
- Gemini (`gemini-embedding-001`)
- Future: local embeddings via node-llama-cpp

### Hybrid Search Algorithm

```sql
-- Combine vector similarity and full-text relevance
WITH vector_results AS (
  SELECT id, text, category, importance, created_at,
         1 - (embedding <=> $1) AS vector_score
  FROM memories
  WHERE agent_id = $2
  ORDER BY embedding <=> $1
  LIMIT $3 * 4  -- candidate multiplier
),
text_results AS (
  SELECT id, text, category, importance, created_at,
         ts_rank(fts_vector, plainto_tsquery('english', $4)) AS text_score
  FROM memories
  WHERE agent_id = $2 AND fts_vector @@ plainto_tsquery('english', $4)
  ORDER BY text_score DESC
  LIMIT $3 * 4
)
SELECT DISTINCT ON (id)
  COALESCE(v.id, t.id) AS id,
  COALESCE(v.text, t.text) AS text,
  COALESCE(v.category, t.category) AS category,
  ($5 * COALESCE(v.vector_score, 0) + $6 * COALESCE(t.text_score, 0)) AS score
FROM vector_results v
FULL OUTER JOIN text_results t USING (id)
ORDER BY score DESC
LIMIT $3;
```

## Implementation Plan

### Phase 1: Core Infrastructure (MVP)
- [ ] Plugin scaffold (manifest, package.json, config schema)
- [ ] PostgreSQL connection management (pg library)
- [ ] Schema migrations (auto-create tables on first run)
- [ ] Embedding wrapper (OpenAI only initially)
- [ ] Basic vector search (without hybrid)

### Phase 2: Tools & Lifecycle
- [ ] `memory_store` tool
- [ ] `memory_recall` tool  
- [ ] `memory_forget` tool
- [ ] Auto-recall hook (`before_agent_start`)
- [ ] Auto-capture hook (`agent_end`)
- [ ] Duplicate detection (similarity threshold)

### Phase 3: Hybrid Search & Polish
- [ ] Full-text search with tsvector
- [ ] Hybrid search merging
- [ ] CLI commands (`clawdbot pgmem list/search/stats`)
- [ ] Connection pooling
- [ ] Gemini embedding support

### Phase 4: Production Hardening
- [ ] SSL/TLS connection support
- [ ] Connection string parsing
- [ ] Error handling & retries
- [ ] Tests
- [ ] Documentation

## Dependencies

```json
{
  "dependencies": {
    "pg": "^8.13.0",
    "openai": "^4.0.0",
    "@sinclair/typebox": "^0.32.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0"
  }
}
```

## Blockers & Questions

### Resolved
- ✅ Plugin architecture is clear from docs + memory-lancedb example
- ✅ Embedding reuse: Can use OpenAI SDK directly (like memory-lancedb does)
- ✅ Tool registration: Via `api.registerTool()`

### Open Questions
1. **Multi-agent isolation**: Should we use a single table with `agent_id` column, or separate tables per agent?
   - **Recommendation**: Single table with index on `agent_id` (simpler, scales fine)

2. **Vector dimensions**: Should we auto-detect from model or require explicit config?
   - **Recommendation**: Map from model name (like memory-lancedb does)

3. **Connection pooling**: Use `pg` Pool directly or a higher-level abstraction?
   - **Recommendation**: `pg.Pool` with reasonable defaults (max 10 connections)

4. **Index type**: HNSW vs IVFFlat?
   - **Recommendation**: Default to HNSW (faster queries, no training needed), option for IVFFlat

### Potential Blockers
1. **pgvector extension availability**: User must have pgvector installed on their Postgres instance
   - Mitigation: Clear error messages, setup instructions in docs

2. **Embedding API costs**: OpenAI/Gemini API calls cost money
   - Mitigation: Implement caching (hash-based, like core memory does)

## Testing Plan

1. **Local Postgres**: Docker container with pgvector for development
   ```bash
   docker run -d --name pgvector-test \
     -e POSTGRES_PASSWORD=test \
     -p 5433:5432 \
     pgvector/pgvector:pg16
   ```

2. **TARS as first tester**: Deploy to TARS once MVP works

## Files to Create

1. `extensions/memory-pgvector/clawdbot.plugin.json`
2. `extensions/memory-pgvector/package.json`
3. `extensions/memory-pgvector/index.ts`
4. `extensions/memory-pgvector/config.ts`
5. `extensions/memory-pgvector/db.ts`
6. `extensions/memory-pgvector/README.md`

---

**Status**: Ready for implementation
**Estimated effort**: 2-3 days for MVP, 1 week for full feature parity with memory-lancedb

## RLS Performance Optimization (from Nik)

**Critical:** Use subquery in RLS policy for InitPlan optimization:

```sql
-- ❌ Wrong (evaluates per row - slow):
USING (agent_id = current_setting('app.agent_id', true))

-- ✅ Correct (InitPlan, evaluates once - 100x faster):
USING (agent_id = (SELECT current_setting('app.agent_id', true)))
```

Reference: https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices
