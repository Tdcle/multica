# Workspace knowledge

Multica runs the original TencentDB Agent Memory Core, Knowledge, Panel and Proxy
as separate processes. `upstream.json` pins the source revision and integration
patches. Extraction, Wiki compilation and CodeGraph indexing use the original
engines. Web and Desktop share the workspace Knowledge page and embedded panel.

## Behavior

- A workspace owner/admin creates a knowledge space or binds an accessible native
  team. Each native team can bind to one workspace per instance.
- An issue entering any Done category creates a durable extraction job in the
  same transaction. Repeated Done writes are idempotent; reopening and completing
  creates another revision. Chat and agent execution completion do not trigger it.
- The worker waits for existing executions to finish, then freezes the issue,
  comments, execution text/tool results and final output. It redacts secrets,
  excludes internal reasoning and retains attribution and corrections.
- Chat delivery uses batches of 100. Skill archives respect the native 500-record
  and byte limits; batch boundaries are frozen with the source. Stable
  IDs, timestamps and leased SQL checkpoints support retries and process recovery.
  The final Chat chunk triggers the native pipeline after all chunks are stored.
  Preservation requests are rejected before archive creation if the configured
  native byte limit would compress or truncate them. Ordinary native clients keep
  their original compression policy.
- Ready means the native L1 cursor covers the source and every Skill archive has
  a durable completed receipt. Original L2/L3 processing continues asynchronously;
  its policies decide whether to generate a new scene or core memory.
- Issue-derived assets are shared with the team. Human reads retain native private
  assets and ACLs. Agent credentials receive team-shared assets only.
- Task claims retrieve relevant Chat Memory, Skills, Wiki and CodeGraph into the
  per-turn prompt. Private Skill candidates are excluded before native ranking.
  On-demand CLI reads support native layers, Wiki references and code exploration.
- The panel uses the caller's mapped native identity in an isolated frame.
  Requests recheck workspace membership, the current binding, resource scope and
  ACLs. Credentials remain on the backend. Embedded space administration follows
  the current workspace owner/admin role; resource editing retains native ACLs.
  Wiki/CodeGraph content stores are checked separately from their metadata, so a
  metadata alias cannot redirect a reader to another space's content.

## Local setup with Codex

Requires Node 22+, npm, the installed/authenticated Codex CLI and Multica's usual
Go/PostgreSQL environment. The local bridge uses Codex for non-streaming text and
function selection; original engines execute their tools. It does not supply
embeddings or multimodal inference. This setup uses native SQLite/BM25 storage.
The native services retain their other provider/storage configuration options.

```bash
node scripts/prepare-agent-memory.mjs --install
# Select a model available in this account's `codex debug models` catalog.
MULTICA_MEMORY_RUNTIME_MODEL=gpt-6-sol node scripts/agent-memory.mjs init
node scripts/agent-memory.mjs build
node scripts/agent-memory.mjs start
node scripts/agent-memory.mjs status
```

The preparation script preserves an existing checkout and verifies each patch;
settings and credentials are generated once in ignored `.agent-memory/local/`.
`init` refuses to overwrite them. Configuration files are mode 0600 and the state
root is 0700. Add the variables from its private `multica.env` to this checkout's
ignored `.env` or `.env.worktree`, preserving existing database/port settings, then
restart the Multica API. Keep the generated encryption key across restarts.

Use `MULTICA_AGENT_MEMORY_STATE_DIR` for another private state directory,
`MULTICA_AGENT_MEMORY_SOURCE_DIR` for another pinned source checkout, and
`MULTICA_MEMORY_PORT_BASE` for another loopback port range. Defaults are runtime
8430, Core 8440, Knowledge 8441, Panel 8445 and Proxy 8446. Data roots can be set at
initialization with `MULTICA_AGENT_MEMORY_CORE_STORAGE_DIR` and
`MULTICA_AGENT_MEMORY_KNOWLEDGE_DATA_DIR`.

```bash
node scripts/agent-memory.mjs restart core
node scripts/agent-memory.mjs stop
node scripts/agent-memory.mjs start
```

The launcher verifies recorded process identity, waits for termination and port
release, preserves data and refuses to stop an unmanaged listener. It serializes
controller operations. If a controller itself is killed, verify the PID recorded
in `controller.lock` has exited before removing that stale lock. Component logs
and the original Panel agent-template directory are inside the private state root.
This is local process management; production hosting should use its own service
manager and persistent volumes with the same pinned sources/configuration.

## Backend environment

Keep these values in an untracked environment file or deployment secret store:

| Variable | Purpose |
| --- | --- |
| `MULTICA_AGENT_MEMORY_CORE_URL` | Core endpoint |
| `MULTICA_AGENT_MEMORY_PANEL_URL` | Original Panel endpoint |
| `MULTICA_AGENT_MEMORY_PROXY_URL` | Original Proxy endpoint |
| `MULTICA_AGENT_MEMORY_KNOWLEDGE_URL` | Original Knowledge endpoint |
| `MULTICA_AGENT_MEMORY_KNOWLEDGE_KEY` | Knowledge backend credential |
| `MULTICA_AGENT_MEMORY_INSTANCE_ID` | Registered instance; default `default` |
| `MULTICA_AGENT_MEMORY_API_KEY` | Core Bearer gate |
| `MULTICA_AGENT_MEMORY_ADMIN_KEY` | Account used to provision mapped users |
| `MULTICA_AGENT_MEMORY_SECRET_KEY` | Base64 32-byte key encrypting persisted identities |

Automation and team sharing use the managed writer's persisted native account,
not the provisioning account. A Core instance ID and encryption key must stay
consistent across workers sharing the same Multica database. Without configuration,
Multica runs normally and the Knowledge page reports the missing service setup.

The original upstream team and asset ownership remain independent of Multica's
binding. Membership revocation is enforced on Multica routes and active embedded
sessions. Native accounts accessed outside Multica retain their native permissions.

## On-demand CLI

```bash
multica knowledge list --limit 100 --offset 0
multica knowledge search "deployment recovery" --type skill
multica knowledge read <asset-id>
multica knowledge read <wiki-id> --ref pages/example.md
multica knowledge read <code-id> --query isNumber
multica knowledge read <memory-id> --layer L2
```

Task credentials determine the workspace; caller-supplied workspace/team IDs cannot
change it. Search returns `items` and `warnings`. Retrieval covers the first 100
accessible catalog entries and also preserves the managed task memory block; use
paginated `list` and explicit `read` for larger catalogs. Claim hydration is bounded
by five seconds and three hits per asset family.

## Verification

Always run database tests in the checkout's allocated environment:

```bash
bash scripts/dev-env.sh exec -- go -C server test ./internal/handler \
  -run 'TestKnowledgeDoneLifecycle|TestKnowledgeExtractionLeaseRecovery' -count=1
bash scripts/dev-env.sh exec -- pnpm exec playwright test \
  e2e/knowledge.spec.ts e2e/knowledge-panel.spec.ts
```

Real inference tests consume the authenticated account's quota and require opt-in.
The producer/reader test runs two actual Codex agents and verifies successful CLI
search/read tool results against an execution-only historical marker:

```bash
go -C server build -o ../.agent-memory/bin/multica ./cmd/multica
MULTICA_KNOWLEDGE_CLI_PATH="$PWD/.agent-memory/bin/multica" \
MULTICA_KNOWLEDGE_CODEX_MODEL=gpt-6-sol MULTICA_RUN_REAL_AGENT_SMOKE=1 \
bash scripts/dev-env.sh exec -- go -C server test -tags=agentintegration \
  ./internal/handler -run '^TestKnowledgeLiveDoneToAgentClaim$' -count=1 -v
```

The managed recovery test kills only its verified Core process group after durable
Skill submission, starts a healthy replacement, resumes its persisted queue through
normal status polling, and checks exact frozen-source/archive restoration plus
idempotent retry. Stop this checkout's API before testing an alternate Core against
its database so another worker cannot deliver the same outbox to a different service:

```bash
make down C=api
MULTICA_RUN_REAL_AGENT_SMOKE=1 node scripts/agent-memory.mjs test-recovery
# Optional extended case: 503 records, six Chat chunks, byte-bounded Skill archives.
MULTICA_AGENT_MEMORY_LARGE_SOURCE_TEST=1 MULTICA_RUN_REAL_AGENT_SMOKE=1 \
node scripts/agent-memory.mjs test-recovery
make up C=api
```

Actual service verification has passed: Done/custom-Done/reopen/rollback semantics,
Chat plus Skill extraction and sharing, separate producer/reader execution, Core
crash/restart and failed-archive recovery, native Wiki compilation/read/search,
CodeGraph indexing/search/delete, scoped panel operations, private/shared Skill ACLs,
and membership/role revocation. The extended batch test remains under verification.

The public Proxy checkout's full TypeScript check currently fails on the absent
optional `@context-proxy/cost-guard` module. Local SQLite startup and authenticated
inference work; this is not a passing typecheck claim. Proxy `auth.serviceToken`
must match Core's Bearer gate. Keep `TMC_CALLBACK_URL` as the Panel base URL and
`KNOWLEDGE_PUBLIC_BASE_URL` with the `/v3` prefix.
