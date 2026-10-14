ALTER TABLE workspace_knowledge ADD COLUMN service_user_id text, ADD COLUMN service_key_ciphertext bytea;
ALTER TABLE knowledge_identity ADD COLUMN display_name text;
