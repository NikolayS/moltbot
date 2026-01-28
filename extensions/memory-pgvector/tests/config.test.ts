/**
 * Configuration parsing tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseConfig, vectorDimsForModel, getDefaultBaseUrl } from '../config.js';

describe('parseConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should throw if no config provided', () => {
    expect(() => parseConfig(null)).toThrow('configuration object required');
    expect(() => parseConfig(undefined)).toThrow('configuration object required');
  });

  it('should throw if embedding config missing', () => {
    expect(() => parseConfig({})).toThrow('embedding configuration required');
  });

  it('should require API key for cloud providers', () => {
    // Clear all potential API key env vars
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.MISTRAL_API_KEY;

    expect(() => parseConfig({
      embedding: { provider: 'openai' }
    })).toThrow('OPENAI_API_KEY');

    expect(() => parseConfig({
      embedding: { provider: 'gemini' }
    })).toThrow('GOOGLE_API_KEY');

    expect(() => parseConfig({
      embedding: { provider: 'mistral' }
    })).toThrow('MISTRAL_API_KEY');
  });

  it('should not require API key for Ollama', () => {
    const config = parseConfig({
      embedding: { provider: 'ollama' }
    });
    expect(config.embedding.provider).toBe('ollama');
    expect(config.embedding.model).toBe('nomic-embed-text');
  });

  it('should use environment variables for API keys', () => {
    process.env.OPENAI_API_KEY = 'sk-test-key';
    const config = parseConfig({
      embedding: { provider: 'openai' }
    });
    expect(config.embedding.apiKey).toBe('sk-test-key');
  });

  it('should use explicit API key over environment', () => {
    process.env.OPENAI_API_KEY = 'sk-env-key';
    const config = parseConfig({
      embedding: { provider: 'openai', apiKey: 'sk-explicit-key' }
    });
    expect(config.embedding.apiKey).toBe('sk-explicit-key');
  });

  it('should resolve ${VAR} syntax in apiKey', () => {
    process.env.MY_API_KEY = 'sk-resolved-key';
    const config = parseConfig({
      embedding: { provider: 'openai', apiKey: '${MY_API_KEY}' }
    });
    expect(config.embedding.apiKey).toBe('sk-resolved-key');
  });

  it('should throw if ${VAR} references missing env var', () => {
    expect(() => parseConfig({
      embedding: { provider: 'openai', apiKey: '${NONEXISTENT_KEY}' }
    })).toThrow('NONEXISTENT_KEY is not set');
  });

  it('should set default model for each provider', () => {
    process.env.OPENAI_API_KEY = 'test';
    process.env.GOOGLE_API_KEY = 'test';
    process.env.MISTRAL_API_KEY = 'test';

    expect(parseConfig({ embedding: { provider: 'openai' } }).embedding.model)
      .toBe('text-embedding-3-small');
    expect(parseConfig({ embedding: { provider: 'gemini' } }).embedding.model)
      .toBe('text-embedding-004');
    expect(parseConfig({ embedding: { provider: 'mistral' } }).embedding.model)
      .toBe('mistral-embed');
    expect(parseConfig({ embedding: { provider: 'ollama' } }).embedding.model)
      .toBe('nomic-embed-text');
  });

  it('should parse connection config', () => {
    process.env.OPENAI_API_KEY = 'test';
    const config = parseConfig({
      embedding: { provider: 'openai' },
      connection: {
        host: 'db.example.com',
        port: 5433,
        database: 'mydb',
        user: 'myuser',
        password: 'mypass',
        ssl: true
      }
    });

    expect(config.connection?.host).toBe('db.example.com');
    expect(config.connection?.port).toBe(5433);
    expect(config.connection?.database).toBe('mydb');
    expect(config.connection?.user).toBe('myuser');
    expect(config.connection?.password).toBe('mypass');
    expect(config.connection?.ssl).toBe(true);
  });

  it('should parse connectionString', () => {
    process.env.OPENAI_API_KEY = 'test';
    process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/db';
    
    const config = parseConfig({
      embedding: { provider: 'openai' },
      connectionString: '${DATABASE_URL}'
    });

    expect(config.connectionString).toBe('postgresql://user:pass@host:5432/db');
  });

  it('should parse search config with defaults', () => {
    process.env.OPENAI_API_KEY = 'test';
    const config = parseConfig({
      embedding: { provider: 'openai' }
    });

    expect(config.search.hybrid).toBe(true);
    expect(config.search.vectorWeight).toBe(0.7);
    expect(config.search.textWeight).toBe(0.3);
    expect(config.search.minScore).toBe(0.3);
    expect(config.search.limit).toBe(5);
  });

  it('should allow overriding search config', () => {
    process.env.OPENAI_API_KEY = 'test';
    const config = parseConfig({
      embedding: { provider: 'openai' },
      search: {
        hybrid: false,
        vectorWeight: 0.9,
        textWeight: 0.1,
        minScore: 0.5,
        limit: 10
      }
    });

    expect(config.search.hybrid).toBe(false);
    expect(config.search.vectorWeight).toBe(0.9);
    expect(config.search.textWeight).toBe(0.1);
    expect(config.search.minScore).toBe(0.5);
    expect(config.search.limit).toBe(10);
  });

  it('should default autoCapture and autoRecall to true', () => {
    process.env.OPENAI_API_KEY = 'test';
    const config = parseConfig({
      embedding: { provider: 'openai' }
    });

    expect(config.autoCapture).toBe(true);
    expect(config.autoRecall).toBe(true);
  });

  it('should allow disabling autoCapture and autoRecall', () => {
    process.env.OPENAI_API_KEY = 'test';
    const config = parseConfig({
      embedding: { provider: 'openai' },
      autoCapture: false,
      autoRecall: false
    });

    expect(config.autoCapture).toBe(false);
    expect(config.autoRecall).toBe(false);
  });

  it('should default indexType to hnsw', () => {
    process.env.OPENAI_API_KEY = 'test';
    const config = parseConfig({
      embedding: { provider: 'openai' }
    });

    expect(config.indexType).toBe('hnsw');
  });

  it('should allow ivfflat indexType', () => {
    process.env.OPENAI_API_KEY = 'test';
    const config = parseConfig({
      embedding: { provider: 'openai' },
      indexType: 'ivfflat'
    });

    expect(config.indexType).toBe('ivfflat');
  });
});

describe('vectorDimsForModel', () => {
  it('should return known dimensions for OpenAI models', () => {
    expect(vectorDimsForModel('text-embedding-3-small')).toBe(1536);
    expect(vectorDimsForModel('text-embedding-3-large')).toBe(3072);
    expect(vectorDimsForModel('text-embedding-ada-002')).toBe(1536);
  });

  it('should return known dimensions for Gemini models', () => {
    expect(vectorDimsForModel('text-embedding-004')).toBe(768);
    expect(vectorDimsForModel('embedding-001')).toBe(768);
  });

  it('should return known dimensions for Mistral models', () => {
    expect(vectorDimsForModel('mistral-embed')).toBe(1024);
  });

  it('should return known dimensions for Ollama models', () => {
    expect(vectorDimsForModel('nomic-embed-text')).toBe(768);
    expect(vectorDimsForModel('mxbai-embed-large')).toBe(1024);
    expect(vectorDimsForModel('all-minilm')).toBe(384);
    expect(vectorDimsForModel('bge-m3')).toBe(1024);
  });

  it('should return default 1536 for unknown models', () => {
    expect(vectorDimsForModel('unknown-model')).toBe(1536);
  });

  it('should respect override dimensions', () => {
    expect(vectorDimsForModel('text-embedding-3-small', 512)).toBe(512);
    expect(vectorDimsForModel('unknown-model', 2048)).toBe(2048);
  });

  it('should match partial model names', () => {
    expect(vectorDimsForModel('openai/text-embedding-3-small')).toBe(1536);
    expect(vectorDimsForModel('nomic-embed-text:latest')).toBe(768);
  });
});

describe('getDefaultBaseUrl', () => {
  it('should return correct base URLs', () => {
    expect(getDefaultBaseUrl('openai')).toBe('https://api.openai.com/v1');
    expect(getDefaultBaseUrl('gemini')).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(getDefaultBaseUrl('ollama')).toBe('http://localhost:11434/v1');
    expect(getDefaultBaseUrl('mistral')).toBe('https://api.mistral.ai/v1');
    expect(getDefaultBaseUrl('custom')).toBeUndefined();
  });
});
