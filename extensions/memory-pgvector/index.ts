/**
 * Clawdbot Memory (pgvector) Plugin
 *
 * Long-term memory with PostgreSQL + pgvector for vector search.
 * Provides seamless auto-recall and auto-capture via lifecycle hooks.
 * 
 * Features:
 * - Multi-tenancy with partitioned tables + RLS
 * - Multiple embedding providers (OpenAI, Gemini, Ollama, Mistral, Custom)
 * - Hybrid search (vector + full-text)
 * - Auto-capture and auto-recall
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { stringEnum } from "clawdbot/plugin-sdk";

import {
  parseConfig,
  vectorDimsForModel,
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryPgvectorConfig,
  type EmbeddingConfig,
} from "./config.js";
import { MemoryDB, type MemorySearchResult } from "./db.js";
import { shouldCapture, detectCategory } from "./capture.js";

// ============================================================================
// Embedding Cache
// ============================================================================

/** Simple LRU cache for embeddings to reduce API calls */
class EmbeddingCache {
  private cache = new Map<string, { vector: number[]; ts: number }>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize = 100, ttlMs = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(text: string): number[] | undefined {
    const entry = this.cache.get(text);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.cache.delete(text);
      return undefined;
    }
    return entry.vector;
  }

  set(text: string, vector: number[]): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next();
      if (!oldest.done && oldest.value) {
        this.cache.delete(oldest.value);
      }
    }
    this.cache.set(text, { vector, ts: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }
}

// ============================================================================
// Embedding Providers
// ============================================================================

interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

/**
 * OpenAI-compatible embedding provider
 * Works with: OpenAI, Ollama, vLLM, LiteLLM, Azure OpenAI, etc.
 */
class OpenAICompatibleEmbeddings implements EmbeddingProvider {
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(config: { baseUrl: string; apiKey?: string; model: string }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ""); // Remove trailing slash
    this.apiKey = config.apiKey ?? "dummy"; // Some local providers don't need API key
    this.model = config.model;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Embedding API error (${response.status}): ${errorText}`
      );
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
    };

    if (!data.data?.[0]?.embedding) {
      throw new Error("Invalid embedding response: missing data.data[0].embedding");
    }

    return data.data[0].embedding;
  }
}

/**
 * Google Gemini embedding provider
 */
class GeminiEmbeddings implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: { apiKey: string; model: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  }

  async embed(text: string): Promise<number[]> {
    const url = `${this.baseUrl}/models/${this.model}:embedContent?key=${this.apiKey}`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: `models/${this.model}`,
        content: {
          parts: [{ text }],
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Gemini embedding API error (${response.status}): ${errorText}`
      );
    }

    const data = await response.json() as {
      embedding?: { values: number[] };
    };

    if (!data.embedding?.values) {
      throw new Error("Invalid Gemini embedding response: missing embedding.values");
    }

    return data.embedding.values;
  }
}

/**
 * Create embedding provider based on configuration
 */
function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case "gemini":
      if (!config.apiKey) {
        throw new Error(
          "memory-pgvector: Gemini embeddings require GOOGLE_API_KEY or embedding.apiKey"
        );
      }
      return new GeminiEmbeddings({
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
      });

    case "openai":
    case "mistral":
    case "ollama":
    case "custom":
    default:
      // All these use OpenAI-compatible API
      return new OpenAICompatibleEmbeddings({
        baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
        apiKey: config.apiKey,
        model: config.model,
      });
  }
}

// ============================================================================
// Error Wrapper
// ============================================================================

async function withErrorHandling<T>(
  operation: string,
  fn: () => Promise<T>,
  logger: { warn: (msg: string) => void }
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const error = err as Error;
    const message = error.message ?? String(err);
    
    // Enhance error messages
    if (message.includes("ECONNREFUSED")) {
      throw new Error(
        `memory-pgvector: Cannot connect to PostgreSQL. ` +
        `Check that the database is running and connection settings are correct.`
      );
    }
    
    if (message.includes("authentication failed")) {
      throw new Error(
        `memory-pgvector: Database authentication failed. ` +
        `Check username and password in configuration.`
      );
    }
    
    if (message.includes("does not exist")) {
      throw new Error(
        `memory-pgvector: Database or table not found. ` +
        `The plugin will create tables automatically on first use.`
      );
    }
    
    if (message.includes("API") || message.includes("embedding")) {
      throw new Error(
        `memory-pgvector: Embedding API error during ${operation}: ${message}`
      );
    }
    
    logger.warn(`memory-pgvector: ${operation} failed: ${message}`);
    throw err;
  }
}

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryPgvectorPlugin = {
  id: "memory-pgvector",
  name: "Memory (pgvector)",
  description: "PostgreSQL + pgvector memory backend with hybrid search",
  kind: "memory" as const,

  register(api: ClawdbotPluginApi) {
    let cfg: MemoryPgvectorConfig;
    let db: MemoryDB;
    let embeddingsProvider: EmbeddingProvider;
    let vectorDims: number;
    let dbAvailable = true;
    const embeddingCache = new EmbeddingCache(100, 5 * 60 * 1000); // 100 entries, 5 min TTL

    // Cached embedding function
    const embed = async (text: string): Promise<number[]> => {
      const cached = embeddingCache.get(text);
      if (cached) return cached;
      const vector = await embeddingsProvider.embed(text);
      embeddingCache.set(text, vector);
      return vector;
    };

    // Parse configuration with helpful error messages
    try {
      cfg = parseConfig(api.pluginConfig);
    } catch (err) {
      const error = err as Error;
      api.logger.error(`memory-pgvector: Configuration error: ${error.message}`);
      throw err;
    }

    // Initialize embedding provider
    try {
      vectorDims = vectorDimsForModel(cfg.embedding.model, cfg.embedding.dimensions);
      embeddingsProvider = createEmbeddingProvider(cfg.embedding);
    } catch (err) {
      const error = err as Error;
      api.logger.error(`memory-pgvector: Embedding provider error: ${error.message}`);
      throw err;
    }

    // Initialize database
    try {
      db = new MemoryDB({
        connection: cfg.connection,
        connectionString: cfg.connectionString,
        vectorDims,
        indexType: cfg.indexType,
        ftsLanguage: cfg.ftsLanguage,
      });
    } catch (err) {
      const error = err as Error;
      api.logger.error(`memory-pgvector: Database initialization error: ${error.message}`);
      throw err;
    }

    // Get agent ID from context (fallback to "default")
    const getAgentId = (ctx?: { sessionKey?: string }): string => {
      const sessionKey = ctx?.sessionKey ?? "";
      const match = sessionKey.match(/^agent:([^:]+)/);
      return match?.[1] ?? "default";
    };

    api.logger.info(
      `memory-pgvector: registered (provider: ${cfg.embedding.provider}, ` +
      `model: ${cfg.embedding.model}, dims: ${vectorDims})`
    );

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "memory_recall",
        label: "Memory Recall (pgvector)",
        description:
          "Search through long-term memories stored in PostgreSQL. Use when you need context about user preferences, past decisions, or previously discussed topics.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
        }),
        async execute(_toolCallId, params, ctx) {
          const { query, limit } = params as { query: string; limit?: number };
          const agentId = getAgentId(ctx);

          return withErrorHandling("recall", async () => {
            const vector = await embed(query);
            const results = await db.search({
              agentId,
              embedding: vector,
              query,
              config: {
                ...cfg.search,
                limit: limit ?? cfg.search.limit,
              },
            });

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "No relevant memories found." }],
                details: { count: 0 },
              };
            }

            const text = results
              .map(
                (r, i) =>
                  `${i + 1}. [${r.entry.category}] ${r.entry.text} (${(r.score * 100).toFixed(0)}%)`
              )
              .join("\n");

            return {
              content: [
                { type: "text", text: `Found ${results.length} memories:\n\n${text}` },
              ],
              details: {
                count: results.length,
                memories: results.map((r) => ({
                  id: r.entry.id,
                  text: r.entry.text,
                  category: r.entry.category,
                  importance: r.entry.importance,
                  score: r.score,
                })),
              },
            };
          }, api.logger);
        },
      },
      { name: "memory_recall" }
    );

    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store (pgvector)",
        description:
          "Save important information in long-term memory (PostgreSQL). Use for preferences, facts, decisions.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          importance: Type.Optional(
            Type.Number({ description: "Importance 0-1 (default: 0.7)" })
          ),
          category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
        }),
        async execute(_toolCallId, params, ctx) {
          const {
            text,
            importance = 0.7,
            category = "other",
          } = params as {
            text: string;
            importance?: number;
            category?: MemoryCategory;
          };
          const agentId = getAgentId(ctx);

          return withErrorHandling("store", async () => {
            const vector = await embed(text);

            // Check for duplicates
            const existing = await db.findSimilar({
              agentId,
              embedding: vector,
              threshold: 0.95,
            });

            if (existing.length > 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Similar memory already exists: "${existing[0].entry.text}"`,
                  },
                ],
                details: {
                  action: "duplicate",
                  existingId: existing[0].entry.id,
                  existingText: existing[0].entry.text,
                },
              };
            }

            const entry = await db.store({
              agentId,
              text,
              embedding: vector,
              importance,
              category,
              source: "manual",
            });

            return {
              content: [{ type: "text", text: `Stored: "${text.slice(0, 100)}..."` }],
              details: { action: "created", id: entry.id },
            };
          }, api.logger);
        },
      },
      { name: "memory_store" }
    );

    api.registerTool(
      {
        name: "memory_forget",
        label: "Memory Forget (pgvector)",
        description: "Delete specific memories. GDPR-compliant.",
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Search to find memory" })),
          memoryId: Type.Optional(Type.String({ description: "Specific memory ID (UUID)" })),
        }),
        async execute(_toolCallId, params, ctx) {
          const { query, memoryId } = params as { query?: string; memoryId?: string };
          const agentId = getAgentId(ctx);

          return withErrorHandling("forget", async () => {
            if (memoryId) {
              // Fixed: Now passes agentId to ensure tenant isolation
              const deleted = await db.delete(memoryId, agentId);
              return {
                content: [
                  { type: "text", text: deleted ? `Memory ${memoryId} forgotten.` : "Memory not found." },
                ],
                details: { action: deleted ? "deleted" : "not_found", id: memoryId },
              };
            }

            if (query) {
              const vector = await embed(query);
              const results = await db.search({
                agentId,
                embedding: vector,
                query,
                config: { ...cfg.search, limit: 5 },
              });

              if (results.length === 0) {
                return {
                  content: [{ type: "text", text: "No matching memories found." }],
                  details: { found: 0 },
                };
              }

              if (results.length === 1 && results[0].score > 0.9) {
                await db.delete(results[0].entry.id, agentId);
                return {
                  content: [
                    { type: "text", text: `Forgotten: "${results[0].entry.text}"` },
                  ],
                  details: { action: "deleted", id: results[0].entry.id },
                };
              }

              const list = results
                .map((r) => `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}...`)
                .join("\n");

              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
                  },
                ],
                details: {
                  action: "candidates",
                  candidates: results.map((r) => ({
                    id: r.entry.id,
                    text: r.entry.text,
                    category: r.entry.category,
                    score: r.score,
                  })),
                },
              };
            }

            return {
              content: [{ type: "text", text: "Provide query or memoryId." }],
              details: { error: "missing_param" },
            };
          }, api.logger);
        },
      },
      { name: "memory_forget" }
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const pgmem = program
          .command("pgmem")
          .description("pgvector memory plugin commands");

        pgmem
          .command("stats")
          .description("Show memory statistics")
          .option("--agent <id>", "Agent ID", "default")
          .action(async (opts) => {
            try {
              const count = await db.count(opts.agent);
              console.log(`Total memories for agent '${opts.agent}': ${count}`);
            } catch (err) {
              console.error(`Error: ${(err as Error).message}`);
              process.exit(1);
            }
          });

        pgmem
          .command("search")
          .description("Search memories")
          .argument("<query>", "Search query")
          .option("--agent <id>", "Agent ID", "default")
          .option("--limit <n>", "Max results", "5")
          .action(async (query, opts) => {
            try {
              const vector = await embed(query);
              const results = await db.search({
                agentId: opts.agent,
                embedding: vector,
                query,
                config: { ...cfg.search, limit: parseInt(opts.limit, 10) },
              });

              console.log(
                JSON.stringify(
                  results.map((r) => ({
                    id: r.entry.id,
                    text: r.entry.text,
                    category: r.entry.category,
                    score: r.score,
                  })),
                  null,
                  2
                )
              );
            } catch (err) {
              console.error(`Error: ${(err as Error).message}`);
              process.exit(1);
            }
          });

        pgmem
          .command("health")
          .description("Check database connection")
          .action(async () => {
            const health = await db.healthCheck();
            if (health.ok) {
              console.log("✓ Database connection OK");
            } else {
              console.error(`✗ Database connection failed: ${health.error}`);
              process.exit(1);
            }
          });
      },
      { commands: ["pgmem"] }
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 5) return;
        if (!dbAvailable) return;

        try {
          const agentId = getAgentId(event);

          // Async recall with timeout to prevent blocking agent start
          const recallWithTimeout = async (): Promise<MemorySearchResult[]> => {
            const vector = await embed(event.prompt);
            return db.search({
              agentId,
              embedding: vector,
              query: event.prompt,
              config: { ...cfg.search, limit: 3 },
            });
          };

          // Race against timeout - fast-fail to keep agent responsive
          const timeoutMs = cfg.autoRecallTimeoutMs;
          const results = await Promise.race([
            recallWithTimeout(),
            new Promise<MemorySearchResult[]>((resolve) =>
              setTimeout(() => {
                api.logger.warn?.(
                  `memory-pgvector: auto-recall timed out after ${timeoutMs}ms`
                );
                resolve([]);
              }, timeoutMs)
            ),
          ]);

          if (results.length === 0) return;

          const memoryContext = results
            .map((r) => `- [${r.entry.category}] ${r.entry.text}`)
            .join("\n");

          api.logger.info?.(
            `memory-pgvector: injecting ${results.length} memories into context`
          );

          return {
            prependContext: `<relevant-memories>\nThe following memories may be relevant to this conversation:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`memory-pgvector: recall failed: ${String(err)}`);
          // Don't let memory failures break the agent
        }
      });
    }

    if (cfg.autoCapture) {
      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }
        if (!dbAvailable) return;

        // Define the capture logic as a separate async function
        const captureMemories = async (): Promise<void> => {
          const agentId = getAgentId(event);

          // Extract text from messages
          const texts: string[] = [];
          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;
            const role = msgObj.role;
            if (role !== "user" && role !== "assistant") continue;

            const content = msgObj.content;
            if (typeof content === "string") {
              texts.push(content);
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  "type" in block &&
                  (block as Record<string, unknown>).type === "text" &&
                  "text" in block
                ) {
                  texts.push((block as Record<string, unknown>).text as string);
                }
              }
            }
          }

          const toCapture = texts.filter((text) => text && shouldCapture(text));
          if (toCapture.length === 0) return;

          let stored = 0;
          for (const text of toCapture.slice(0, 3)) {
            const category = detectCategory(text);
            const vector = await embed(text);

            // Check for duplicates
            const existing = await db.findSimilar({
              agentId,
              embedding: vector,
              threshold: 0.95,
            });
            if (existing.length > 0) continue;

            await db.store({
              agentId,
              text,
              embedding: vector,
              importance: 0.7,
              category,
              source: "auto-capture",
            });
            stored++;
          }

          if (stored > 0) {
            api.logger.info(`memory-pgvector: auto-captured ${stored} memories`);
          }
        };

        // Fire-and-forget or blocking based on config
        if (cfg.asyncCapture) {
          // Don't await - run in background without blocking agent response
          void captureMemories().catch((err) =>
            api.logger.error(`memory-pgvector: async capture failed: ${(err as Error).message}`)
          );
        } else {
          // Legacy blocking behavior
          try {
            await captureMemories();
          } catch (err) {
            api.logger.warn(`memory-pgvector: capture failed: ${String(err)}`);
          }
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-pgvector",
      start: async () => {
        // Check database connectivity on startup
        const health = await db.healthCheck();
        if (!health.ok) {
          api.logger.warn(
            `memory-pgvector: Database not available (${health.error}). ` +
            `Memory features will be disabled until connection is restored.`
          );
          dbAvailable = false;
        } else {
          dbAvailable = true;
          api.logger.info(
            `memory-pgvector: initialized (provider: ${cfg.embedding.provider}, ` +
            `model: ${cfg.embedding.model})`
          );
        }
      },
      stop: async () => {
        embeddingCache.clear();
        await db.close();
        api.logger.info("memory-pgvector: stopped");
      },
    });
  },
};

export default memoryPgvectorPlugin;
