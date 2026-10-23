// What each tool actually does. Every function follows the same three beats:
// load the user's state, change it, save it, and return what Alexa should know.
// Results are facts for Alexa to say in its own words, not a script.
// `ctx` is { userId, now }: who is talking, and what time it is for them.
import { load, save } from './store.js';
import { todaysAnchors, nextAnchor, nextAnchorSentence, formatTime, formatDuration, describeDays, todayAt, parseClock, WEEKDAYS } from './anchors.js';
import { adjustRoutine, makeCoachTip } from './adjust.js';

const AVERAGE_OVER = 3; // runs to average before changing a step's planned time
const SKIPPED_UNDER = 30; // a step "done" in under 30 seconds was skipped, so it doesn't count toward averages

const listOf = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const spoken = secs => (secs < 60 ? plural(Math.max(1, Math.round(secs)), 'second') : plural(Math.round(secs / 60), 'minute'));
const capitalize = text => text[0].toUpperCase() + text.slice(1);

function background(promise) {
  // Bedrock work runs after we've already answered. If it fails, the answer was still delivered;
  // the feedback stays marked unapplied and is retried next time.
  promise.catch(err => console.error('[bedrock]', err.message));
}

// ---------- Setup: the three steps ----------

const STEP_1 =
  'This app uses key habits or tasks called anchors to plan your day: fixed points that serve as checkpoints to help you stay focused, re-energize and have a productive day. ' +
  'We call them anchors because they ground you, allowing you to stay consistent, keep working hard and avoid burnout.';
const STEP_2 =
  'Morning and evening routines are the outliers within our days. A good morning gives you a good start; it propels you and grants you momentum to kickstart your day. ' +
  'The evening wind-down allows you to dial it down and recover, so you can get the rest you need to start again fresh the next day.';
const STEP_3 =
  "Now the part that makes me a coach: planning. Tell me what you want to get done before your next anchor, and anything you want reminding of at an anchor. I'll check in on it when we get there.";

// A routine counts as set up once it has steps and a start time (a prayer user's morning routine follows Fajr instead).
function routineReady(state, routine) {
  const r = state.routines[routine];
  return Boolean(r?.steps?.length && (r.time || (routine === 'morning' && state.anchors.mode === 'prayer')));
}

function setupStage(state) {
  if (!state.anchors.mode) return 1;
  if (!routineReady(state, 'morning') || !routineReady(state, 'evening')) return 2;
  return 3;
}

// What to do next in setup, as instructions for Alexa (it reads them, then speaks to the user).
function setupNext(state, now) {
  const stage = setupStage(state);
  if (stage === 1) {
    return `SETUP STEP 1 of 3 (anchors). Say this to ${state.name}, close to word for word: "${STEP_1}" Then ask for their anchors: the times that stay fixed in their week (like lunch, end of work, the gym, with the days each happens), or whether they'd like their prayer times as anchors. If they've already told you (in this message or earlier), don't ask again: call set_anchors now. Prayer times are mode 'prayer', and Anchor calculates them, so never ask for the times.`;
  }
  if (stage === 2) {
    const missing = ['morning', 'evening'].filter(r => !routineReady(state, r));
    const routine = missing[0];
    const intro = !state.routines.morning && !state.routines.evening ? `Say this, close to word for word: "${STEP_2}" Then a` : 'A';
    if (state.routines[routine]?.steps?.length) {
      return `SETUP STEP 2 of 3 (routines). The ${routine} routine's steps are saved but it has no start time, so it can't be an anchor yet. Ask what time it starts, then call set_routine again with routine "${routine}", the time and the same steps.`;
    }
    const when =
      routine === 'morning' && state.anchors.mode === 'prayer'
        ? "It starts right after Fajr, so don't ask for a time: just ask for each step with roughly how many minutes it takes."
        : 'Ask what time it starts, and each step with roughly how many minutes it takes.';
    return `SETUP STEP 2 of 3 (routines). ${intro}sk for their ${routine} routine${routine === 'morning' ? ', which is how they start the day' : ', the last anchor of the day'}. ${when} As soon as they've described it, save it with set_routine.`;
  }
  const next = nextAnchor(state, now);
  return `SETUP STEP 3 of 3 (planning). Say: "${STEP_3}"` + (next ? ` Their next anchor is ${next.name} at ${formatTime(next.at)}.` : '');
}

export function getStarted(ctx) {
  const state = load(ctx.userId);
  if (setupStage(state) < 3) return setupNext(state, ctx.now);
  // Already set up: a returning user hears their day, not the setup speech again.
  const planned = state.plan.date === ctx.now.toDateString() && Object.keys(state.plan.tasks).length;
  return (
    `${state.name} is already set up, so don't repeat the setup intro. Greet them warmly. ${dayOverview(state, ctx.now)}` +
    (planned ? '' : ` Nothing is planned yet today: ask what they want to get done before their next anchor, and save it with plan_tasks.`)
  );
}

// ---------- Anchors ----------

const todayList = (state, now) => todaysAnchors(state, now).map(a => `${a.name} at ${formatTime(a.at)}`);

export function setAnchors(ctx, { mode, anchors = [], place, latitude, longitude }) {
  const state = load(ctx.userId);
  anchors = anchors.map(a => ({ ...a, time: parseClock(a.time) || a.time })); // "12 PM" -> "12:00"
  state.anchors = { mode, custom: mode === 'custom' ? anchors : [] };
  if (mode === 'prayer' && latitude !== undefined && longitude !== undefined) {
    state.prayer = { ...state.prayer, latitude, longitude, place: place || 'their city' };
  }
  save(ctx.userId, state);

  const saved =
    mode === 'prayer'
      ? `Saved: ${state.name}'s anchors are their daily prayer times, recalculated every day for ${state.prayer.place || 'Toronto'}.`
      : `Saved ${state.name}'s weekly anchors: ${listOf(anchors.map(a => `${a.name} ${describeDays(a.days)} at ${formatTime(todayAt(a.time))}`))}.`;
  return `${saved} Today: ${listOf(todayList(state, ctx.now))}. Alexa has set a reminder for each one. Then: ${setupNext(state, ctx.now)}`;
}

function dayOverview(state, now) {
  const anchors = todaysAnchors(state, now);
  if (!anchors.length) return 'No anchors today.';
  const parts = anchors.map(a => {
    const t = state.plan.date === now.toDateString() ? state.plan.tasks[a.name] : null;
    const before = t?.before?.length ? ` (before it: ${listOf(t.before)})` : '';
    const at = t?.at?.length ? ` (at it: ${listOf(t.at)})` : '';
    return `${a.name} at ${formatTime(a.at)}${before}${at}`;
  });
  return `Today: ${listOf(parts)}. ${nextAnchorSentence(state, now)}`;
}

export function getDay(ctx, { day } = {}) {
  const state = load(ctx.userId);
  if (!state.anchors.mode) return setupNext(state, ctx.now);
  if (day) {
    // "What does Saturday look like?" -> the next date that falls on that weekday
    const date = new Date(ctx.now);
    date.setDate(date.getDate() + ((WEEKDAYS.indexOf(day) - date.getDay() + 7) % 7));
    const list = todayList(state, date);
    return list.length ? `${capitalize(day)}: ${listOf(list)}.` : 'No anchors on that day.';
  }
  return dayOverview(state, ctx.now);
}

// ---------- Planning ----------

function todaysPlan(state, now) {
  if (state.plan.date !== now.toDateString()) state.plan = { date: now.toDateString(), tasks: {} };
  return state.plan.tasks;
}

// The model doesn't always use the exact name ("Evening" for "Evening wind-down", "lunch break" for "Lunch"),
// so try an exact match first, then a looser one.
function findAnchor(state, now, name = '') {
  const list = todaysAnchors(state, now);
  const n = name.toLowerCase().trim();
  return (
    list.find(a => a.name.toLowerCase() === n) ||
    list.find(a => a.name.toLowerCase().includes(n) || n.includes(a.name.toLowerCase())) ||
    list.find(a => a.kind === 'routine' && n.includes(a.routine === 'morning' ? 'morning' : 'evening')) ||
    list.find(a => a.kind === 'routine' && a.routine === 'evening' && /wind|bed|night/.test(n))
  );
}

export function planTasks(ctx, { anchor, tasks, when = 'before' }) {
  const state = load(ctx.userId);
  const match = findAnchor(state, ctx.now, anchor);
  if (!match) return `There's no anchor called ${anchor} today. Today's anchors: ${listOf(todayList(state, ctx.now))}.`;
  const plan = todaysPlan(state, ctx.now);
  const entry = (plan[match.name] ||= { before: [], at: [] });
  entry[when].push(...tasks);
  save(ctx.userId, state);
  return when === 'at'
    ? `Saved. At ${match.name} (${formatTime(match.at)}) Alexa will remind ${state.name} to: ${listOf(entry.at)}.`
    : `Saved. Before ${match.name} (${formatTime(match.at)}), ${state.name} plans to: ${listOf(entry.before)}. Alexa will ask about it at ${match.name}.`;
}

// ---------- Check-ins at anchors ----------

export function anchorArrived(ctx, { anchor }) {
  const state = load(ctx.userId);
  const match = findAnchor(state, ctx.now, anchor);
  if (!match) return `${anchor} isn't one of today's anchors (${listOf(todayList(state, ctx.now))}). Use the closest one.`;
  if (match.kind === 'routine') {
    if (match.prayer) return `It's ${formatTime(match.at)}: time for Fajr prayer, and then ${state.name}'s morning routine. Greet them with a good morning, and offer to start the routine after they pray (start_routine with "morning").`;
    return `It's time for ${state.name}'s ${match.name.toLowerCase()}. Greet them and offer to start it (start_routine with "${match.routine}").`;
  }
  const t = todaysPlan(state, ctx.now)[match.name] || { before: [], at: [] };
  const lines = [`It's ${formatTime(match.at)}: time for ${match.name}${match.kind === 'prayer' ? ' prayer' : ''}.`];
  if (t.at.length) lines.push(`Remind ${state.name} to: ${listOf(t.at)}.`);
  lines.push(
    t.before.length
      ? `Before this anchor they planned to: ${listOf(t.before)}. Ask how each went.`
      : 'Nothing was planned for this block. Ask how the time since the last anchor went.'
  );
  return lines.join(' ');
}

export function checkIn(ctx, { anchor, reflection, done = [], next_tasks = [] }) {
  const state = load(ctx.userId);
  state.checkIns.push({ anchor, reflection, done, at: ctx.now.toISOString() });
  const tip = state.tip;
  state.tip = null;
  const next = nextAnchor(state, ctx.now);
  // Plans for the coming block often come up in the same breath as the reflection ("I'll hit the gym before Maghrib").
  if (next && next_tasks.length) (todaysPlan(state, ctx.now)[next.name] ||= { before: [], at: [] }).before.push(...next_tasks);
  save(ctx.userId, state);
  background(makeCoachTip(ctx.userId)); // Bedrock looks at today's check-ins for the next one

  const planned = next && todaysPlan(state, ctx.now)[next.name];
  const nextText = !next
    ? 'That was the last anchor today.'
    : `${nextAnchorSentence(state, ctx.now)} ` +
      (planned?.before?.length
        ? `Planned before it: ${listOf(planned.before)}.`
        : `Nothing planned for that block yet: ask what ${state.name} wants to get done before ${next.name}, and save it with plan_tasks.`);
  return `Check-in saved.${tip ? ` Coaching tip from earlier check-ins: ${tip}` : ''} ${nextText}`;
}

// ---------- Routines ----------

export function setRoutine(ctx, { routine, time, steps }) {
  const state = load(ctx.userId);
  const coupled = routine === 'morning' && state.anchors.mode === 'prayer';
  time = parseClock(time) || state.routines[routine]?.time; // keep the old start time if only the steps changed
  state.routines[routine] = { time, steps, runs: state.routines[routine]?.runs || [] };
  save(ctx.userId, state);
  const stepList = listOf(steps.map(s => `${s.name} (${s.minutes} min)`));
  if (coupled) {
    const fajr = todaysAnchors(state, ctx.now).find(a => a.routine === 'morning');
    return `Saved the morning routine: ${stepList}. It's coupled with Fajr${fajr ? ` (${formatTime(fajr.at)} today)` : ''}, so it moves with the prayer time every day, and Alexa has set a reminder for it. Then: ${setupNext(state, ctx.now)}`;
  }
  if (!time) return `Saved the ${routine} routine's steps: ${stepList}. ${setupNext(state, ctx.now)}`;
  return `Saved the ${routine} routine starting at ${formatTime(todayAt(time))}: ${stepList}. It now appears as an anchor, and Alexa has set a reminder for it. Then: ${setupNext(state, ctx.now)}`;
}

export function startRoutine(ctx, routine) {
  const state = load(ctx.userId);
  const saved = state.routines[routine];
  if (!saved?.steps.length) return `There's no ${routine} routine yet. ${setupNext(state, ctx.now)}`;

  const day = WEEKDAYS[ctx.now.getDay()];
  const steps = saved.steps.filter(s => !s.days?.length || s.days.includes(day)); // e.g. stretch only Mon and Thu
  state.active = { routine, steps, index: 0, stepStartedAt: Date.now(), timings: [] };
  const change = saved.lastChange;
  delete saved.lastChange; // mention a change only once
  save(ctx.userId, state);

  const first = steps[0];
  return (
    (change ? `Since last time: ${change} ` : '') +
    `${steps.length} steps today: ${listOf(steps.map(s => s.name))}. ` +
    `Start with step 1: ${first.name}, aim for ${first.minutes} minutes. Ask them to say "done" when finished.`
  );
}

export function nextStep(ctx, feedback) {
  const state = load(ctx.userId);
  let active = state.active;
  // A routine left running for hours (or since yesterday) was abandoned; don't resume it.
  if (active && Date.now() - active.stepStartedAt > 3 * 60 * 60 * 1000) {
    state.active = active = null;
    save(ctx.userId, state);
  }
  if (!active) return `No routine is running. ${dayOverview(state, ctx.now)}`;
  let feedbackNote = '';
  if (feedback) {
    // "Done, that felt rushed, make it 20 minutes": save it and let Bedrock adjust the routine after we reply.
    state.feedback.push({ routine: active.routine, text: `${active.steps[active.index].name}: ${feedback}`, at: new Date().toISOString(), applied: false });
    save(ctx.userId, state);
    background(adjustRoutine(ctx.userId, active.routine));
    feedbackNote = "Feedback saved; the routine will be adjusted in the background and the change announced next time it starts (don't describe a specific change). ";
  }

  // Real elapsed time for the step just finished (not the demo clock).
  active.timings.push({ name: active.steps[active.index].name, seconds: (Date.now() - active.stepStartedAt) / 1000 });
  active.index += 1;
  active.stepStartedAt = Date.now();

  if (active.index < active.steps.length) {
    save(ctx.userId, state);
    const step = active.steps[active.index];
    const last = active.index === active.steps.length - 1 ? ' This is the last step.' : '';
    return feedbackNote + `Step ${active.index + 1} of ${active.steps.length}: ${step.name}, aim for ${step.minutes} minutes.${last}`;
  }

  // Finished: record the run, read out the stats, and learn from how long things really take.
  const routine = state.routines[active.routine];
  routine.runs.push({ completedAt: new Date().toISOString(), steps: active.timings });
  const changes = averageTimings(routine);
  state.active = null;
  save(ctx.userId, state);

  const total = active.timings.reduce((sum, t) => sum + t.seconds, 0);
  const stats = active.timings.map(t => `${t.name} ${spoken(t.seconds)}`);
  const wrap =
    active.routine === 'evening'
      ? 'Wish them a good rest.'
      : `${nextAnchorSentence(state, ctx.now)} Ask what they want to get done before it, and save it with plan_tasks.`;
  return (
    `${capitalize(active.routine)} routine complete in ${spoken(total)}. Step times: ${listOf(stats)}. ` +
    (changes.length ? `Based on the last ${AVERAGE_OVER} runs, planned times updated: ${listOf(changes)}. ` : '') +
    `Congratulate ${state.name} and ask how it felt. ${wrap}`
  );
}

// If a step consistently takes longer or shorter than planned, move its planned time to the average.
function averageTimings(routine) {
  const recent = routine.runs.slice(-AVERAGE_OVER);
  if (recent.length < AVERAGE_OVER) return [];
  const changes = [];
  for (const step of routine.steps) {
    const times = recent.map(r => r.steps.find(s => s.name === step.name)?.seconds).filter(secs => secs >= SKIPPED_UNDER);
    if (times.length < AVERAGE_OVER) continue;
    const avgMinutes = Math.max(1, Math.round(times.reduce((a, b) => a + b, 0) / times.length / 60));
    if (Math.abs(avgMinutes - step.minutes) >= 2) {
      step.minutes = avgMinutes;
      changes.push(`${step.name} to ${avgMinutes} minutes`);
    }
  }
  return changes;
}

export function reflectOnRoutine(ctx, routine, text) {
  const state = load(ctx.userId);
  if (!state.routines[routine]) return `There's no ${routine} routine to adjust yet.`;
  state.feedback.push({ routine, text, at: new Date().toISOString(), applied: false });
  save(ctx.userId, state);
  background(adjustRoutine(ctx.userId, routine)); // Bedrock rewrites the routine after we reply
  return `Feedback saved. The ${routine} routine will be adjusted in the background and the change announced next time it starts. Don't describe a specific change; it hasn't been made yet.`;
}

// "New day" in the simulator: keep the setup (anchors, routines, history of runs), clear today.
export function newDay(userId) {
  const state = load(userId);
  state.plan = { date: null, tasks: {} };
  state.active = null;
  state.tip = null;
  save(userId, state);
}

export { WEEKDAYS };
