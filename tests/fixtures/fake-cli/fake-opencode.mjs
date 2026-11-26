// Stands in for `opencode` in tests: answers --version, and for `run` logs what it was given (arguments,
// prompt, working folder) to $FAKE_LOG, then prints the JSONL events a real run would. A prompt containing
// "SIGNED-OUT" fails the way OpenCode does when no provider is signed in.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.3.2'); process.exit(0); }
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
