-- memory-pgvector schema
-- Run as admin: psql -d mydb -f schema.sql

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL,
  text text NOT NULL,
  embedding vector(1536),
  category text DEFAULT 'other',
  importance float DEFAULT 0.7,
  source text DEFAULT 'manual',
  created_at timestamptz DEFAULT now(),
  fts_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);

CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS memories_fts_idx ON memories USING gin (fts_vector);
CREATE INDEX IF NOT EXISTS memories_agent_idx ON memories (agent_id);

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_isolation ON memories;
CREATE POLICY agent_isolation ON memories
  USING (agent_id = (SELECT current_setting('app.agent_id', true)))
  WITH CHECK (agent_id = (SELECT current_setting('app.agent_id', true)));
