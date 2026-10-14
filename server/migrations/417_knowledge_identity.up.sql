CREATE TABLE knowledge_identity (
    instance_id text NOT NULL,
    user_id uuid NOT NULL,
    upstream_user_id text,
    user_key_ciphertext bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
