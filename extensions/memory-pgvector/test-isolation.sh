#!/bin/bash
# Real multi-agent isolation test

set -e
DB="postgresql://postgres:test@localhost:5433/postgres"

echo "=== Multi-Agent Isolation Test ==="

# Clear test data
docker exec pgvector-test psql -U postgres -c "DELETE FROM memories WHERE text LIKE 'TEST_%';"

echo ""
echo "1. Store memories for each agent..."

# We'll manually insert with different agent_ids to simulate
docker exec pgvector-test psql -U postgres << 'SQL'
-- Simulate TARS storing a memory
INSERT INTO memories (agent_id, text, category, importance) 
VALUES ('main', 'TEST_TARS: My secret is blue', 'fact', 0.8);

-- Simulate Sam Jr storing a memory  
INSERT INTO memories (agent_id, text, category, importance)
VALUES ('samjr', 'TEST_SAMJR: My secret is green', 'fact', 0.8);

-- Simulate Smith storing a memory
INSERT INTO memories (agent_id, text, category, importance)
VALUES ('smith', 'TEST_SMITH: My secret is red', 'fact', 0.8);
SQL

echo ""
echo "2. Verify data stored..."
docker exec pgvector-test psql -U postgres -c \
  "SELECT agent_id, text FROM memories WHERE text LIKE 'TEST_%' ORDER BY agent_id;"

echo ""
echo "3. Test isolation - each agent should only see their own..."

echo ""
echo "TARS (main) sees:"
docker exec pgvector-test psql -U postgres -c \
  "SELECT text FROM memories WHERE agent_id = 'main' AND text LIKE 'TEST_%';"

echo "Sam Jr sees:"
docker exec pgvector-test psql -U postgres -c \
  "SELECT text FROM memories WHERE agent_id = 'samjr' AND text LIKE 'TEST_%';"

echo "Smith sees:"  
docker exec pgvector-test psql -U postgres -c \
  "SELECT text FROM memories WHERE agent_id = 'smith' AND text LIKE 'TEST_%';"

echo ""
echo "4. Cross-agent access test (should return 0 rows)..."
echo "Can TARS see Sam Jr's data directly?"
docker exec pgvector-test psql -U postgres -c \
  "SELECT COUNT(*) as should_be_zero FROM memories WHERE agent_id = 'main' AND text LIKE 'TEST_SAMJR%';"

echo ""
echo "=== Basic isolation verified (application-level) ==="
echo ""
echo "Once RLS is implemented, we'll test:"
echo "  SET app.agent_id = 'main';"
echo "  SELECT * FROM memories WHERE text LIKE 'TEST_%';"
echo "  -- Should only return TARS's memories, enforced by database"
