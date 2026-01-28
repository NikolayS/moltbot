# @clawdbot/memory-pgvector

PostgreSQL + pgvector memory backend for Clawdbot with multi-agent isolation.

## Features

- **Vector search** via pgvector extension (HNSW or IVFFlat indexes)
- **Hybrid search** combining semantic similarity + PostgreSQL full-text search
- **Multi-agent isolation** with partitioned tables and Row Level Security (RLS)
- **Multiple embedding providers** (OpenAI, Gemini, Ollama, Mistral, custom)
- **Auto-recall** - automatically inject relevant memories into conversations
- **Auto-capture** - automatically store important information from chats
- **GDPR-compliant** - delete memories on demand

## Requirements

- PostgreSQL 14+ with pgvector extension
- API key for your chosen embedding provider (except Ollama)

### Installing pgvector

**Docker (easiest):**
```bash
docker run -d --name pgvector \
  -e POSTGRES_PASSWORD=yourpassword \
  -e POSTGRES_DB=clawdbot_memory \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

**Native:**
```bash
# macOS
brew install pgvector

# Ubuntu/Debian
sudo apt install postgresql-16-pgvector
```

Then enable the extension:
```sql
create extension vector;
```

## Installation

```bash
clawdbot plugins install @clawdbot/memory-pgvector
```

Or link for development:
```bash
clawdbot plugins install -l ./path/to/memory-pgvector
```

## Configuration

Add to your Clawdbot config:

```json5
{
  plugins: {
    entries: {
      "memory-pgvector": {
        enabled: true,
        config: {
          // PostgreSQL connection
          connectionString: "${DATABASE_URL}",
          // Or use individual fields:
          // connection: {
          //   host: "localhost",
          //   port: 5432,
          //   database: "clawdbot_memory",
          //   user: "clawdbot",
          //   password: "${PGVECTOR_PASSWORD}"
          // },
          
          // Embedding configuration (see provider examples below)
          embedding: {
            provider: "openai",
            model: "text-embedding-3-small",
            apiKey: "${OPENAI_API_KEY}"
          },
          
          // Features (both default to true)
          autoCapture: true,
          autoRecall: true,
          
          // Search settings
          search: {
            hybrid: true,       // Use both vector + full-text
            vectorWeight: 0.7,  // Weight for semantic similarity
            textWeight: 0.3,    // Weight for keyword match
            minScore: 0.3,      // Minimum score threshold
            limit: 5            // Max results
          },
          
          // Index type (default: hnsw)
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

## Embedding Providers

### OpenAI (default)

```json5
embedding: {
  provider: "openai",
  model: "text-embedding-3-small",  // or "text-embedding-3-large"
  apiKey: "${OPENAI_API_KEY}"
}
```

| Model | Dimensions | Notes |
|-------|------------|-------|
| `text-embedding-3-small` | 1536 | Good balance of quality/cost |
| `text-embedding-3-large` | 3072 | Higher quality, more storage |
| `text-embedding-ada-002` | 1536 | Legacy model |

### Google Gemini

```json5
embedding: {
  provider: "gemini",
  model: "text-embedding-004",
  apiKey: "${GOOGLE_API_KEY}"  // or GEMINI_API_KEY
}
```

| Model | Dimensions | Notes |
|-------|------------|-------|
| `text-embedding-004` | 768 | Latest Gemini embedding |
| `embedding-001` | 768 | Older model |

### Ollama (local)

No API key required! Great for local development or air-gapped environments.

```json5
embedding: {
  provider: "ollama",
  model: "nomic-embed-text",
  baseUrl: "http://localhost:11434/v1"  // default
}
```

| Model | Dimensions | Notes |
|-------|------------|-------|
| `nomic-embed-text` | 768 | Good general-purpose |
| `mxbai-embed-large` | 1024 | Higher quality |
| `all-minilm` | 384 | Small and fast |
| `bge-m3` | 1024 | Multilingual |
| `snowflake-arctic-embed` | 1024 | Latest |

**Install a model:**
```bash
ollama pull nomic-embed-text
```

### Mistral

```json5
embedding: {
  provider: "mistral",
  model: "mistral-embed",
  apiKey: "${MISTRAL_API_KEY}"
}
```

### Custom (OpenAI-compatible)

For vLLM, LiteLLM, Azure OpenAI, or any OpenAI-compatible endpoint:

```json5
embedding: {
  provider: "custom",
  model: "your-model-name",
  baseUrl: "https://your-endpoint.com/v1",
  apiKey: "${YOUR_API_KEY}",  // optional for some providers
  dimensions: 1024  // specify if model isn't auto-detected
}
```

## Usage

### Tools

The plugin provides three tools for the AI agent:

| Tool | Description |
|------|-------------|
| `memory_recall` | Search memories by semantic similarity |
| `memory_store` | Save information to long-term memory |
| `memory_forget` | Delete specific memories |

### CLI Commands

```bash
# Show memory stats
clawdbot pgmem stats --agent default

# Search memories
clawdbot pgmem search "user preferences" --agent samjr --limit 10

# Check database health
clawdbot pgmem health
```

### Example Conversation

**User:** Remember that I prefer dark mode in all applications.

**Agent:** *(uses memory_store)* I've saved that preference to memory.

**User:** What do I prefer for UI themes?

**Agent:** *(uses memory_recall)* Based on my memories, you prefer dark mode in all applications.

## Multi-Agent Architecture

When multiple agents share the same PostgreSQL instance, each agent's memories are isolated:

```
┌─────────────────────────────────────────────────────────┐
│                   PostgreSQL Instance                   │
├─────────────────────────────────────────────────────────┤
│                    memories (partitioned)               │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐     │
│  │ memories_tars│ │memories_samjr│ │memories_smith│     │
│  │  (TARS data) │ │ (Sam Jr data)│ │ (Smith data) │     │
│  └──────────────┘ └──────────────┘ └──────────────┘     │
│                                                         │
│  + Row Level Security (RLS) for defense in depth        │
│  + Per-partition HNSW indexes for optimal performance   │
└─────────────────────────────────────────────────────────┘
```

### Isolation guarantees

1. **Partitioned tables** - Each agent gets its own partition for performance
2. **Explicit `agent_id` checks** - All queries filter by agent
3. **Row Level Security** - Database-level enforcement via RLS policies
4. **Delete protection** - Cannot delete memories belonging to other agents

## Migration

### From non-partitioned table

If you have an existing `memories` table without partitions, the plugin will:
1. Detect the legacy schema
2. Add missing columns (e.g., `fts_vector`)
3. Create indexes if missing
4. Continue operating in legacy mode

To migrate to partitioned tables:
```sql
-- 1. Export existing data
create table memories_backup as select * from memories;

-- 2. Drop old table
drop table memories;

-- 3. Restart plugin (creates new partitioned table)

-- 4. Import data
insert into memories select * from memories_backup;

-- 5. Cleanup
drop table memories_backup;
```

### Changing embedding models

When switching to a model with different dimensions:
1. Back up your data
2. Drop the `memories` table
3. Update configuration with new model
4. Restart plugin (creates table with new dimensions)
5. Re-embed your data (memories will need to be re-stored)

## Troubleshooting

### "Cannot connect to PostgreSQL"

1. Check PostgreSQL is running: `pg_isready -h localhost -p 5432`
2. Verify credentials in config
3. Test with: `psql <your-connection-string>`

### "pgvector extension not found"

Install pgvector for your PostgreSQL version:
```bash
# Check installed
psql -c "SELECT * FROM pg_extension WHERE extname = 'vector'"

# Install
psql -c "CREATE EXTENSION vector"
```

### "Embedding API error"

1. Verify API key is set correctly
2. Check provider status (OpenAI status page, etc.)
3. For Ollama, ensure the model is pulled: `ollama list`

### Slow vector search

1. Check index exists: `\di memories_*_embedding_idx`
2. Consider switching to HNSW (default) if using IVFFlat
3. Reduce `search.limit` if returning too many results

### High memory usage

1. Reduce connection pool size in config
2. Use smaller embedding model (fewer dimensions)
3. Consider IVFFlat instead of HNSW (less memory, slightly slower)

## Development

```bash
# Clone and link
git clone https://github.com/postgres-ai/clawdbot-memory-pgvector
cd clawdbot-memory-pgvector
npm install

# Run tests (requires PostgreSQL with pgvector)
DATABASE_URL=postgresql://postgres:test@localhost:5432/postgres npm test

# Type check
npm run typecheck

# Link to Clawdbot
clawdbot plugins install -l .
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Clawdbot Agent                       │
├─────────────────────────────────────────────────────────┤
│  memory_recall  │  memory_store  │  memory_forget       │
├─────────────────────────────────────────────────────────┤
│                  memory-pgvector plugin                 │
│  ┌───────────────┐  ┌────────────────────────────────┐  │
│  │  Embeddings   │  │         PostgreSQL             │  │
│  │ ┌───────────┐ │  │  ┌──────────┐  ┌───────────┐   │  │
│  │ │  OpenAI   │ │  │  │ pgvector │  │ Full-Text │   │  │
│  │ │  Gemini   │ │  │  │ (HNSW)   │  │ (tsvector)│   │  │
│  │ │  Ollama   │ │  │  └──────────┘  └───────────┘   │  │
│  │ │  Custom   │ │  │                                │  │
│  │ └───────────┘ │  │  + Partitioning + RLS          │  │
│  └───────────────┘  └────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## License

MIT
