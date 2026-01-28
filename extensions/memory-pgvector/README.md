# memory-pgvector

PostgreSQL + pgvector memory backend for Clawdbot.

## Setup

```bash
# 1. Run schema (as admin)
psql -d mydb -f schema.sql

# 2. Configure
export DATABASE_URL="postgresql://user:pass@localhost/mydb"
export OPENAI_API_KEY="sk-..."
```

## Config

```json
{
  "memory-pgvector": {
    "enabled": true,
    "config": {
      "connectionString": "${DATABASE_URL}",
      "embedding": {
        "model": "text-embedding-3-small",
        "apiKey": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

## Tools

- `memory_recall` - Search memories
- `memory_store` - Save memory
- `memory_forget` - Delete memory
