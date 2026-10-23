// The tool "menu" Alexa+ sees. Descriptions are written for the model:
// they say when each tool applies and what to pass in.
import * as z from 'zod/v4';
import {
  getStarted, setAnchors, getDay, planTasks, anchorArrived, checkIn,
  setRoutine, startRoutine, nextStep, reflectOnRoutine, WEEKDAYS,
} from './routines.js';
import { load } from './store.js';
import { todaysAnchors, formatTime } from './anchors.js';

const routineName = z.enum(['morning', 'evening']).describe('Which routine: morning, or evening wind-down');
const time24 = z.string().describe('24-hour time, e.g. "07:00" or "17:30"');
export function registerTools(server, ctx) {
  // Every answer also carries today's anchors as structured data (MCP structuredContent).
  // The text is for the model to speak; the list lets Alexa keep its own reminders in sync
  // without relying on the model to copy times correctly.
  const say = text => {
    const state = load(ctx.userId);
    const anchorsToday = state.anchors.mode || state.routines.morning?.time || state.routines.evening?.time
      ? todaysAnchors(state, ctx.now).map(a => ({ label: a.name, time: formatTime(a.at) }))
      : [];
    return { content: [{ type: 'text', text }], structuredContent: { anchorsToday } };
  };

  server.registerTool(
    'get_started',
    {
      description:
        'Call FIRST at the start of every conversation, and whenever the user asks to set up, plan, or get started. Returns where the user is in setup (anchors, then routines, then planning) and exactly what to say next.',
      inputSchema: {},
    },
    async () => say(getStarted(ctx))
  );

  server.registerTool(
    'set_anchors',
    {
      description:
        "Save the fixed points of the user's week (anchors). Use mode 'prayer' when they want their prayer times as anchors. Otherwise mode 'custom' with every anchor they name and the weekdays it happens (lunch weekdays at 12, gym Tue and Thu at 19:00, gym Sat at 08:00 as a separate entry). Call as soon as they've named their anchors. Replaces earlier anchors.",
      inputSchema: {
        mode: z.enum(['custom', 'prayer']),
        anchors: z
          .array(
            z.object({
              name: z.string().describe('e.g. "Lunch"'),
              time: time24,
              days: z.array(z.enum(WEEKDAYS)).optional().describe('Weekdays it happens on; omit for every day'),
            })
          )
          .optional()
          .describe("Only for mode 'custom'"),
        place: z.string().optional().describe("Mode 'prayer' only: the user's city, if they mention one. Default is Toronto."),
        latitude: z.number().optional().describe("Mode 'prayer' only, with place: the city's latitude"),
        longitude: z.number().optional().describe("Mode 'prayer' only, with place: the city's longitude"),
      },
    },
    async args => say(setAnchors(ctx, args))
  );

  server.registerTool(
    'set_routine',
    {
      description:
        'Save the morning or evening routine as soon as the user has described it: start time and each step with minutes. One call per routine. The start time makes it an anchor with its own reminder. Only save steps and times the user actually said: never invent them. If they left something out, ask first.',
      inputSchema: {
        routine: routineName,
        time: time24.optional().describe("When the routine starts. Needed for it to become an anchor. Omit only for a prayer-times user's morning routine, which follows Fajr."),
        steps: z
          .array(
            z.object({
              name: z.string().describe('e.g. "Make the bed"'),
              minutes: z.number().describe('Roughly how long it takes'),
              days: z.array(z.enum(WEEKDAYS)).optional().describe('Only on these weekdays; omit for every day'),
            })
          )
          .min(1),
      },
    },
    async args => say(setRoutine(ctx, args))
  );

  server.registerTool(
    'get_day',
    {
      description:
        "Today's anchors with any planned tasks and the time until the next anchor, or another weekday's anchors.",
      inputSchema: { day: z.enum(WEEKDAYS).optional().describe('A weekday to look at; omit for today') },
    },
    async args => say(getDay(ctx, args))
  );

  server.registerTool(
    'plan_tasks',
    {
      description:
        "Save tasks for today against an anchor. when='before': things the user wants done before reaching that anchor (\"finish the API before lunch\"); Alexa asks about them at the anchor. when='at': things to be reminded of when the anchor arrives (\"at Dhuhr remind me to hydrate\"). The anchor is the one that ENDS the block where the task happens: \"coding until lunch\" is before Lunch; \"gym after work, before my wind-down\" is before Evening wind-down, not Work ends. Several tasks for different blocks = one call per anchor. Use the anchor's exact name.",
      inputSchema: {
        anchor: z.string().describe('Anchor name, e.g. "Lunch" or "Dhuhr"'),
        tasks: z.array(z.string()).min(1),
        when: z.enum(['before', 'at']).default('before'),
      },
    },
    async args => say(planTasks(ctx, args))
  );

  server.registerTool(
    'anchor_arrived',
    {
      description:
        'Call when a reminder fires for an anchor. Returns what to remind the user of and which planned tasks to ask about.',
      inputSchema: { anchor: z.string().describe('The anchor whose reminder fired') },
    },
    async args => say(anchorArrived(ctx, args))
  );

  server.registerTool(
    'check_in',
    {
      description:
        "Save the user's reflection at an anchor, after they've said how the last block went. Returns the next anchor and what's planned for it.",
      inputSchema: {
        anchor: z.string().describe('The anchor that just arrived'),
        reflection: z.string().describe('What the user said, in their words'),
        done: z.array(z.string()).optional().describe('Planned tasks they said they finished'),
        next_tasks: z
          .array(z.string())
          .optional()
          .describe('Anything they say they will do before the NEXT anchor ("wrap up work, then the gym"). Saved as the plan for that block.'),
      },
    },
    async args => say(checkIn(ctx, args))
  );

  server.registerTool(
    'start_routine',
    {
      description: "Start the user's morning or evening routine: lists today's steps and starts the first.",
      inputSchema: { routine: routineName },
    },
    async ({ routine }) => say(startRoutine(ctx, routine))
  );

  server.registerTool(
    'next_step',
    {
      description:
        'Call when the user finishes the current routine step ("done", "next"). Times it and moves on; at the end, gives each step\'s time. If they also comment on the step ("felt rushed, make it 20 minutes"), pass that as feedback.',
      inputSchema: { feedback: z.string().optional().describe("Their comment about the step they just finished, in their words") },
    },
    async ({ feedback }) => say(nextStep(ctx, feedback))
  );

  server.registerTool(
    'reflect_and_adjust',
    {
      description:
        'Save feedback about the morning or evening routine itself ("the shower felt rushed", "only stretch on Thursdays"). Bedrock adjusts the routine in the background. Not for reminders or tasks: use plan_tasks for those.',
      inputSchema: { routine: routineName, feedback: z.string().describe("The user's words") },
    },
    async ({ routine, feedback }) => say(reflectOnRoutine(ctx, routine, feedback))
  );
}
