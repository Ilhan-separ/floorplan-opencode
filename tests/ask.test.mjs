// Asking questions on the map: serve.mjs runs the Claude Code CLI or Codex on the person's own sign-in,
// read-only, and turns their event stream into progress lines and an answer board. Stand-in CLIs
// (fixtures/fake-cli) record what they were given, so these run without either one installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO, shopApp, run, cleanup } from './helpers.mjs';

const FAKE = path.join(REPO, 'tests', 'fixtures', 'fake-cli');
let root;
const servers = [];

/** Starts the map's server with these environment overrides; returns { base, token, page, log }. */
async function serve(env, { keepModel = false } = {}) {
  const modelFile = path.join(root, 'floorplan', '.cache', 'model.json');
  if (!keepModel) fs.rmSync(modelFile, { force: true });
  const log = path.join(root, `fake-${servers.length}.log`);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open'], {
    cwd: root, env: { ...process.env, FLOORPLAN_NO_PROMPTS: '1', FLOORPLAN_ENGINE: '', FAKE_LOG: log, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(server);
  const base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Floorplan: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
  const html = await (await fetch(base + '/')).text();
  const page = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(html)[1]);
  return {
    base, token: page.token, page, proc: server,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}
/** A JSON request with the map server's token; the response's status and parsed body. */
async function api(s, method, pathname, body) {
  const r = await fetch(s.base + pathname, {
    method,
    headers: { 'x-floorplan-token': s.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json() };
}
const runCalls = (s) => s.calls().filter((c) => c.kind !== 'api');
const apiCalls = (s) => s.calls().filter((c) => c.kind === 'api');

/** Asks one question and returns its server-sent events as [{ event, data }]. */
async function ask(s, question, session) {
  const r = await fetch(s.base + '/api/ask', { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': s.token }, body: JSON.stringify({ question, session }) });
  return (await r.text()).split('\n\n').filter(Boolean).map((b) => ({ event: /^event: (\w+)/.exec(b)[1], data: JSON.parse(/^data: (.*)$/m.exec(b)[1]) }));
}
const pick = (events, name) => events.filter((e) => e.event === name).map((e) => e.data);

// built "by Claude Code" whichever agent runs the tests, so the engine order below is predictable
before(() => { root = shopApp(); run('scan.mjs', root); run('build.mjs', root, '--no-claude-md', '--agent', 'claude'); });
after(async () => {
  // wait for the servers to exit first: on Windows their working folder can't be removed while they run
  await Promise.all(servers.filter((s) => s.exitCode === null).map((s) => new Promise((resolve) => { s.once('exit', resolve); s.kill(); })));
  cleanup(root);
});

test('with only Codex installed, questions run through Codex, read-only and out of its history', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(FAKE, 'fake-codex.mjs') });
  assert.equal(s.page.engine, 'codex');
  assert.equal(s.page.cli, true);

  const events = await ask(s, 'How do refunds work?');
  assert.deepEqual(pick(events, 'progress').map((p) => p.text), ['Searching the map for "refund"', 'Reading shop-api/routes/orders.js']);
  const [answer] = pick(events, 'answer');
  assert.equal(answer.title, 'Refunds');
  assert.deepEqual(answer.items.map((i) => i.id), ['f:shop-api/routes/orders.js']);
  assert.match(answer.session, /^[0-9a-f]{16}$/);

  const [call] = s.calls();
  const flag = (name) => call.args[call.args.indexOf(name) + 1];
  assert.equal(call.args[0], 'exec');
  assert.equal(flag('--sandbox'), 'read-only');
  assert.ok(call.args.includes('--ephemeral'), 'nothing is saved to the Codex history');
  // Node runs serve.mjs from its real path, and on macOS the temp folder /var/… is really /private/var/…
  assert.equal(fs.realpathSync(flag('-C')), fs.realpathSync(root));
  assert.match(call.input, /How do refunds work\?/);
  assert.match(call.input, /node floorplan\/query\.mjs/);
});

test('Codex gets an answer schema it accepts: every property required, nothing extra', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(FAKE, 'fake-codex.mjs') });
  await ask(s, 'What is this?');
  const { schema } = s.calls()[0];
  const check = (node, where) => {
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, where);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), where);
      for (const [k, v] of Object.entries(node.properties)) check(v, `${where}.${k}`);
    }
    if (node.type === 'array') check(node.items, `${where}[]`);
  };
  check(schema, 'answer');
  assert.ok(schema.required.includes('steps') && schema.required.includes('followups'));
});

test('a Codex follow-up carries the conversation so far', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(FAKE, 'fake-codex.mjs') });
  const [first] = pick(await ask(s, 'How do refunds work?'), 'answer');
  const [second] = pick(await ask(s, 'Who can ask for one?', first.session), 'answer');
  assert.equal(second.session, first.session);
  const calls = s.calls();
  assert.doesNotMatch(calls[0].input, /Earlier in this conversation/);
  assert.match(calls[1].input, /Earlier in this conversation:\nQ: How do refunds work\?\nA: Refunds go through/);
  // an unknown session starts a fresh conversation
  const [other] = pick(await ask(s, 'Start over', 'not-a-session'), 'answer');
  assert.notEqual(other.session, first.session);
  assert.doesNotMatch(s.calls()[2].input, /Earlier in this conversation/);
});

test('a signed-out Codex says so, so the map can tell the person to sign in', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(FAKE, 'fake-codex.mjs') });
  const [failure] = pick(await ask(s, 'SIGNED-OUT question'), 'failure');
  assert.equal(failure.code, 'not_logged_in');
  assert.equal(pick(await ask(s, 'SIGNED-OUT again'), 'answer').length, 0);
});

test('with only OpenCode installed, questions run through its read-only Plan agent, out of its session list', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_OPENCODE: path.join(FAKE, 'fake-opencode.mjs') });
  assert.equal(s.page.engine, 'opencode');
  assert.equal(s.page.cli, true);

  const events = await ask(s, 'How do refunds work?');
  assert.deepEqual(pick(events, 'progress').map((p) => p.text), ['Searching the map for "refund"', 'Reading shop-api/routes/orders.js']);
  const [answer] = pick(events, 'answer');
  assert.equal(answer.title, 'Refunds');
  assert.deepEqual(answer.items.map((i) => i.id), ['f:shop-api/routes/orders.js']);
  assert.match(answer.session, /^[0-9a-f]{16}$/);

  const [call] = s.calls();
  assert.equal(call.args[0], 'run');
  assert.equal(call.args[call.args.indexOf('--format') + 1], 'json');
  assert.ok(call.args.includes('--archived'), 'Ask sessions stay out of the OpenCode session list');
  assert.equal(call.args[call.args.indexOf('--agent') + 1], 'plan');
  assert.equal(call.args[call.args.length - 1], '-');
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(root));
  assert.match(call.input, /How do refunds work\?/);
  assert.match(call.input, /node floorplan\/query\.mjs/);
});

test('an OpenCode follow-up carries the conversation so far', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_OPENCODE: path.join(FAKE, 'fake-opencode.mjs') });
  const [first] = pick(await ask(s, 'How do refunds work?'), 'answer');
  const [second] = pick(await ask(s, 'Who can ask for one?', first.session), 'answer');
  assert.equal(second.session, first.session);
  const calls = s.calls();
  assert.doesNotMatch(calls[0].input, /Earlier in this conversation/);
  assert.match(calls[1].input, /Earlier in this conversation:\nQ: How do refunds work\?\nA: Refunds go through/);
  const [other] = pick(await ask(s, 'Start over', 'not-a-session'), 'answer');
  assert.notEqual(other.session, first.session);
  assert.doesNotMatch(s.calls()[2].input, /Earlier in this conversation/);
});

test('a signed-out OpenCode says so, so the map can tell the person to sign in', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_OPENCODE: path.join(FAKE, 'fake-opencode.mjs') });
  const [failure] = pick(await ask(s, 'SIGNED-OUT question'), 'failure');
  assert.equal(failure.code, 'not_logged_in');
  assert.equal(pick(await ask(s, 'SIGNED-OUT again'), 'answer').length, 0);
});

test('--engine opencode and --model are passed through to OpenCode', async () => {
  const s = await serve({ FLOORPLAN_ENGINE: 'opencode', FLOORPLAN_MODEL: 'opencode-go/deepseek-v4.1-flash', FLOORPLAN_CLAUDE: path.join(FAKE, 'fake-claude.mjs'), FLOORPLAN_OPENCODE: path.join(FAKE, 'fake-opencode.mjs') });
  assert.equal(s.page.engine, 'opencode');
  assert.equal(s.page.want, 'opencode');
  assert.match(s.page.model, /deepseek/);
  await ask(s, 'How do refunds work?');
  const [call] = s.calls();
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'opencode-go/deepseek-v4.1-flash');
});

test('the model picker resolves OpenCode’s default with one call and no list', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_OPENCODE: path.join(FAKE, 'fake-opencode.mjs') });
  assert.equal(s.page.model, null, 'no model was chosen, so the page starts without one');
  const r = await api(s, 'GET', '/api/models');
  assert.equal(r.status, 200);
  assert.equal(r.body.supported, true);
  assert.equal(r.body.current.id, 'opencode/seaglass-alpha-free');
  assert.equal(r.body.current.free, true);
  assert.equal(r.body.current.source, 'default');
  assert.equal(r.body.models, undefined, 'the list waits until the picker opens');
  assert.equal(apiCalls(s).length, 1);
  assert.equal(apiCalls(s)[0].args.at(-1), '/api/model/default');
  assert.equal(runCalls(s).length, 0, 'showing the model asks no question');
  await api(s, 'GET', '/api/models');
  assert.equal(apiCalls(s).length, 1, 'a reload uses the server’s cache');
});

test('the model list is fetched only when asked, grouped by provider, with no OpenCode secrets', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_OPENCODE: path.join(FAKE, 'fake-opencode.mjs') });
  const r = await api(s, 'GET', '/api/models?list=1');
  assert.equal(r.status, 200);
  assert.deepEqual([...new Set(r.body.models.map((m) => m.provider))], ['opencode-go', 'opencode'], 'OpenCode Go first');
  const deepseek = r.body.models.find((m) => m.id === 'opencode-go/deepseek-v4.1-flash');
  assert.deepEqual(deepseek, {
    id: 'opencode-go/deepseek-v4.1-flash', provider: 'opencode-go', providerName: 'OpenCode Go',
    name: 'DeepSeek V4.1 Flash', free: false, tools: true, context: 1000000,
  });
  assert.ok(r.body.models.some((m) => m.id === 'opencode/no-tools' && m.tools === false));
  assert.ok(!r.body.models.some((m) => m.id === 'opencode/hidden-image'), 'only chat models');
  assert.ok(!r.body.models.some((m) => m.id === 'opencode/disabled-model'), 'disabled models stay hidden');
  assert.doesNotMatch(JSON.stringify(r.body), /"headers"|x-opencode-org-id/, 'the API’s headers and org details stay on this computer');
  const calls = apiCalls(s).length;
  const again = await api(s, 'GET', '/api/models?list=1');
  assert.equal(apiCalls(s).length, calls, 'a second look uses the cache');
  assert.equal(again.body.models.length, r.body.models.length);
});

test('choosing a model saves it and the next question runs with --model', async () => {
  const env = { FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_OPENCODE: path.join(FAKE, 'fake-opencode.mjs') };
  const s = await serve(env);
  await api(s, 'GET', '/api/models?list=1');
  const r = await api(s, 'POST', '/api/models', { model: 'opencode-go/deepseek-v4.1-flash' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.current.id, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(r.body.current.source, 'picked');
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'floorplan', '.cache', 'model.json'), 'utf8'));
  assert.equal(saved.engine, 'opencode');
  assert.equal(saved.model, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(saved.meta.name, 'DeepSeek V4.1 Flash');

  const reloaded = await (await fetch(s.base + '/')).text();
  const page = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(reloaded)[1]);
  assert.equal(page.model, 'opencode-go/deepseek-v4.1-flash', 'a reload carries the chosen model');
  assert.equal(page.modelName, 'DeepSeek V4.1 Flash');
  assert.equal(page.modelSource, 'picked');

  await ask(s, 'How do refunds work?');
  const run = runCalls(s).at(-1);
  assert.equal(run.args[run.args.indexOf('--model') + 1], 'opencode-go/deepseek-v4.1-flash');
  const calls = apiCalls(s).length;
  const current = await api(s, 'GET', '/api/models');
  assert.equal(current.body.current.id, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(apiCalls(s).length, calls, 'a chosen model needs no OpenCode API call');
});

test('a chosen model comes back after a restart without asking OpenCode', async () => {
  const env = { FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_OPENCODE: path.join(FAKE, 'fake-opencode.mjs') };
  const s = await serve(env);
  await api(s, 'GET', '/api/models?list=1');
  await api(s, 'POST', '/api/models', { model: 'opencode-go/deepseek-v4.1-flash' });
  await new Promise((resolve) => { s.proc.once('exit', resolve); s.proc.kill(); });
  const t = await serve(env, { keepModel: true });
  assert.equal(t.page.model, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(t.page.modelName, 'DeepSeek V4.1 Flash');
  assert.equal(t.page.modelSource, 'saved');
  const r = await api(t, 'GET', '/api/models');
  assert.equal(r.body.current.id, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(apiCalls(t).length, 0, 'the saved choice carries its name and details');
});

test('a model outside OpenCode’s list is refused and changes nothing', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_OPENCODE: path.join(FAKE, 'fake-opencode.mjs') });
  await api(s, 'GET', '/api/models?list=1');
  const r = await api(s, 'POST', '/api/models', { model: 'opencode-go/not-a-model' });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  const noTools = await api(s, 'POST', '/api/models', { model: 'opencode/no-tools' });
  assert.equal(noTools.status, 400);
  assert.match(noTools.body.error, /tools/i);
  const current = await api(s, 'GET', '/api/models');
  assert.equal(current.body.current.id, 'opencode/seaglass-alpha-free');
});

test('the free-model error is named so the map can offer the picker', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_OPENCODE: path.join(FAKE, 'fake-opencode.mjs') });
  const [failure] = pick(await ask(s, 'FREE-MODEL question'), 'failure');
  assert.equal(failure.code, 'free_model');
  assert.match(failure.message, /opencode\.ai\/console/);
});

test('an older OpenCode without the model API still lists models and asks', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'no-such-cli'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli'), FLOORPLAN_OPENCODE: path.join(FAKE, 'fake-opencode.mjs'), FAKE_NO_MODEL_API: '1' });
  const r = await api(s, 'GET', '/api/models?list=1');
  assert.equal(r.status, 200);
  assert.equal(r.body.current, null, 'the default is unknown without the API, but the list still works');
  assert.ok(r.body.models.some((m) => m.id === 'opencode-go/deepseek-v4.1-flash'));
  const chosen = await api(s, 'POST', '/api/models', { model: 'opencode-go/deepseek-v4.1-flash' });
  assert.equal(chosen.status, 200);
  await ask(s, 'How do refunds work?');
  const run = runCalls(s).at(-1);
  assert.equal(run.args[run.args.indexOf('--model') + 1], 'opencode-go/deepseek-v4.1-flash');
});

test('the Claude Code CLI comes first for a map Claude built, with read-only tools, and follow-ups resume', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(FAKE, 'fake-claude.mjs'), FLOORPLAN_CODEX: path.join(FAKE, 'fake-codex.mjs') });
  assert.equal(s.page.engine, 'claude');
  const events = await ask(s, 'How do refunds work?');
  assert.deepEqual(pick(events, 'progress').map((p) => p.text), ['Reading the map overview', 'Reading shop-api/routes/orders.js']);
  const [answer] = pick(events, 'answer');
  assert.equal(answer.session, 'test-session');
  await ask(s, 'And then?', answer.session);
  const [first, second] = s.calls();
  assert.ok(first.args.includes('-p'));
  assert.deepEqual(first.args.slice(first.args.indexOf('--allowedTools') + 1), ['Bash(node floorplan/query.mjs:*)', 'Read', 'Grep', 'Glob']);
  assert.ok(first.args.slice(first.args.indexOf('--disallowedTools') + 1).includes('Read(floorplan/index.html)'), 'the generated map page is off limits');
  // none of the person's MCP servers: the empty config arrives as one argument, exactly, on every platform
  assert.ok(first.args.includes('--strict-mcp-config'), 'only the MCP servers given here');
  assert.equal(first.args[first.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.deepEqual(JSON.parse(first.args[first.args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
  assert.ok(second.args.includes('--strict-mcp-config') && second.args.includes('--mcp-config'), 'follow-ups too');
  assert.equal(first.input, 'How do refunds work?');
  assert.equal(second.args[second.args.indexOf('--resume') + 1], 'test-session');
});

test('a person with many MCP servers still gets answers: Claude Code is started with none of them', async () => {
  const s = await serve({ FAKE_MANY_MCP: '1', FLOORPLAN_CLAUDE: path.join(FAKE, 'fake-claude.mjs'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli') });
  const events = await ask(s, 'How do refunds work?');
  assert.deepEqual(pick(events, 'failure'), []);
  assert.equal(pick(events, 'answer')[0]?.title, 'Refunds');
  // the same for the other kinds of request: a new guided flow
  const flow = await fetch(s.base + '/api/ask', { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': s.token }, body: JSON.stringify({ question: 'Show checkout', mode: 'flow' }) });
  assert.doesNotMatch(await flow.text(), /Prompt is too long/);
  for (const call of s.calls()) assert.equal(call.args[call.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
});

test('--engine picks one CLI and never falls back to the other', async () => {
  const s = await serve({ FLOORPLAN_ENGINE: 'codex', FLOORPLAN_CLAUDE: path.join(FAKE, 'fake-claude.mjs'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli') });
  assert.equal(s.page.cli, false);
  assert.equal(s.page.want, 'codex');
  const [failure] = pick(await ask(s, 'Anything?'), 'failure');
  assert.equal(failure.code, 'cli_missing');
  assert.match(failure.message, /Codex not found/);
});

// Windows: a newer npm install of Claude Code has the real program at <npm>/node_modules/@anthropic-ai/claude-code/bin/claude.exe, no cli.js, and only
// shell shims beside it (the extensionless "claude" that `where claude` lists first, and claude.cmd), which can't be spawned. The server must use the real program.
test('on Windows, a Claude Code npm install with only bin/claude.exe is found and run (not the shell shim)', { skip: process.platform !== 'win32' }, async () => {
  const npm = path.join(root, 'fake-npm');
  const pkg = path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(npm, 'claude'), '#!/bin/sh\n'); // the shim: a text file that can't be run
  const fakeExe = path.join(pkg, 'claude.exe');
  fs.copyFileSync(process.execPath, fakeExe); // a program that answers --version (a copy, not a link: a link can't be removed afterwards on some Windows runners)
  fs.chmodSync(fakeExe, 0o666); // the copy keeps Node's read-only flag, which stops the folder being cleaned up
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(npm, 'claude'), FLOORPLAN_CODEX: path.join(root, 'no-such-cli') });
  assert.equal(s.page.engine, 'claude');
  assert.equal(s.page.version, process.version);
});
