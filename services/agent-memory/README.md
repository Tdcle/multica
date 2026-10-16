# Agent memory

Multica runs the original TencentDB Agent Memory Core, Knowledge, Panel and Proxy
as separate processes. `upstream.json` pins the source revision and integration
patches. Extraction, Wiki compilation and CodeGraph indexing use the original
engines. Web and Desktop share the Memory console and agent memory controls.

## Behavior

- Creating a Multica agent atomically creates and binds an independent pending
  memory. A background worker provisions its private native Agent container.
  Service outages never roll back agent creation; pending setup persists across
  restarts and retries automatically. Each agent has one active binding; multiple
  agents can share the same memory.
- The sidebar Memory entry opens the complete original console directly, using
  the Brain icon in both sidebar and desktop tabs. The agent list's Memory column
  shows the bound container or a red unbound state and opens a direct dropdown. Its Memory
  action manages independent resources, including unbound memories.
  The binding list uses native Agent names. Refreshing it imports the current
  user's native Agents from the workspace team and reconciles renamed containers;
  the old workspace memory retains its original native identity and contents. An agent's
  detail Memory tab also supports detach, rebind and creation.
  Archiving an agent preserves its detached memory by default; the confirmation
  offers explicit permanent deletion. CLI uses `agent archive <id> --delete-memory`.
  Deleting a memory preserves the Multica agent. Native-panel deletions are
  reconciled when the binding list refreshes and by the background worker.
  Native inactive or missing containers detach consumers and disappear locally;
  stale binding requests verify the native status before changing any binding. Deleting a container clears
  its L0-L3 conversation history; independent Skill, Wiki and CodeGraph assets
  retain their native lifecycle and are managed separately in the original panel.
- An issue entering any Done category creates one durable extraction job per
  participating agent's current memory, in the same transaction. If no execution
  exists, its agent assignee is used. Repeated Done writes are idempotent;
  reopening and completing creates another revision. Chat and execution completion
  do not trigger extraction. Unbinding cancels unsubmitted work; changes wait for
  already submitted extraction to finish, protecting its original destination.
- The worker waits for existing executions to finish, then freezes the issue,
  comments, that agent's execution text/tool results and final output. It redacts secrets,
  excludes internal reasoning and retains attribution and corrections.
- Chat delivery uses batches of 100. Native L0 accepts only user/assistant roles;
  tool calls/results retain their full attributed text in L0 while Skill archives
  preserve the original tool roles. Skill archives respect the native 500-record
  and byte limits; batch boundaries are frozen with the source. Stable
  IDs, timestamps and leased SQL checkpoints support retries and process recovery.
  The final Chat chunk triggers the native pipeline after all chunks are stored.
  Preservation requests are rejected before archive creation if the configured
  native byte limit would compress or truncate them. Ordinary native clients keep
  their original compression policy.
- Ready means the native L1 cursor covers the source and every Skill archive has
  a durable completed receipt. Original L2/L3 processing continues asynchronously;
  its policies decide whether to generate a new scene or core memory.
- Extraction writes private memory and Skill assets bound to that memory's native
  Agent. Task credentials can recall only the assets explicitly bound there,
  including its private history. Other agents' memory never enters their prompt
  automatically. Rebinding deliberately transfers access to existing content.
  Workspace identity remains the native team/authorization boundary.
- Each task claim calls the internal read-only `/v3/multica/context` endpoint
  in the existing MemoryProxy process. It directly runs the original
  `TdaiProfileMemoryInjector`, `SkillInjector` and `KnowledgeToolsInjector`:
  L3 long-term memory, L2 scene navigation and bound asset catalogs are injected;
  L0/L1 and full documents are retrieved on demand. Tool instructions use the
  managed Multica CLI. Model traffic and provider login never pass through Proxy.
  Multica authorizes each candidate using current bindings, native ACLs and
  independent content-store scope checks before rendering. Catalogs are rebuilt
  per execution without cross-execution caches. Memory scope changes discard
  provider-session resumption so old injected content is not carried forward.
  Partial/failed context builds include visible warnings in the execution prompt.
  Explicit native fixed-asset bindings select additional assets.
  Human reads retain the original catalog and native ACLs. On-demand CLI reads
  support native layers, Wiki references and code exploration.
  Agent shell commands use `MULTICA_CLI_PATH`, the absolute executable paired with
  the running daemon/desktop. Managed Codex shell tools disable login semantics
  so shell startup cannot silently select a different installed Multica version.
  Explicitly nested login shells still use the quoted absolute entry.

- The embedded console uses Multica's shared design tokens, Inter and Geist Mono
  fonts, Lucide icons and compact secondary navigation. Controls, menus, dialogs,
  tables, resource cards, Markdown and graph canvases follow the same surface and
  typography system. Light/dark appearance and language follow the host through
  a source-checked message bridge; no credentials or parent DOM access are shared.
  Preparation generates the panel token stylesheet from `packages/ui/styles/tokens.css`;
  the managed build refreshes it automatically.
- The panel uses the caller's mapped native identity in an isolated frame.
  Only the non-sensitive onboarding completion preference is persisted by the
  host per user and workspace; session credentials remain in frame memory.
  Requests recheck workspace membership, the current binding, resource scope and
  ACLs. Credentials remain on the backend. Members and account names are read
  models of Multica; the embedded member view is read-only and API Key routes
  are unavailable. Task Board and native task commands are hidden; root and stale
  task links open Chat Memory. Multica exclusively manages task lifecycles.
  The gateway and native Core reject managed identities' task CRUD, task-agent
  links, participation logs and external task imports, including legacy native
  user keys. Internal extraction and recall retain their task source identifiers.
  Resource editing retains native ACLs.
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

In the embedded console, **Memory → Settings → Extraction model** selects the
model and reasoning effort for the current workspace. Multica owners/admins can
save; members can read. Every request rechecks live membership. The model catalog
comes from the installed `codex debug models --bundled` command, including each
model's supported reasoning levels. No API key is exposed to the browser.

Workspace selections are stored atomically in private `model-settings.json` under
the existing state directory, keyed by native instance and team. Keep this file
with the service data when moving an installation. Restarting Memory preserves
selections. New inference requests snapshot the configuration when queued; already
accepted requests retain their selection. Wiki extraction and summaries, memory
extraction/deduplication/profile generation, and Skill extraction all carry that
scope to the runtime. `MULTICA_MEMORY_RUNTIME_MODEL` remains the initial default.

Wiki progress uses the engine's file counters and phase progress. Status refreshes
are read-only; they do not retry extraction. Without a progress callback, the UI
shows the current phase without an estimated percentage. Closed FILE blocks accept
shortened opening delimiters from model output; unsafe paths and unclosed blocks
are still rejected. In managed Codex mode,
the SDK does not automatically retry a failed inference; existing bounded durable
pipeline retries remain owned by Core. Runtime deadlines also kill the CLI process
group so an expired request cannot keep blocking later requests.

Focused validation (the default commands do not invoke a real model):

```bash
node --test scripts/agent-memory-runtime.e2e.mjs
bash scripts/dev-env.sh exec -- pnpm exec playwright test e2e/memory-model-settings.spec.ts
# Explicit opt-in: also extract an isolated Wiki using local Codex.
bash scripts/dev-env.sh exec -- env MULTICA_RUN_REAL_AGENT_SMOKE=1 \
  pnpm exec playwright test e2e/memory-model-settings.spec.ts
```

The preparation script preserves an existing checkout and verifies each patch;
settings and credentials are generated once in ignored `.agent-memory/local/`.
`init` refuses to overwrite them. Configuration files are mode 0600 and the state
root is 0700. Add the variables from its private `multica.env` to this checkout's
ignored `.env` or `.env.worktree`, preserving existing database/port settings, then
restart the Multica API. Keep the generated encryption key across restarts.

The generated environment includes `MULTICA_AGENT_MEMORY_STATE_DIR`. With it set,
`make up`, `make dev`, and the local desktop launcher start the existing Memory
stack before Multica. Reopening the app reuses healthy processes; missing
processes are started using the same credentials and data directories. Startup
checks the configured endpoints and credentials before launching anything, and
fails visibly if they belong to a different state directory. Existing setups can
add `MULTICA_AGENT_MEMORY_STATE_DIR=/absolute/path/to/the/existing/state` to their
ignored environment file. Leave it unset for externally managed Memory services.
The startup path does not replace configuration, regenerate credentials, rebuild engines or reset data.
Memory remains independent of a checkout's `make down`; stop it explicitly with
`node scripts/agent-memory.mjs stop` when no checkout needs it.

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

Multica is the account and membership authority. Each mapped user retains a
stable internal ID while their display name follows the Multica profile. A
workspace-scoped service account owns the native team and administers membership;
it is not a human member and does not appear in the embedded directory. Existing
teams migrate automatically on first use. Human asset ownership is preserved.
An instance ID and encryption key must remain consistent across workers sharing
the same Multica database. Without configuration, Multica runs normally and the
Memory console reports the missing service setup.

Role changes and removals attempt native synchronization immediately. A separate
30-second reconciliation loop retries outages and missed notifications. Every
embedded request checks current Multica membership independently of this mirror;
removed users' old panel sessions and task credentials cannot access Memory.
The embedded gateway rejects account, credential, team and member mutations for
all roles, including workspace owners. Managed human identities also cannot
mutate native team membership or issue keys through the Core directly. Manage
these in Multica. Native services
and their provisioning credentials are internal infrastructure: expose only the
Multica gateway to end users. The local launcher binds native services to loopback.

Multiple agents can share a memory. Binding delegates its content to those agents'
authorized callers. An administrator's inventory privileges alone cannot bind
another person's private memory to an agent belonging to a different owner.

## On-demand CLI

```bash
multica knowledge list --limit 100 --offset 0
multica knowledge search "deployment recovery" --type skill
multica knowledge read <asset-id>
multica knowledge read <wiki-id> --ref pages/example.md
multica knowledge read <code-id> --query isNumber
multica knowledge read <memory-id> --layer L2
```

Task credentials determine both workspace and agent memory; caller-supplied
workspace/team/agent IDs cannot change them. Search returns `items` and `warnings`. Retrieval covers the first 100
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
Chat plus Skill extraction, separate producer/reader execution with explicit memory rebinding, Core
crash/restart and failed-archive recovery, native Wiki compilation/read/search,
CodeGraph indexing/search/delete, scoped panel operations, private/shared Skill ACLs,
and membership/role revocation. The extended test passed with 503 frozen records
retained in full across six Chat chunks and four native Skill archives,
including Core crash/restart, lost-archive restoration and repeated retry. Native
L0–L3 reads also passed; L2/L3 generation remains governed by upstream policies.

The public Proxy checkout's full TypeScript check currently fails on the absent
optional `@context-proxy/cost-guard` module. Local SQLite startup and authenticated
inference work; this is not a passing typecheck claim. Proxy `auth.serviceToken`
must match Core's Bearer gate. Keep `TMC_CALLBACK_URL` as the Panel base URL and
`KNOWLEDGE_PUBLIC_BASE_URL` with the `/v3` prefix.

## Skills management

Web and desktop use **Memory → Skills** as their skill management entry. Old
Skills URLs redirect to that console. Team directory imports create shared
assets without an owner agent or an automatic binding. Allocate references to
one or more Memory agents as needed; detaching a reference preserves the team
asset. Extracted agent-owned skills keep their existing native lifecycle.
Task-scoped `multica knowledge read <skill-id> --ref <resource-path>` reads
supporting files under the same membership, asset ACL and binding checks.

To migrate existing unbound, non-plugin Multica skills into their workspace's
native team, run a preflight and then apply using a private backup path:

```bash
bash scripts/dev-env.sh exec -- node scripts/migrate-agent-memory-skills.mjs \
  --workspace <slug> --backup <private-path>/skills.json
bash scripts/dev-env.sh exec -- node scripts/migrate-agent-memory-skills.mjs \
  --workspace <slug> --backup <private-path>/skills.json --apply
```

The migrator preserves creator identity, configuration and resource paths,
records old/native IDs, and reads back every body and file before retiring the
original rows in one transaction. It refuses active agent bindings, plugin-owned
rows, conflicting team names and source changes. After an interrupted import,
retry with the same backup path: source IDs in native metadata recover accepted
creates without duplication. Backups and receipts are private files; protect
them as application data.

Skill create/file-write requests allow 72 MiB at both the Core and Multica
console gateway, covering the native 50 MiB resource bundle plus JSON/base64
overhead. Other routes retain their existing request limits. This avoids
rejecting otherwise valid directory imports or migrations at the default
1 MiB Core parser limit.


Local startup validation, after native preparation and build:

```bash
node --test scripts/agent-memory-startup.e2e.mjs
```

This runs the real native services on temporary ports and private data roots,
checks concurrent app-start requests, process reuse, foreign-port protection,
and knowledge persistence after a cold restart. It makes no model requests.

Real desktop daemon retrieval acceptance (explicit model use):

```bash
node apps/desktop/scripts/bundle-cli.mjs
bash scripts/dev-env.sh exec -- env MULTICA_RUN_REAL_AGENT_SMOKE=1 \
  MULTICA_KNOWLEDGE_CLI_PATH="$PWD/apps/desktop/resources/bin/multica" \
  MULTICA_KNOWLEDGE_CODEX_MODEL=<available-model> \
  pnpm exec playwright test e2e/desktop-cli-knowledge.spec.ts
```

This starts the bundled CLI's real daemon in an isolated profile/workspace, then
runs a real Codex chat task. Acceptance requires actual search/read tool calls,
CLI path evidence, and a full-text marker beyond the automatically recalled
excerpt. The default test suite skips this case without explicit opt-in.


## Native context acceptance

`e2e/memory-context.spec.ts` checks native L3 injection, team-owned Skill
catalogs, private isolation, shared bindings, detach and internal endpoint auth.
`e2e/native-memory-context.spec.ts` requires explicit real-agent opt-in and runs
a producer issue, confirms no extraction before Done, waits for native extraction,
then uses a separate agent sharing the memory to search and read the original
history and a full Skill. Chat completion must not create another extraction.
Use the same environment and opt-in variables as the paired CLI smoke, selecting
this test file. Native Proxy's optional cost-guard module is absent in the local
standalone setup; its full typecheck retains the existing unresolved-module error.
