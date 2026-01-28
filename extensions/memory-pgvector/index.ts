/**
 * memory-pgvector: PostgreSQL + pgvector memory backend
 */
import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { MemoryDB, SearchResult } from "./db.js";

// Types
const CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
type Category = typeof CATEGORIES[number];
type Provider = "openai" | "gemini" | "ollama" | "mistral" | "custom";

interface Config {
  connectionString?: string;
  embedding: { provider?: Provider; model?: string; apiKey?: string; baseUrl?: string };
  ftsLanguage?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  autoRecallTimeoutMs?: number;
}

// Embedding dimensions by model
const DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536, "text-embedding-3-large": 3072, "text-embedding-ada-002": 1536,
  "text-embedding-004": 768, "mistral-embed": 1024, "nomic-embed-text": 768,
};

const BASE_URLS: Record<Provider, string> = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  ollama: "http://localhost:11434/v1",
  mistral: "https://api.mistral.ai/v1",
  custom: "",
};

// Embedding cache
const cache = new Map<string, { vec: number[]; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(text: string): number[] | undefined {
  const e = cache.get(text);
  if (!e || Date.now() - e.ts > CACHE_TTL) { cache.delete(text); return undefined; }
  return e.vec;
}

function setCache(text: string, vec: number[]): void {
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  cache.set(text, { vec, ts: Date.now() });
}

// Embedding API
async function embedOpenAI(text: string, model: string, apiKey: string, baseUrl: string): Promise<number[]> {
  const res = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: text }),
  });
  if (!res.ok) throw new Error(`Embedding API error: ${res.status}`);
  const data = await res.json() as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}

async function embedGemini(text: string, model: string, apiKey: string, baseUrl: string): Promise<number[]> {
  const res = await fetch(`${baseUrl}/models/${model}:embedContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: `models/${model}`, content: { parts: [{ text }] } }),
  });
  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
  const data = await res.json() as { embedding: { values: number[] } };
  return data.embedding.values;
}

// Auto-capture patterns
const CAPTURE_TRIGGERS = [
  /remember|zapamatuj|pamatuj/i, /prefer|radši|nechci/i, /my .+ is|je můj/i,
  /i (like|love|hate|want|need)/i, /always|never|important/i,
];

function shouldCapture(text: string): boolean {
  if (text.length < 10 || text.length > 500) return false;
  if (text.includes("<") || text.includes("**")) return false;
  return CAPTURE_TRIGGERS.some(r => r.test(text));
}

function detectCategory(text: string): Category {
  const t = text.toLowerCase();
  if (/prefer|like|love|hate|want/.test(t)) return "preference";
  if (/decided|will use|rozhodli/.test(t)) return "decision";
  if (/@|phone|\+\d{10}/.test(t)) return "entity";
  return "fact";
}

// Plugin
export default {
  id: "memory-pgvector",
  name: "Memory (pgvector)",
  description: "PostgreSQL + pgvector memory backend",

  register(api: ClawdbotPluginApi) {
    const raw = api.pluginConfig as Config;
    const provider = raw.embedding?.provider ?? "openai";
    const model = raw.embedding?.model ?? (provider === "gemini" ? "text-embedding-004" : "text-embedding-3-small");
    const apiKey = raw.embedding?.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
    const baseUrl = raw.embedding?.baseUrl ?? BASE_URLS[provider];
    const ftsLanguage = raw.ftsLanguage ?? "english";

    if (!apiKey && provider !== "ollama") throw new Error(`memory-pgvector: API key required for ${provider}`);

    const db = new MemoryDB({ connectionString: raw.connectionString ?? process.env.DATABASE_URL, ftsLanguage });
    const dims = DIMS[model] ?? 1536;

    const embed = async (text: string): Promise<number[]> => {
      const cached = getCached(text);
      if (cached) return cached;
      const vec = provider === "gemini"
        ? await embedGemini(text, model, apiKey, baseUrl)
        : await embedOpenAI(text, model, apiKey, baseUrl);
      setCache(text, vec);
      return vec;
    };

    const getAgent = (ctx?: { sessionKey?: string }) => ctx?.sessionKey?.match(/^agent:([^:]+)/)?.[1] ?? "default";

    // Tools
    api.registerTool({
      name: "memory_recall",
      description: "Search long-term memories",
      parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
      async execute(_, params, ctx) {
        const { query, limit = 5 } = params as { query: string; limit?: number };
        const vec = await embed(query);
        const results = await db.search({ agentId: getAgent(ctx), embedding: vec, query, limit });
        if (!results.length) return { content: [{ type: "text", text: "No memories found." }] };
        const text = results.map((r, i) => `${i + 1}. [${r.entry.category}] ${r.entry.text} (${Math.round(r.score * 100)}%)`).join("\n");
        return { content: [{ type: "text", text }], details: { count: results.length } };
      },
    }, { name: "memory_recall" });

    api.registerTool({
      name: "memory_store",
      description: "Save to long-term memory",
      parameters: Type.Object({
        text: Type.String(),
        category: Type.Optional(Type.Union(CATEGORIES.map(c => Type.Literal(c)))),
        importance: Type.Optional(Type.Number()),
      }),
      async execute(_, params, ctx) {
        const { text, category = "other", importance = 0.7 } = params as { text: string; category?: Category; importance?: number };
        const vec = await embed(text);
        const dup = await db.findSimilar({ agentId: getAgent(ctx), embedding: vec, threshold: 0.95 });
        if (dup.length) return { content: [{ type: "text", text: `Similar exists: "${dup[0].entry.text}"` }] };
        const mem = await db.store({ agentId: getAgent(ctx), text, embedding: vec, category, importance });
        return { content: [{ type: "text", text: `Stored: "${text.slice(0, 80)}..."` }], details: { id: mem.id } };
      },
    }, { name: "memory_store" });

    api.registerTool({
      name: "memory_forget",
      description: "Delete a memory",
      parameters: Type.Object({ memoryId: Type.String() }),
      async execute(_, params, ctx) {
        const { memoryId } = params as { memoryId: string };
        const ok = await db.delete(memoryId, getAgent(ctx));
        return { content: [{ type: "text", text: ok ? "Forgotten." : "Not found." }] };
      },
    }, { name: "memory_forget" });

    // CLI
    api.registerCli(({ program }) => {
      const cmd = program.command("pgmem").description("Memory commands");
      cmd.command("stats").option("--agent <id>", "Agent", "default").action(async (o) => {
        console.log(`Memories: ${await db.count(o.agent)}`);
      });
      cmd.command("health").action(async () => {
        const h = await db.healthCheck();
        console.log(h.ok ? "✓ OK" : `✗ ${h.error}`);
        process.exit(h.ok ? 0 : 1);
      });
      cmd.command("search <query>").option("--agent <id>", "Agent", "default").option("--limit <n>", "Limit", "5").action(async (q, o) => {
        const vec = await embed(q);
        const r = await db.search({ agentId: o.agent, embedding: vec, query: q, limit: +o.limit });
        console.log(JSON.stringify(r.map(x => ({ id: x.entry.id, text: x.entry.text, score: x.score })), null, 2));
      });
    }, { commands: ["pgmem"] });

    // Auto-recall
    if (raw.autoRecall !== false) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 10) return;
        try {
          const vec = await embed(event.prompt);
          const timeoutMs = raw.autoRecallTimeoutMs ?? 100;
          const results = await Promise.race([
            db.search({ agentId: getAgent(event), embedding: vec, query: event.prompt, limit: 3 }),
            new Promise<SearchResult[]>(r => setTimeout(() => r([]), timeoutMs)),
          ]);
          if (!results.length) return;
          const mem = results.map(r => `- [${r.entry.category}] ${r.entry.text}`).join("\n");
          return { prependContext: `<memories>\n${mem}\n</memories>` };
        } catch { /* ignore */ }
      });
    }

    // Auto-capture
    if (raw.autoCapture !== false) {
      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages?.length) return;
        const texts: string[] = [];
        for (const m of event.messages) {
          const content = (m as Record<string, unknown>)?.content;
          if (typeof content === "string") texts.push(content);
        }
        const toCapture = texts.filter(shouldCapture).slice(0, 3);
        for (const text of toCapture) {
          try {
            const vec = await embed(text);
            const dup = await db.findSimilar({ agentId: getAgent(event), embedding: vec, threshold: 0.95 });
            if (!dup.length) await db.store({ agentId: getAgent(event), text, embedding: vec, category: detectCategory(text), source: "auto" });
          } catch { /* ignore */ }
        }
      });
    }

    // Service
    api.registerService({
      id: "memory-pgvector",
      start: async () => {
        const h = await db.healthCheck();
        if (h.ok) api.logger.info(`memory-pgvector: ready (${provider}/${model}, ${dims}d)`);
        else api.logger.warn(`memory-pgvector: DB unavailable - ${h.error}`);
      },
      stop: async () => { cache.clear(); await db.close(); },
    });
  },
};
