// The Bedrock steps that make Anchor adaptive.
//
// Alexa+ needs every tool to answer within 500 ms, and a model call takes longer than that.
// So the tools save what the user said and reply straight away, then call these in the background.
// Results are used the next time: a rewritten routine, or a tip at the next check-in.
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import * as z from 'zod/v4';
import { load, save } from './store.js';

const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'us.amazon.nova-lite-v1:0';
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

async function askBedrock(system, prompt) {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: system }],
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 800, temperature: 0.2 },
    })
  );
  return response.output.message.content[0].text;
}

// ---------- 1. Rewrite a routine from the user's feedback ----------

const RoutineResult = z.object({
  steps: z
    .array(
      z.object({
        name: z.string(),
        minutes: z.number(),
        days: z.array(z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])).optional(),
      })
    )
    .min(1),
  summary: z.string(),
});

const ROUTINE_SYSTEM = `You adjust a person's daily routine based on their feedback and how long steps really take.
Keep everything they didn't complain about. Make the smallest change that addresses the feedback.
A step can have "days" (weekdays it runs on: sun mon tue wed thu fri sat); omit it for every day.
Reply with JSON only, no prose, in this shape:
{"steps":[{"name":"...","minutes":10,"days":["thu"]}],"summary":"One friendly spoken sentence saying what you changed."}`;

export async function adjustRoutine(userId, routine) {
  const state = load(userId);
  const pending = state.feedback.filter(f => f.routine === routine && !f.applied);
  if (pending.length === 0) return;
  const { steps, runs } = state.routines[routine];

  let result;
  if (process.env.BEDROCK_MOCK) {
    result = { steps: steps.map(s => ({ ...s, minutes: s.minutes + 5 })), summary: 'I added five minutes to each step.' };
  } else {
    const prompt =
      `Routine: ${routine}\nCurrent steps:\n${JSON.stringify(steps)}\n\n` +
      `Recent runs (seconds per step):\n${JSON.stringify(runs.slice(-3).map(r => r.steps))}\n\n` +
      `Feedback (oldest first):\n${pending.map(f => `- ${f.text}`).join('\n')}`;
    const text = await askBedrock(ROUTINE_SYSTEM, prompt);
    result = RoutineResult.parse(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
  }

  const fresh = load(userId); // the user may have done something while the model was thinking
  fresh.routines[routine].steps = result.steps;
  fresh.routines[routine].lastChange = result.summary;
  for (const f of fresh.feedback) if (f.routine === routine) f.applied = true;
  save(userId, fresh);
  console.log(`[bedrock] ${userId} ${routine}: ${result.summary}`);
}

// ---------- 2. A coaching tip from today's check-ins ----------

const TIP_SYSTEM = `You are a kind, practical productivity coach. You get today's check-ins: at each anchor in the day,
the person said how the time since the last anchor went. Reply with ONE short spoken sentence of advice
for the next block, based on a pattern you notice. No preamble, no lists.`;

export async function makeCoachTip(userId) {
  const state = load(userId);
  const today = new Date().toDateString();
  const checkIns = state.checkIns.filter(c => new Date(c.at).toDateString() === today);
  if (checkIns.length === 0) return;

  const tip = process.env.BEDROCK_MOCK
    ? 'Quick tip: start the next block with the hardest task while your energy is up.'
    : (await askBedrock(TIP_SYSTEM, checkIns.map(c => `${c.anchor}: ${c.reflection}`).join('\n'))).trim();

  const fresh = load(userId);
  fresh.tip = tip;
  save(userId, fresh);
  console.log(`[bedrock] ${userId} tip: ${tip}`);
}
