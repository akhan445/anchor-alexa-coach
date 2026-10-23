// Anchor: an adaptive routine coach MCP server. Tools live in tools.js, logic in routines.js.
//
// How a request flows:
//   Alexa+ (the MCP client) --HTTP POST /mcp--> Express --> MCP transport --> your tool function
//   Your tool returns text --> transport wraps it as JSON-RPC --> Alexa+ speaks it.
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';
import { chat, reset } from './agent.js';
import { load, resetUser } from './store.js';
import { newDay } from './routines.js';
import { todaysAnchors, formatTime } from './anchors.js';
import { synthesize } from './voice.js';

const PORT = process.env.PORT || 3000;

// ctx = who is talking and what time it is for them. With real Alexa+ the user would come from
// account linking; in the demo the simulator sends them as headers (and can move the clock forward).
function buildServer(ctx) {
  const server = new McpServer({ name: 'anchor', version: '1.0.0' });
  registerTools(server, ctx);
  return server;
}

const app = express();
app.use(express.json());

// Stateless mode: every POST gets a fresh server + transport, so there are no sessions to track.
// Everything worth remembering lives in data/users/<user>.json.
app.post('/mcp', async (req, res) => {
  const ctx = {
    userId: req.get('x-anchor-user') || 'bob',
    now: req.get('x-anchor-now') ? new Date(req.get('x-anchor-now')) : new Date(),
  };
  const server = buildServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/health', (_req, res) => res.send('ok'));
// MCP clients only POST here. A browser visiting /mcp gets a pointer to the app instead of "Cannot GET".
app.get('/mcp', (_req, res) => res.status(405).send(`This is Anchor's MCP endpoint (for Alexa+, not browsers). Open http://localhost:${PORT} for the app.`));

// The simulated Alexa+ (public/index.html) talks to this. It is a separate MCP *client*:
// it reaches Anchor only through POST /mcp above, the same way real Alexa+ would.
app.use(express.static('public'));
app.post('/api/chat', async (req, res) => {
  const { text, user = 'bob', now } = req.body;
  try {
    res.json(await chat(text, { user, now, mcpUrl: `http://localhost:${PORT}/mcp` }));
  } catch (err) {
    console.error('[agent]', err);
    res.status(500).json({ reply: `Something went wrong: ${err.message}`, trace: [], reminders: [] });
  }
});
// Alexa's voice (Amazon Polly). The page falls back to the browser's voice if this fails.
app.post('/api/speak', async (req, res) => {
  if (process.env.BEDROCK_MOCK) return res.status(503).send('Voice is off in mock mode');
  try {
    res.type('audio/mpeg').send(await synthesize(req.body.text || ''));
  } catch (err) {
    console.warn(`[polly] ${err.name}: ${err.message}`);
    res.status(503).send(err.message);
  }
});
// Wipes one demo user back to the starting state (conversation, reminders and saved data).
app.post('/api/reset', (req, res) => {
  reset(req.body.user || 'bob');
  resetUser(req.body.user || 'bob');
  res.json({ ok: true });
});

// Today's anchors for a user, so the page shows their reminders after a refresh.
app.post('/api/today', (req, res) => {
  const now = req.body.now ? new Date(req.body.now) : new Date();
  res.json({ reminders: todaysAnchors(load(req.body.user || 'bob'), now).map(a => ({ label: a.name, time: formatTime(a.at) })) });
});

// Keeps the user's setup, clears today (plan, running routine, conversation), and returns today's reminders.
app.post('/api/new-day', (req, res) => {
  const user = req.body.user || 'bob';
  const now = req.body.now ? new Date(req.body.now) : new Date();
  newDay(user);
  const anchors = todaysAnchors(load(user), now).map(a => ({ label: a.name, time: formatTime(a.at) }));
  reset(user, anchors);
  res.json({ reminders: anchors });
});

app.listen(PORT, () => console.log(`Anchor MCP server on http://localhost:${PORT}/mcp\nOpen the app at http://localhost:${PORT}`));
