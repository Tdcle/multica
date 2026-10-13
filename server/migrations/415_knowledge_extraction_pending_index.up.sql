CREATE INDEX CONCURRENTLY knowledge_extraction_pending_idx ON knowledge_extraction (available_at, created_at) WHERE status IN ('pending', 'processing', 'submitted');
