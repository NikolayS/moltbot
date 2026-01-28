/**
 * PostgreSQL + pgvector database operations
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import format from "pg-format";

type PoolClient = pg.PoolClient;

export interface Memory {
  id: string;
  agentId: string;
  text: string;
  category: string;
  importance: number;
  createdAt: Date;
}

export interface SearchResult {
  entry: Memory;
  score: number;
}

export class MemoryDB {
  private pool: pg.Pool;
  private ftsLang: string;
  private ready = false;

  constructor(opts: { connectionString?: string; ftsLanguage?: string }) {
    this.pool = new pg.Pool({ connectionString: opts.connectionString });
    this.ftsLang = opts.ftsLanguage ?? "english";
  }

  private async init(): Promise<void> {
    if (this.ready) return;
    const { rows } = await this.pool.query(
      "SELECT 1 FROM pg_tables WHERE tablename = 'memories' AND schemaname = 'public'"
    );
    if (!rows.length) throw new Error("memories table not found. Run schema.sql first.");
    this.ready = true;
  }

  private async tx<T>(agentId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.agent_id', $1, true)", [agentId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async store(p: {
    agentId: string;
    text: string;
    embedding: number[];
    category?: string;
    importance?: number;
    source?: string;
  }): Promise<Memory> {
    return this.tx(p.agentId, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO memories (id, agent_id, text, embedding, category, importance, source)
         VALUES ($1, $2, $3, $4::vector, $5, $6, $7) RETURNING *`,
        [randomUUID(), p.agentId, p.text, `[${p.embedding.join(",")}]`,
         p.category ?? "other", p.importance ?? 0.7, p.source ?? "manual"]
      );
      return this.toMemory(rows[0]);
    });
  }

  async search(p: {
    agentId: string;
    embedding: number[];
    query: string;
    limit?: number;
    minScore?: number;
  }): Promise<SearchResult[]> {
    const limit = p.limit ?? 5;
    const minScore = p.minScore ?? 0.3;
    const vec = `[${p.embedding.join(",")}]`;

    return this.tx(p.agentId, async (c) => {
      const { rows } = await c.query(
        format(
          `WITH vec AS (
            SELECT *, 1 - (embedding <=> $1::vector) as score FROM memories
            WHERE agent_id = $2 ORDER BY embedding <=> $1::vector LIMIT $3
          ), txt AS (
            SELECT *, ts_rank(fts_vector, plainto_tsquery(%L, $4)) as score FROM memories
            WHERE agent_id = $2 AND fts_vector @@ plainto_tsquery(%L, $4) LIMIT $3
          )
          SELECT DISTINCT ON (id) * FROM (SELECT * FROM vec UNION ALL SELECT * FROM txt) x
          ORDER BY id, score DESC`,
          this.ftsLang, this.ftsLang
        ),
        [vec, p.agentId, limit * 2, p.query]
      );
      return rows
        .map(r => ({ entry: this.toMemory(r), score: Number(r.score) }))
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    });
  }

  async findSimilar(p: { agentId: string; embedding: number[]; threshold: number }): Promise<SearchResult[]> {
    return this.tx(p.agentId, async (c) => {
      const { rows } = await c.query(
        `SELECT *, 1 - (embedding <=> $1::vector) as score FROM memories
         WHERE agent_id = $2 AND 1 - (embedding <=> $1::vector) >= $3 LIMIT 1`,
        [`[${p.embedding.join(",")}]`, p.agentId, p.threshold]
      );
      return rows.map(r => ({ entry: this.toMemory(r), score: Number(r.score) }));
    });
  }

  async delete(id: string, agentId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid ID");
    return this.tx(agentId, async (c) => {
      const { rowCount } = await c.query("DELETE FROM memories WHERE id = $1 AND agent_id = $2", [id, agentId]);
      return (rowCount ?? 0) > 0;
    });
  }

  async count(agentId: string): Promise<number> {
    return this.tx(agentId, async (c) => {
      const { rows } = await c.query("SELECT count(*)::int as n FROM memories WHERE agent_id = $1", [agentId]);
      return rows[0].n;
    });
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.pool.query("SELECT 1");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private toMemory(row: Record<string, unknown>): Memory {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      text: row.text as string,
      category: row.category as string,
      importance: Number(row.importance),
      createdAt: new Date(row.created_at as string),
    };
  }
}
