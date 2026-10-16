import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

// Real HTTP and child-process boundary; never discovers or executes ambient Codex.
test('workspace inference settings survive restart and reach CLI arguments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-runtime-e2e-'));
  const cli = join(dir, 'fake-codex.mjs');
  const records = join(dir, 'calls.jsonl');
  await writeFile(cli, `#!/usr/bin/env node
import {writeFile,appendFile} from 'node:fs/promises';
const args=process.argv.slice(2);
if(args[0]==='debug') {console.log(JSON.stringify({models:[{slug:'test-model',display_name:'Test Model',visibility:'list',default_reasoning_level:'medium',supported_reasoning_levels:[{effort:'low'},{effort:'medium'},{effort:'high'}]}]}));process.exit(0);}
await appendFile(process.env.TEST_RECORDS,JSON.stringify(args)+'\\n');
let input='';for await(const chunk of process.stdin) input+=chunk;
if(input.includes('timeout-fixture')) await new Promise(r=>setTimeout(r,30000));
if(input.includes('failed-fixture')) process.exit(1);
const content=input.includes('single-angle-file-fixture') ? '<<<FILE path="wiki/sources/source.md">\\n---\\ntype: source\\n---\\nFixture page\\n<<<END>>>\\n<<<FILE path="../escape.md">\\nUnsafe\\n<<<END>>>\\n<<<FILE path="wiki/sources/truncated.md">\\nTruncated' : 'fixture answer';
await writeFile(args[args.indexOf('--output-last-message')+1],JSON.stringify({content,tool_calls:[]}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:3}}));
`);
  await chmod(cli, 0o700);
  let child;
  let base;
  async function start(timeout = '5000') {
    const port = await new Promise(resolvePort => {
      const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolvePort(port)); });
    });
    child = spawn(process.execPath, [resolve('scripts/agent-memory-runtime.mjs')], { env: { ...process.env, TEST_RECORDS: records, MULTICA_MEMORY_RUNTIME_PORT: String(port), MULTICA_MEMORY_RUNTIME_TOKEN: 'fixture-token', MULTICA_MEMORY_RUNTIME_COMMAND: cli, MULTICA_MEMORY_RUNTIME_MODEL: 'test-model', MULTICA_MEMORY_RUNTIME_SETTINGS: join(dir, 'settings.json'), MULTICA_MEMORY_RUNTIME_TIMEOUT_MS: timeout }, stdio: ['ignore', 'pipe', 'pipe'] });
    base = `http://127.0.0.1:${port}`;
    let diagnostics = ''; child.stderr.on('data', chunk => diagnostics += chunk);
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/health')).ok) return; } catch { /* Starting. */ }
      if (child.exitCode !== null) throw new Error(diagnostics);
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('runtime did not start');
  }
  async function stop() { if (child?.exitCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; } }
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-token', ...headers }, body: JSON.stringify(body) });
  const scope = { instance_id: 'instance-a', team_id: 'team-a' };
  const inference = (content, scoped = true) => post('/v1/chat/completions', { model: 'codex', messages: [{ role: 'user', content }] }, scoped ? { 'X-Multica-Memory-Instance': 'instance-a', 'X-Multica-Memory-Team': 'team-a' } : {});
  try {
    await start();
    assert.equal((await fetch(base + '/settings/get', { method: 'POST' })).status, 401);
    assert.equal((await post('/settings/get', {})).status, 400);
    assert.equal((await post('/settings/set', { ...scope, model: 'test-model', effort: 'ultra' })).status, 400);
    let response = await post('/settings/set', { ...scope, model: 'test-model', effort: 'high' });
    assert.equal(response.status, 200); assert.equal((await response.json()).effort, 'high');
    assert.equal((await (await post('/settings/get', { ...scope, team_id: 'team-b' })).json()).effort, 'medium');
    assert.equal((await (await post('/settings/get', { ...scope, instance_id: 'instance-b' })).json()).effort, 'medium');
    assert.equal((await inference('fixture')).status, 200);
    let calls = (await readFile(records, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 1); assert.equal(calls[0][calls[0].indexOf('--model') + 1], 'test-model');
    assert.ok(calls[0].includes('model_reasoning_effort="high"'));
    assert.ok(calls[0].includes('--ignore-user-config'));
    // When prepared, exercise both actual upstream SDK providers against the fake CLI.
    // This catches dropped workspace headers, including Core's trace-context path.
    if (existsSync('.agent-memory/upstream/MemoryCore/node_modules/tsx')) {
      const invoke = promisify(execFile);
      const coreSource = `
        import assert from 'node:assert/strict';
        import { StandaloneLLMRunner } from './src/adapters/standalone/llm-runner.ts';
        import { buildTraceParams } from './src/core/types.ts';
        const runner = new StandaloneLLMRunner({config:{baseUrl:process.env.TEST_RUNTIME_URL+'/v1',apiKey:'fixture-token',model:'codex'},enableTools:false});
        await runner.run({prompt:'fixture',taskId:'test',...buildTraceParams('memory.l1-extract',{instanceId:'instance-a',teamId:'team-a'})});
        await assert.rejects(runner.run({prompt:'failed-fixture',taskId:'test',...buildTraceParams('memory.l1-extract',{instanceId:'instance-a',teamId:'team-a'})}));
      `;
      const knowledgeSource = `
        import assert from 'node:assert/strict';
        import { createLlmClient } from './src/engines/wiki/ingest-v2/llm.ts';
        import { parseFileBlocks } from './src/engines/wiki/ingest-v2/file-protocol.ts';
        const client=createLlmClient({baseUrl:process.env.TEST_RUNTIME_URL+'/v1',apiKey:'fixture-token',model:'codex',maxRetries:0,headers:{'X-Multica-Memory-Instance':'instance-a','X-Multica-Memory-Team':'team-a'}});
        const text = await client.chat({system:'fixture',prompt:'single-angle-file-fixture'});
        const parsed = parseFileBlocks(text);
        assert.equal(parsed.files.length,1);
        assert.equal(parsed.files[0].path,'wiki/sources/source.md');
        assert.equal(parsed.warnings.length,2);
        await assert.rejects(client.chat({system:'fixture',prompt:'failed-fixture'}));
      `;
      for (const [component, source] of [['MemoryCore', coreSource], ['MemoryKnowledge', knowledgeSource]]) {
        await invoke(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: resolve('.agent-memory/upstream', component), env: { ...process.env, TEST_RUNTIME_URL: base, MULTICA_MEMORY_RUNTIME_URL: base }, timeout: 10000 });
      }
      calls = (await readFile(records, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(calls.length, 5);
      assert.ok(calls.every(args => args.includes('model_reasoning_effort="high"')));
    }
    await stop(); await start();
    assert.equal((await (await post('/settings/get', scope)).json()).effort, 'high');
    assert.equal((await inference('failed-fixture')).status, 502);
    await stop(); await start('700');
    assert.equal((await inference('timeout-fixture')).status, 504);
    await new Promise(r => setTimeout(r, 100));
    assert.equal((await (await fetch(base + '/health')).json()).busy, false);
    const pending = inference('timeout-fixture');
    const waiting = inference('fixture');
    assert.equal((await pending).status, 504);
    assert.ok([200, 504].includes((await waiting).status));
    assert.equal((await inference('fixture')).status, 200);
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});
