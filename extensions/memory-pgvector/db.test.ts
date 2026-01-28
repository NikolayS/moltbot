import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { MemoryDB } from "./db.js";

const TEST_URL = "postgresql://test:test@localhost:15432/memory_test";

describe("MemoryDB", () => {
  let db: MemoryDB;
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_URL });
    for (let i = 0; i < 10; i++) {
      try { await pool.query("SELECT 1"); break; }
      catch { await new Promise(r => setTimeout(r, 1000)); }
    }

    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await pool.query("DROP TABLE IF EXISTS memories CASCADE");
    await pool.query(`
      CREATE TABLE memories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id text NOT NULL, text text NOT NULL, embedding vector(3),
        category text DEFAULT 'other', importance float DEFAULT 0.7,
        source text DEFAULT 'manual', created_at timestamptz DEFAULT now(),
        fts_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
      )
    `);
    await pool.query("CREATE INDEX ON memories USING hnsw (embedding vector_cosine_ops)");
    await pool.query("CREATE INDEX ON memories USING gin (fts_vector)");
    await pool.query("ALTER TABLE memories ENABLE ROW LEVEL SECURITY");
    await pool.query("ALTER TABLE memories FORCE ROW LEVEL SECURITY");
    await pool.query(`CREATE POLICY agent_isolation ON memories
      USING (agent_id = (SELECT current_setting('app.agent_id', true)))
      WITH CHECK (agent_id = (SELECT current_setting('app.agent_id', true)))`);

    db = new MemoryDB({ connectionString: TEST_URL });
  });

  afterAll(async () => { await db?.close(); await pool?.end(); });
  beforeEach(async () => { await pool.query("TRUNCATE memories"); });

  it("stores and retrieves", async () => {
    const mem = await db.store({ agentId: "a1", text: "User prefers dark mode", embedding: [0.1, 0.2, 0.3] });
    expect(mem.id).toBeDefined();
    expect(mem.text).toBe("User prefers dark mode");
    expect(mem.importance).toBe(0.7);
  });

  it("searches with score", async () => {
    await db.store({ agentId: "a1", text: "PostgreSQL rocks", embedding: [1, 0, 0] });
    await db.store({ agentId: "a1", text: "Redis is fast", embedding: [0, 1, 0] });
    const results = await db.search({ agentId: "a1", embedding: [1, 0, 0], query: "PostgreSQL", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
    expect(results.some(r => r.entry.text.includes("PostgreSQL"))).toBe(true);
  });

  it("isolates agents", async () => {
    await db.store({ agentId: "alice", text: "Alice secret", embedding: [1, 0, 0] });
    await db.store({ agentId: "bob", text: "Bob secret", embedding: [1, 0, 0] });
    const alice = await db.search({ agentId: "alice", embedding: [1, 0, 0], query: "secret" });
    const bob = await db.search({ agentId: "bob", embedding: [1, 0, 0], query: "secret" });
    expect(alice.every(m => m.entry.agentId === "alice")).toBe(true);
    expect(bob.every(m => m.entry.agentId === "bob")).toBe(true);
  });

  it("finds similar for dedup", async () => {
    await db.store({ agentId: "a1", text: "Test memory", embedding: [0.5, 0.5, 0] });
    expect((await db.findSimilar({ agentId: "a1", embedding: [0.5, 0.5, 0], threshold: 0.9 })).length).toBe(1);
    expect((await db.findSimilar({ agentId: "a1", embedding: [0, 0, 1], threshold: 0.9 })).length).toBe(0);
  });

  it("deletes", async () => {
    const mem = await db.store({ agentId: "a1", text: "Delete me", embedding: [0.1, 0.1, 0.1] });
    expect(await db.delete(mem.id, "a1")).toBe(true);
    expect((await db.search({ agentId: "a1", embedding: [0.1, 0.1, 0.1], query: "delete" })).length).toBe(0);
  });

  it("prevents cross-agent deletion", async () => {
    const mem = await db.store({ agentId: "alice", text: "Alice only", embedding: [1, 0, 0] });
    expect(await db.delete(mem.id, "bob")).toBe(false);
  });

  it("counts", async () => {
    await db.store({ agentId: "a1", text: "One", embedding: [1, 0, 0] });
    await db.store({ agentId: "a1", text: "Two", embedding: [0, 1, 0] });
    expect(await db.count("a1")).toBe(2);
  });

  it("health checks", async () => {
    const h = await db.healthCheck();
    expect(h.ok).toBe(true);
  });

  it("rejects invalid UUID", async () => {
    await expect(db.delete("bad", "a1")).rejects.toThrow("Invalid ID");
  });
});
