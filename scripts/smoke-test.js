// Acts like Alexa+ would: connect over MCP, then run a first-time user through setup and a day.
// Prints how long each call takes, since Alexa+ needs answers within 500 ms.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.MCP_URL || 'http://localhost:3000/mcp');
const user = `smoke-${Date.now()}`;

async function at(time) {
  const now = new Date();
  const [h, m] = time.split(':').map(Number);
  now.setHours(h, m, 0, 0);
  const client = new Client({ name: 'smoke-test', version: '0.0.1' });
  const headers = { 'x-anchor-user': user, 'x-anchor-now': now.toISOString() };
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return async (name, args = {}) => {
    const t = Date.now();
    const result = await client.callTool({ name, arguments: args });
    console.log(`[${time}] ${name} (${Date.now() - t} ms): ${result.content[0].text}\n`);
  };
}

let call = await at('07:00');
await call('get_started');
await call('set_anchors', { mode: 'custom', anchors: [{ name: 'Lunch', time: '12:00' }, { name: 'Work ends', time: '17:00' }] });
await call('set_routine', { routine: 'morning', time: '07:30', steps: [{ name: 'Make the bed', minutes: 2 }, { name: 'Shower', minutes: 15 }] });
await call('set_routine', { routine: 'evening', time: '22:00', steps: [{ name: 'Read', minutes: 20 }] });
await call('plan_tasks', { anchor: 'Lunch', tasks: ['Finish the API'], when: 'before' });
await call('plan_tasks', { anchor: 'Lunch', tasks: ['Drink water'], when: 'at' });
await call('get_day');

call = await at('07:30');
await call('start_routine', { routine: 'morning' });
await call('next_step');
await call('next_step');

call = await at('12:00');
await call('anchor_arrived', { anchor: 'Lunch' });
await call('check_in', { anchor: 'Lunch', reflection: 'Finished the API, a bit tired.', done: ['Finish the API'] });
