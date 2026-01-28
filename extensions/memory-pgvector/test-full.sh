#!/bin/bash
# Full test suite including integration tests with real PostgreSQL + pgvector
set -e

echo "🔍 Type checking..."
npm run typecheck

echo "✅ Running unit tests..."
npm run test

echo "🐳 Starting PostgreSQL + pgvector..."
npm run test:db:up

echo "🧪 Running integration tests..."
npm run test:integration || {
  echo "❌ Integration tests failed"
  npm run test:db:down
  exit 1
}

echo "🧹 Cleaning up..."
npm run test:db:down

echo ""
echo "✅ All tests passed!"
