/**
 * Integration tests for memory-pgvector
 * 
 * Requires: docker-compose -f docker-compose.test.yml up -d
 * Run: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MemoryDB } from "../db.js";
import { Pool } from "pg";

const TEST_CONNECTION = {
  host: "localhost",
  port: 15432,
  database: "memory_test",
  user: "test",
  password: "test",
};

// Skip if no database available
const describeWithDb = process.env.SKIP_DB_TESTS ? describe.skip : describe;

describeWithDb("MemoryDB Integration", () => {
  let db: MemoryDB;
  let rawPool: Pool;

  beforeAll(async () => {
    // Direct connection for setup/verification
    rawPool = new Pool(TEST_CONNECTION);
    
    // Wait for database
    let retries = 10;
    while (retries > 0) {
      try {
        await rawPool.query("SELECT 1");
        break;
      } catch {
        retries--;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (retries === 0) throw new Error("Database not available");

    // Create extension
    await rawPool.query("CREATE EXTENSION IF NOT EXISTS vector");

    db = new MemoryDB({
      connection: TEST_CONNECTION,
      vectorDims: 3,  // Small for testing
      indexType: "hnsw",
      ftsLanguage: "english",
    });
  });

  afterAll(async () => {
    await db?.close();
    await rawPool?.end();
  });

  beforeEach(async () => {
    // Clean up between tests - truncate instead of drop to preserve schema
    try {
      await rawPool.query("TRUNCATE memories");
    } catch {
      // Table might not exist yet, that's OK
    }
  });

  describe("Basic Operations", () => {
    it("should store and retrieve a memory", async () => {
      const entry = await db.store({
        agentId: "test-agent",
        text: "The user prefers dark mode",
        embedding: [0.1, 0.2, 0.3],
        importance: 0.8,
        category: "preference",
      });

      expect(entry.id).toBeDefined();
      expect(entry.text).toBe("The user prefers dark mode");
      expect(entry.category).toBe("preference");
    });

    it("should search by vector similarity", async () => {
      await db.store({
        agentId: "test-agent",
        text: "User likes PostgreSQL",
        embedding: [1.0, 0.0, 0.0],
      });
      await db.store({
        agentId: "test-agent",
        text: "User hates MongoDB",
        embedding: [0.0, 1.0, 0.0],
      });

      const results = await db.search({
        agentId: "test-agent",
        embedding: [0.9, 0.1, 0.0],  // Close to first
        query: "database",
        config: {
          hybrid: false,
          vectorWeight: 1.0,
          textWeight: 0.0,
          minScore: 0.0,
          limit: 10,
        },
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry.text).toContain("PostgreSQL");
    });

    it("should find similar memories for deduplication", async () => {
      await db.store({
        agentId: "test-agent",
        text: "User prefers vim",
        embedding: [0.5, 0.5, 0.0],
      });

      const similar = await db.findSimilar({
        agentId: "test-agent",
        embedding: [0.5, 0.5, 0.0],  // Exact match
        threshold: 0.95,
      });

      expect(similar.length).toBe(1);
      expect(similar[0].score).toBeGreaterThan(0.99);
    });

    it("should delete a memory", async () => {
      const entry = await db.store({
        agentId: "test-agent",
        text: "Temporary memory",
        embedding: [0.1, 0.1, 0.1],
      });

      const deleted = await db.delete(entry.id, "test-agent");
      expect(deleted).toBe(true);

      const count = await db.count("test-agent");
      expect(count).toBe(0);
    });
  });

  describe("Multi-Tenancy & Isolation", () => {
    it("should isolate memories between agents", async () => {
      // Agent 1 stores a memory
      await db.store({
        agentId: "agent-alice",
        text: "Alice's secret",
        embedding: [1.0, 0.0, 0.0],
      });

      // Agent 2 stores a memory
      await db.store({
        agentId: "agent-bob",
        text: "Bob's secret",
        embedding: [1.0, 0.0, 0.0],
      });

      // Alice should only see her memory
      const aliceResults = await db.search({
        agentId: "agent-alice",
        embedding: [1.0, 0.0, 0.0],
        query: "secret",
        config: { hybrid: false, vectorWeight: 1, textWeight: 0, minScore: 0, limit: 10 },
      });

      expect(aliceResults.length).toBe(1);
      expect(aliceResults[0].entry.text).toBe("Alice's secret");

      // Bob should only see his memory
      const bobResults = await db.search({
        agentId: "agent-bob",
        embedding: [1.0, 0.0, 0.0],
        query: "secret",
        config: { hybrid: false, vectorWeight: 1, textWeight: 0, minScore: 0, limit: 10 },
      });

      expect(bobResults.length).toBe(1);
      expect(bobResults[0].entry.text).toBe("Bob's secret");
    });

    it("should prevent cross-agent deletion", async () => {
      const aliceMemory = await db.store({
        agentId: "agent-alice",
        text: "Alice's protected data",
        embedding: [0.5, 0.5, 0.0],
      });

      // Bob tries to delete Alice's memory
      const deleted = await db.delete(aliceMemory.id, "agent-bob");
      expect(deleted).toBe(false);

      // Alice's memory should still exist
      const count = await db.count("agent-alice");
      expect(count).toBe(1);
    });

    it("should create separate partitions per agent", async () => {
      await db.store({
        agentId: "agent-one",
        text: "First agent",
        embedding: [0.1, 0.1, 0.1],
      });
      await db.store({
        agentId: "agent-two",
        text: "Second agent",
        embedding: [0.2, 0.2, 0.2],
      });

      // Check partitions exist
      const partitions = await rawPool.query(`
        SELECT inhrelid::regclass::text as name
        FROM pg_inherits
        WHERE inhparent = 'memories'::regclass
        ORDER BY name
      `);

      const names = partitions.rows.map((r) => r.name);
      expect(names).toContain("memories_default");
      expect(names.some((n) => n.includes("agent_one"))).toBe(true);
      expect(names.some((n) => n.includes("agent_two"))).toBe(true);
    });

    it("should handle many agents efficiently", async () => {
      const numAgents = 20;
      const start = Date.now();

      // Create memories for many agents
      for (let i = 0; i < numAgents; i++) {
        await db.store({
          agentId: `stress-agent-${i}`,
          text: `Memory for agent ${i}`,
          embedding: [i / numAgents, 0.5, 0.5],
        });
      }

      const elapsed = Date.now() - start;
      console.log(`Created ${numAgents} agents in ${elapsed}ms`);

      // Each agent should see only their memory
      for (let i = 0; i < numAgents; i++) {
        const count = await db.count(`stress-agent-${i}`);
        expect(count).toBe(1);
      }
    });
  });

  describe("Hybrid Search", () => {
    beforeEach(async () => {
      // Seed test data
      await db.store({
        agentId: "search-test",
        text: "PostgreSQL is a powerful relational database",
        embedding: [1.0, 0.0, 0.0],
      });
      await db.store({
        agentId: "search-test",
        text: "Redis is an in-memory data store",
        embedding: [0.0, 1.0, 0.0],
      });
      await db.store({
        agentId: "search-test",
        text: "MongoDB is a document database",
        embedding: [0.0, 0.0, 1.0],
      });
    });

    it("should combine vector and text search", async () => {
      const results = await db.search({
        agentId: "search-test",
        embedding: [0.8, 0.1, 0.1],  // Closest to PostgreSQL vector
        query: "database",  // Matches PostgreSQL and MongoDB text
        config: {
          hybrid: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          minScore: 0.0,
          limit: 10,
        },
      });

      expect(results.length).toBeGreaterThan(0);
      // PostgreSQL should rank highest (best vector + has "database")
      expect(results[0].entry.text).toContain("PostgreSQL");
    });

    it("should respect minScore threshold", async () => {
      const results = await db.search({
        agentId: "search-test",
        embedding: [1.0, 0.0, 0.0],
        query: "test",
        config: {
          hybrid: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          minScore: 0.99,  // Very high threshold
          limit: 10,
        },
      });

      // Only exact or near-exact matches should pass
      expect(results.length).toBeLessThanOrEqual(1);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty search results", async () => {
      const results = await db.search({
        agentId: "nonexistent-agent",
        embedding: [0.5, 0.5, 0.5],
        query: "anything",
        config: { hybrid: true, vectorWeight: 0.7, textWeight: 0.3, minScore: 0, limit: 10 },
      });

      expect(results).toEqual([]);
    });

    it("should reject invalid UUID for delete", async () => {
      await expect(db.delete("not-a-uuid", "test-agent")).rejects.toThrow(
        "Invalid memory ID format"
      );
    });

    it("should handle special characters in agent ID", async () => {
      const specialAgentId = "agent/with:special@chars!";
      
      await db.store({
        agentId: specialAgentId,
        text: "Special agent memory",
        embedding: [0.3, 0.3, 0.3],
      });

      const count = await db.count(specialAgentId);
      expect(count).toBe(1);
    });

    it("should handle unicode text", async () => {
      await db.store({
        agentId: "unicode-agent",
        text: "用户喜欢 PostgreSQL 🐘",
        embedding: [0.4, 0.4, 0.4],
      });

      const results = await db.search({
        agentId: "unicode-agent",
        embedding: [0.4, 0.4, 0.4],
        query: "PostgreSQL",
        config: { hybrid: true, vectorWeight: 0.5, textWeight: 0.5, minScore: 0, limit: 10 },
      });

      expect(results.length).toBe(1);
      expect(results[0].entry.text).toContain("🐘");
    });
  });

  describe("Health Check", () => {
    it("should return healthy when database is available", async () => {
      const health = await db.healthCheck();
      expect(health.ok).toBe(true);
    });
  });
});
