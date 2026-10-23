// The simulated Alexa+ brain.
//
// Real Alexa+ would: hear the user, pick one of Anchor's tools, call it over MCP, and speak the result.
// We do the same thing here with Amazon Bedrock as the model:
//   1. connect to Anchor as an MCP client (over HTTP, exactly like Alexa+ would),
//   2. hand Anchor's tool list to Bedrock,
//   3. when Bedrock asks for a tool, call it over MCP and give the answer back,
//   4. repeat until Bedrock has a sentence to say.
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Nova Pro follows multi-step instructions far better than Nova Lite; still a few cents for a whole demo.
const MODEL_ID = process.env.AGENT_MODEL_ID || 'us.amazon.nova-pro-v1:0';
const FALLBACK_MODEL_ID = 'us.amazon.nova-lite-v1:0';
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

const NAMES = { bob: 'Bob', ahmed: 'Ahmed' };

const system = (user, now) => `You are Alexa, running the Anchor productivity coach. You're talking with ${NAMES[user.replace(/^test-/, '')] || user}.
It is ${now.toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' })}.

Personality: an upbeat, warm coach who's genuinely glad to help. Use their name now and then, react to what they say
("Nice, that's a strong start"), celebrate wins, and be encouraging when a block went badly. Vary your wording.
Everything you say is read aloud: natural sentences, no lists, markdown, emoji or headings. Usually 2 to 4 sentences;
setup explanations can be longer.

How to use the tools:
- At the start of the conversation, and whenever they ask to set up, plan or get started, call get_started and follow it.
  If their first message already gives their anchors (or asks for prayer times), skip get_started and call set_anchors straight away.
- Prayer times as anchors = set_anchors with mode "prayer". Anchor calculates the times itself: never ask the user for them.
- Tool results are facts and instructions for you, not a script. Say them in your own words, keep times and numbers exact,
  and follow any instruction in them (like which tool to call next or what to ask).
- Save things the moment the user gives them: anchors with set_anchors, a routine with set_routine, tasks with plan_tasks.
  Never ask for the next thing before saving the last one.
- Alexa sets a reminder for every anchor automatically whenever anchors or routines are saved. You don't need to do anything for that,
  but you can tell them their reminders are set.
- When a message says a reminder fired, call anchor_arrived, then greet them by name and do what it says.
- When they tell you how a block went, call check_in. If they also say what they'll do next ("I'll wrap up and hit the gym"),
  put that in check_in's next_tasks so it's saved as the plan for the next block.
- Several plans in one message ("code until lunch, meetings until work ends, gym before wind-down") = one plan_tasks call per anchor.
- "Remind me to X at Y" or "before Y I want to do X" is plan_tasks, not reflect_and_adjust.
- While a routine is running, "done" or "next" means next_step. If they also comment on the step, pass it as next_step's feedback.
- Never claim you changed, saved or scheduled something unless a tool result says so.
- Never make up anchors, routine steps, times or tasks. Save only what the user said; if something is missing, ask for it.`;

const histories = {}; // per user: the conversation so far
const pendingCheckIn = {}; // mock mode only: which anchor's reminder just fired
const reminders = {}; // per user: [{ time, label }]

async function connect(mcpUrl, user, now) {
  const mcp = new Client({ name: 'alexa-plus-simulator', version: '1.0.0' });
  const headers = { 'x-anchor-user': user, 'x-anchor-now': now.toISOString() };
  await mcp.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers } }));
  const list = await mcp.listTools();
  // MCP and Bedrock describe tools almost the same way; just rename the fields.
  const tools = list.tools.map(t => {
    const { $schema, ...schema } = t.inputSchema;
    return { toolSpec: { name: t.name, description: t.description, inputSchema: { json: schema } } };
  });
  return { mcp, tools };
}

async function runTool(mcp, user, name, input, trace) {
  const t = Date.now();
  let result;
  try {
    result = await mcp.callTool({ name, arguments: input });
  } catch (err) {
    // A bad argument shouldn't crash the conversation: tell the model so it can try again.
    result = { content: [{ text: `That tool call failed: ${err.message}` }] };
  }
  const output = result.content.map(c => c.text).join('\n');
  trace.push({ tool: name, input, output, ms: Date.now() - t, mcp: true });
  syncReminders(user, result.structuredContent?.anchorsToday, trace);
  return output;
}

// Alexa's own built-in reminders (not an Anchor tool: real Alexa+ already has these).
// Every Anchor answer carries today's anchors as structured data, so Alexa keeps one reminder per anchor
// in sync on its own, instead of trusting the model to copy every time correctly.
function syncReminders(user, anchorsToday, trace) {
  if (!anchorsToday) return;
  const key = list => JSON.stringify(list || []);
  if (key(anchorsToday) === key(reminders[user])) return;
  reminders[user] = anchorsToday;
  trace.push({ tool: 'set_reminders', input: { reminders: anchorsToday }, output: `${anchorsToday.length} reminders set`, mcp: false });
}

export async function chat(userText, { user, now, mcpUrl }) {
  now = now ? new Date(now) : new Date();
  const { mcp, tools } = await connect(mcpUrl, user, now);
  const history = (histories[user] ||= []);
  trimHistory(history);
  const before = history.length;
  history.push({ role: 'user', content: [{ text: userText }] });
  const trace = [];
  const done = reply => ({ reply, trace, reminders: reminders[user] || [] });

  try {
    if (process.env.BEDROCK_MOCK) return done(await mockChat(mcp, user, userText, trace));

    for (let turn = 0; turn < 10; turn++) {
      const response = await converse(user, now, history, tools);
      const message = cleanThinking(response.output.message);
      history.push(message);

      if (response.stopReason !== 'tool_use') {
        const reply = message.content.filter(c => c.text).map(c => c.text).join(' ').trim();
        return done(reply || "Sorry, could you say that again?");
      }

      // Bedrock asked for one or more tools. Run them and send the results back.
      const results = [];
      for (const block of message.content) {
        if (!block.toolUse) continue;
        const { toolUseId, name, input } = block.toolUse;
        const text = await runTool(mcp, user, name, input || {}, trace);
        results.push({ toolResult: { toolUseId, content: [{ text }] } });
      }
      history.push({ role: 'user', content: results });
    }
    const lost = 'Sorry, I got a bit lost there. Can you say that again?';
    history.push({ role: 'assistant', content: [{ text: lost }] }); // keep user/assistant turns alternating
    return done(lost);
  } catch (err) {
    // Undo this turn, so a half-finished tool exchange can't break every later request.
    history.splice(before);
    throw err;
  } finally {
    await mcp.close();
  }
}

// Long conversations make the model slower and more likely to repeat old turns. Everything that matters
// is saved in Anchor anyway, so keep only the recent part, cut at a message the user typed or said.
function trimHistory(history, keep = 30) {
  if (history.length <= keep) return;
  let start = history.length - keep;
  while (start < history.length - 1 && !(history[start].role === 'user' && history[start].content[0]?.text)) start++;
  history.splice(0, start);
}

let activeModel = MODEL_ID;

async function converse(user, now, history, tools) {
  const request = model =>
    bedrock.send(
      new ConverseCommand({
        modelId: model,
        system: [{ text: system(user, now) }],
        messages: history,
        toolConfig: { tools },
        inferenceConfig: { maxTokens: 800, temperature: 0.3 }, // low: same input, same behaviour, every run
      })
    );
  try {
    return await request(activeModel);
  } catch (err) {
    // Busy? Wait a moment and try once more.
    if (/Throttling|ServiceUnavailable|ModelNotReady/.test(err.name)) {
      await new Promise(r => setTimeout(r, 1500));
      return request(activeModel);
    }
    // No access to the bigger model on this AWS account? Fall back to Nova Lite for the rest of the run.
    // (Only for access problems: other validation errors must not silently downgrade the model.)
    const noAccess = /AccessDenied|ResourceNotFound/.test(err.name) || (err.name === 'ValidationException' && /model|access|throughput/i.test(err.message));
    if (activeModel !== FALLBACK_MODEL_ID && noAccess) {
      console.warn(`[agent] ${activeModel} unavailable (${err.name}); using ${FALLBACK_MODEL_ID}`);
      activeModel = FALLBACK_MODEL_ID;
      return request(activeModel);
    }
    throw err;
  }
}

// Nova models sometimes write their reasoning as <thinking>...</thinking> before the answer.
// It must never be spoken or shown, and keeping it out of the history stops the model copying it.
function cleanThinking(message) {
  const content = message.content
    .map(c => (c.text === undefined ? c : { ...c, text: c.text.replace(/<thinking>[\s\S]*?(<\/thinking>|$)/g, '').replace(/<\/?thinking>/g, '').trim() }))
    .filter(c => c.text === undefined || c.text);
  return { ...message, content: content.length ? content : [{ text: '...' }] };
}

export function reset(user, keepReminders = []) {
  histories[user] = [];
  reminders[user] = keepReminders;
}

// Keyword stand-in for Bedrock so the page works without AWS (BEDROCK_MOCK=1). Not used in the demo.
async function mockChat(mcp, user, text, trace) {
  const t = text.toLowerCase();
  const call = (name, input = {}) => runTool(mcp, user, name, input, trace);
  let reply;
  if (t.startsWith('(reminder fired')) {
    const label = text.match(/fired: (.*) at/)?.[1] || '';
    pendingCheckIn[user] = label;
    reply = await call('anchor_arrived', { anchor: label });
  } else if (pendingCheckIn[user]) {
    reply = await call('check_in', { anchor: pendingCheckIn[user], reflection: text });
    delete pendingCheckIn[user];
  } else if (t.includes('prayer')) {
    reply = await call('set_anchors', { mode: 'prayer' });
  } else if (t.includes('anchors are')) {
    reply = await call('set_anchors', {
      mode: 'custom',
      anchors: [
        { name: 'Lunch', time: '12:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
        { name: 'Work ends', time: '17:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
        { name: 'Gym', time: '19:00', days: ['tue', 'thu'] },
        { name: 'Gym', time: '08:00', days: ['sat'] },
      ],
    });
  } else if (t.includes('my morning is')) {
    reply = await call('set_routine', { routine: 'morning', time: '07:00', steps: [{ name: 'Make the bed', minutes: 2 }, { name: 'Drink water', minutes: 2 }, { name: 'Shower', minutes: 15 }, { name: 'Plan the day', minutes: 15 }] });
  } else if (t.includes('my evening is')) {
    reply = await call('set_routine', { routine: 'evening', time: '22:00', steps: [{ name: 'Tidy up', minutes: 5 }, { name: 'Read', minutes: 20 }] });
  } else if (t.includes('start') && t.includes('evening')) reply = await call('start_routine', { routine: 'evening' });
  else if (t.includes('start') && t.includes('morning')) reply = await call('start_routine', { routine: 'morning' });
  else if (/^(done|next|finished)/.test(t)) reply = await call('next_step');
  else if (t.includes('before lunch')) reply = await call('plan_tasks', { anchor: 'Lunch', tasks: [text.replace(/before lunch/i, '').trim()] });
  else if (/day|today/.test(t)) reply = await call('get_day');
  else reply = await call('get_started');
  (histories[user] ||= []).push({ role: 'assistant', content: [{ text: reply }] });
  return reply;
}
