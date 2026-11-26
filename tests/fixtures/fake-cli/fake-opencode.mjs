// Stands in for `opencode` in tests: answers --version, and for `run` logs what it was given (arguments,
// prompt, working folder) to $FAKE_LOG, then prints the JSONL events a real run would. A prompt containing
// "SIGNED-OUT" fails the way OpenCode does when no provider is signed in.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.3.2'); process.exit(0); }
// The map asks OpenCode's own server API for models, lazily. Log it like a run so tests can count calls.
const logApi = () => { if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ kind: 'api', args, cwd: process.cwd() }) + '\n'); };
const model = (providerID, id, name, { free = false, tools = true, type = 'chat', enabled = true, status = 'active' } = {}) => ({
  id, modelID: id, providerID, type, name,
  capabilities: { tools, input: ['text'], output: ['text'] },
  cost: free ? [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] : [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
  limit: { context: 1000000, output: 128000 },
  enabled, status,
});
const MODELS = [
  model('opencode', 'seaglass-alpha-free', 'Seaglass Alpha Free', { free: true }),
  model('opencode-go', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'),
  model('opencode-go', 'mimo-v2.6-pro', 'MiMo-V2.6-Pro'),
  model('opencode', 'hy4-flash-free', 'Hy4 Flash Free', { free: true }),
  model('opencode', 'no-tools', 'No Tools', { tools: false }),
  model('opencode', 'hidden-image', 'Image Only', { type: 'image' }),
  model('opencode', 'disabled-model', 'Disabled Model', { enabled: false }),
];
if (args.includes('api')) {
  logApi();
  if (process.env.FAKE_NO_MODEL_API) { console.error('unknown command: api'); process.exit(1); }
  const endpoint = args[args.length - 1];
  const data = endpoint === '/api/model/default' ? MODELS[0] : MODELS;
  console.log(JSON.stringify({ data }));
  process.exit(0);
}
if (args[0] === 'models') {
  logApi();
  console.log(MODELS.map((m) => `${m.providerID}/${m.id}`).join('\n'));
  process.exit(0);
}
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input, cwd: process.cwd() }) + '\n');
  const out = (ev) => console.log(JSON.stringify(ev));
  const sessionID = 'ses_test_opencode';
  if (input.includes('SIGNED-OUT')) {
    out({ type: 'error', sessionID, error: { type: 'provider.auth', message: 'You are not logged in. Run opencode auth login.' } });
    process.exitCode = 1;
    return;
  }
  if (input.includes('FREE-MODEL')) {
    out({ type: 'error', sessionID, error: { type: 'provider.privacy', message: 'Free models may train on request data. Turn on "Allow free endpoints that train on request data" at https://opencode.ai/console/org_test/settings/privacy#training to use them.' } });
    process.exitCode = 1;
    return;
  }
  out({ type: 'step_start', sessionID, part: { type: 'step-start' } });
  out({ type: 'tool_use', sessionID, part: { type: 'tool', tool: 'shell', state: { status: 'completed', input: { command: 'node floorplan/query.mjs find "refund"' } } } });
  out({ type: 'tool_use', sessionID, part: { type: 'tool', tool: 'read', state: { status: 'completed', input: { path: 'shop-api/routes/orders.js' } } } });
  out({ type: 'step_finish', sessionID, part: { type: 'step-finish', reason: 'tool-calls' } });
  out({ type: 'step_start', sessionID, part: { type: 'step-start' } });
  out({
    type: 'text', sessionID,
    part: {
      type: 'text',
      text: JSON.stringify({
        title: 'Refunds', answer: 'Refunds go through [[f:shop-api/routes/orders.js]].',
        items: [{ id: 'f:shop-api/routes/orders.js', note: 'Holds the refund endpoint.' }],
        steps: [], followups: ['Who can ask for one?'],
      }),
    },
  });
  out({ type: 'step_finish', sessionID, part: { type: 'step-finish', reason: 'stop' } });
});
