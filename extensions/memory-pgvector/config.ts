/**
 * Configuration types and parsing for memory-pgvector plugin
 * 
 * Supports multiple embedding providers:
 * - OpenAI (default)
 * - Gemini (Google)
 * - Ollama (local)
 * - Custom (any OpenAI-compatible endpoint)
 * - Mistral
 */

export type MemoryCategory = "preference" | "fact" | "decision" | "entity" | "other";
export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  "preference",
  "fact", 
  "decision",
  "entity",
  "other"
] as const;

export type EmbeddingProvider = "openai" | "gemini" | "ollama" | "mistral" | "custom";

export interface ConnectionConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
}

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  apiKey?: string;          // Required for cloud providers, optional for local
  baseUrl?: string;         // For Ollama, vLLM, LiteLLM, custom endpoints
  dimensions?: number;      // Override automatic dimension detection
}

export interface SearchConfig {
  hybrid: boolean;
  vectorWeight: number;
  textWeight: number;
  minScore: number;
  limit: number;
}

export interface MemoryPgvectorConfig {
  connection?: ConnectionConfig;
  connectionString?: string;
  embedding: EmbeddingConfig;
  autoCapture: boolean;
  autoRecall: boolean;
  autoRecallTimeoutMs: number;  // Timeout for auto-recall to avoid blocking agent start
  asyncCapture: boolean;        // Fire-and-forget capture (don't block agent_end)
  search: SearchConfig;
  indexType: "hnsw" | "ivfflat";
  ftsLanguage: string;  // PostgreSQL text search language (english, german, russian, etc.)
}

// Embedding model dimensions
// Default dimensions for known models
const EMBEDDING_DIMENSIONS: Record<string, number> = {
  // OpenAI
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  
  // Gemini
  "text-embedding-004": 768,
  "gemini-embedding-001": 768,
  "embedding-001": 768,
  
  // Mistral
  "mistral-embed": 1024,
  
  // Common local models (Ollama, etc.)
  "nomic-embed-text": 768,
  "all-minilm": 384,
  "mxbai-embed-large": 1024,
  "bge-small-en-v1.5": 384,
  "bge-base-en-v1.5": 768,
  "bge-large-en-v1.5": 1024,
  "bge-m3": 1024,
  "snowflake-arctic-embed": 1024,
  "e5-small-v2": 384,
  "e5-base-v2": 768,
  "e5-large-v2": 1024,
};

/**
 * Get vector dimensions for a model
 * Falls back to 1536 (OpenAI default) if unknown
 */
export function vectorDimsForModel(model: string, overrideDims?: number): number {
  if (overrideDims && overrideDims > 0) {
    return overrideDims;
  }
  
  // Check exact match
  if (EMBEDDING_DIMENSIONS[model]) {
    return EMBEDDING_DIMENSIONS[model];
  }
  
  // Check partial match (for versioned models)
  for (const [key, dims] of Object.entries(EMBEDDING_DIMENSIONS)) {
    if (model.includes(key) || key.includes(model)) {
      return dims;
    }
  }
  
  // Default to OpenAI's default dimension
  return 1536;
}

/**
 * Get default base URL for a provider
 */
export function getDefaultBaseUrl(provider: EmbeddingProvider): string | undefined {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "ollama":
      return "http://localhost:11434/v1";
    case "mistral":
      return "https://api.mistral.ai/v1";
    case "custom":
      return undefined; // Must be specified
  }
}

// Resolve environment variables in strings
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

// Try to resolve environment variables, return undefined if not found
function tryResolveEnvVars(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return resolveEnvVars(value);
  } catch {
    return undefined;
  }
}

// Parse and validate configuration
export function parseConfig(raw: unknown): MemoryPgvectorConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("memory-pgvector: configuration object required");
  }

  const cfg = raw as Record<string, unknown>;

  // Embedding config
  const embeddingRaw = cfg.embedding as Record<string, unknown> | undefined;
  if (!embeddingRaw) {
    throw new Error("memory-pgvector: embedding configuration required");
  }

  const provider = typeof embeddingRaw.provider === "string"
    ? embeddingRaw.provider as EmbeddingProvider
    : "openai";

  const model = typeof embeddingRaw.model === "string" 
    ? embeddingRaw.model 
    : provider === "openai" ? "text-embedding-3-small" 
    : provider === "gemini" ? "text-embedding-004"
    : provider === "mistral" ? "mistral-embed"
    : provider === "ollama" ? "nomic-embed-text"
    : "text-embedding-3-small";

  // API key handling
  let apiKey: string | undefined;
  if (typeof embeddingRaw.apiKey === "string") {
    apiKey = resolveEnvVars(embeddingRaw.apiKey);
  } else {
    // Try common environment variables based on provider
    const envVars: Record<EmbeddingProvider, string[]> = {
      openai: ["OPENAI_API_KEY"],
      gemini: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
      mistral: ["MISTRAL_API_KEY"],
      ollama: [], // No API key needed
      custom: ["EMBEDDING_API_KEY", "OPENAI_API_KEY"],
    };
    
    for (const envVar of envVars[provider]) {
      const value = process.env[envVar];
      if (value) {
        apiKey = value;
        break;
      }
    }
  }

  // Validate API key for cloud providers
  if (!apiKey && provider !== "ollama" && provider !== "custom") {
    const envHint = provider === "openai" ? "OPENAI_API_KEY" 
      : provider === "gemini" ? "GOOGLE_API_KEY"
      : provider === "mistral" ? "MISTRAL_API_KEY"
      : "embedding.apiKey";
    throw new Error(
      `memory-pgvector requires ${envHint} for ${provider} embeddings. ` +
      `Set it in config or environment.`
    );
  }

  // Base URL
  let baseUrl = typeof embeddingRaw.baseUrl === "string"
    ? resolveEnvVars(embeddingRaw.baseUrl)
    : getDefaultBaseUrl(provider);

  // Custom provider requires baseUrl
  if (provider === "custom" && !baseUrl) {
    throw new Error(
      "memory-pgvector: custom embedding provider requires baseUrl configuration"
    );
  }

  // Dimensions
  const dimensions = typeof embeddingRaw.dimensions === "number"
    ? embeddingRaw.dimensions
    : undefined;

  const embedding: EmbeddingConfig = {
    provider,
    model,
    apiKey,
    baseUrl,
    dimensions,
  };

  // Connection config
  let connection: ConnectionConfig | undefined;
  let connectionString: string | undefined;

  if (typeof cfg.connectionString === "string") {
    connectionString = resolveEnvVars(cfg.connectionString);
  } else if (cfg.connection && typeof cfg.connection === "object") {
    const conn = cfg.connection as Record<string, unknown>;
    connection = {
      host: typeof conn.host === "string" ? conn.host : "localhost",
      port: typeof conn.port === "number" ? conn.port : 5432,
      database: typeof conn.database === "string" ? conn.database : "clawdbot_memory",
      user: typeof conn.user === "string" ? conn.user : "clawdbot",
      password: typeof conn.password === "string" ? tryResolveEnvVars(conn.password) : undefined,
      ssl: conn.ssl as boolean | { rejectUnauthorized?: boolean } | undefined,
    };
  } else {
    // Default connection
    connection = {
      host: "localhost",
      port: 5432,
      database: "clawdbot_memory",
      user: "clawdbot",
    };
  }

  // Search config with defaults
  const searchRaw = cfg.search as Record<string, unknown> | undefined;
  const search: SearchConfig = {
    hybrid: searchRaw?.hybrid !== false,
    vectorWeight: typeof searchRaw?.vectorWeight === "number" ? searchRaw.vectorWeight : 0.7,
    textWeight: typeof searchRaw?.textWeight === "number" ? searchRaw.textWeight : 0.3,
    minScore: typeof searchRaw?.minScore === "number" ? searchRaw.minScore : 0.3,
    limit: typeof searchRaw?.limit === "number" ? searchRaw.limit : 5,
  };

  // FTS language (default: english)
  const ftsLanguage = typeof cfg.ftsLanguage === "string" 
    ? cfg.ftsLanguage 
    : "english";

  // Async timeout settings
  const autoRecallTimeoutMs = typeof cfg.autoRecallTimeoutMs === "number" 
    ? cfg.autoRecallTimeoutMs 
    : 100;  // Default 100ms - fast fail for responsiveness

  const asyncCapture = cfg.asyncCapture !== false;  // Default true - fire-and-forget

  return {
    connection,
    connectionString,
    embedding,
    autoCapture: cfg.autoCapture !== false,
    autoRecall: cfg.autoRecall !== false,
    autoRecallTimeoutMs,
    asyncCapture,
    search,
    indexType: cfg.indexType === "ivfflat" ? "ivfflat" : "hnsw",
    ftsLanguage,
  };
}
