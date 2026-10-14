CREATE UNIQUE INDEX CONCURRENTLY agent_memory_native_idx ON agent_memory (instance_id,native_agent_id) WHERE native_agent_id <> '';
