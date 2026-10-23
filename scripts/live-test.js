// Runs test copies of Bob and Ahmed through setup and a day against the REAL model, then flags anything that went wrong.
// Start the server first (npm start, without BEDROCK_MOCK), then in a second terminal: npm run live-test
// The full transcript is also saved to data/live-test.md.
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.ANCHOR_URL || 'http://localhost:3000';
const lines = [];
const problems = [];
const log = (text = '') => { console.log(text); lines.push(text); };

const SCRIPTS = {
  bob: [
    { at: '07:00', say: 'Hey Alexa, help me set up my day', expect: ['get_started'] },
    { at: '07:01', say: 'My anchors are lunch at 12 on weekdays, work ends at 5, gym Tuesday and Thursday at 7 PM and Saturday at 8 AM, and wind down at 10.', expect: ['set_anchors'] },
    { at: '07:03', say: 'My morning routine starts at 7:30. Make my bed 2 minutes, drink water 2 minutes, shower 15 minutes, then plan my day for 15 minutes.', expect: ['set_routine'] },
    { at: '07:05', say: 'My evening routine starts at 10 PM. Tidy up for 10 minutes, read for 20 minutes, then lights out.', expect: ['set_routine'] },
    { at: '07:07', say: 'Before lunch I want to finish the API and answer my emails. At lunch remind me to drink water.', expect: ['plan_tasks'] },
    { fire: 'Morning routine', expect: ['anchor_arrived'] },
    { say: "Yes, let's start", expect: ['start_routine'] },
    { after: 3, say: 'Done', expect: ['next_step'] },
    { after: 2, say: "Done. That felt a little rushed, make it 5 minutes from now on.", expect: ['next_step'],
      check: trace => trace.some(c => (c.tool === 'next_step' && c.input.feedback) || c.tool === 'reflect_and_adjust') || 'the step feedback was not saved' },
    { fire: 'Lunch', expect: ['anchor_arrived'] },
    { after: 1, say: "I finished the API but not the emails. I'm feeling a bit tired.", expect: ['check_in'] },
    { after: 2, say: 'This afternoon I have meetings until work ends, then I want to hit the gym after work before my wind-down.', expect: ['plan_tasks'],
      check: trace => trace.some(c => c.tool === 'plan_tasks' && /wind|evening/i.test(c.input.anchor) && /gym/i.test(c.input.tasks.join())) || 'gym was not planned before the evening wind-down' },
  ],
  ahmed: [
    { at: '09:00', say: 'Use my prayer times as my anchors', expect: ['set_anchors'] },
    { at: '09:02', say: 'My morning routine starts at 6 AM. Make wudu 5 minutes, read Quran 15 minutes, breakfast 15 minutes.', expect: ['set_routine'] },
    { at: '09:04', say: 'My evening routine starts at 10:30 PM. Journal 10 minutes and read 20 minutes.', expect: ['set_routine'] },
    { at: '09:06', say: 'Before Dhuhr I want to finish my presentation slides.', expect: ['plan_tasks'] },
    { fire: 'Dhuhr', expect: ['anchor_arrived'] },
    { after: 1, say: 'It went well, I finished the slides. I was a bit tired and low on energy. Remind me to hydrate and grab an energy bar next time at Dhuhr.', expect: ['check_in', 'plan_tasks'] },
    { fire: 'Asr', expect: ['anchor_arrived'] },
    { after: 1, say: "Pretty good. I'll wrap up my work around 5 and try to catch a gym session before my next anchor.", expect: ['check_in'],
      check: trace => trace.some(c => /gym/i.test(JSON.stringify(c.input.next_tasks || (c.tool === 'plan_tasks' ? c.input.tasks : '')))) || 'the gym plan mentioned in the check-in was not saved' },
  ],
};

// Phrases that mean the model is claiming something no tool did.
const FALSE_CLAIMS = [/adjusted your (morning|evening) routine/i, /i've (updated|changed) your routine/i];

const post = (path, body) =>
  fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

function todayAt(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

// "1:03 PM" -> Date today
function parseTime(text) {
  const m = text.match(/(\d{1,2}):(\d{2})\s*([AP]M)?/i);
  let h = Number(m[1]);
  if (m[3]) h = (h % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
  return todayAt(`${h}:${m[2]}`);
}

async function run(name) {
  // Separate test users, so the real Bob and Ahmed tabs are never touched.
  const user = `test-${name}`;
  log(`\n## ${name}\n`);
  await post('/api/reset', { user });
  let now = new Date(), reminders = [];

  for (const [i, step] of SCRIPTS[name].entries()) {
    let text = step.say;
    if (step.at) now = todayAt(step.at);
    if (step.after) now = new Date(now.getTime() + step.after * 60000);
    if (step.fire) {
      const r = reminders.find(r => r.label.toLowerCase().includes(step.fire.toLowerCase()));
      if (!r) {
        problems.push(`${user} step ${i + 1}: no "${step.fire}" reminder was set, so it could never fire`);
        log(`⚠️  No "${step.fire}" reminder to fire. Reminders were: ${reminders.map(r => `${r.label} ${r.time}`).join(', ') || 'none'}`);
        continue;
      }
      now = parseTime(r.time);
      text = `(Reminder fired: ${r.label} at ${r.time})`;
      log(`⏰ ${r.time} · ${r.label}`);
    }

    const started = Date.now();
    const res = await post('/api/chat', { text, user, now: now.toISOString() });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (res.reminders?.length) reminders = res.reminders;
    const called = res.trace.map(c => c.tool);

    if (!step.fire) log(`🧑 [${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}] ${text}`);
    for (const c of res.trace) log(`   🔧 ${c.tool} ${JSON.stringify(c.input)}${c.mcp ? ` (${c.ms} ms)` : ''}`);
    log(`🔵 Alexa (${secs}s): ${res.reply}\n`);

    const missing = (step.expect || []).filter(t => !called.includes(t));
    if (missing.length) problems.push(`${user} step ${i + 1} ("${text.slice(0, 40)}…"): expected ${missing.join(', ')} but got ${called.join(', ') || 'no tools'}`);
    const failed = step.check?.(res.trace);
    if (typeof failed === 'string') problems.push(`${user} step ${i + 1}: ${failed}`);
    if (/thinking>/i.test(res.reply)) problems.push(`${user} step ${i + 1}: thinking text leaked into the reply`);
    for (const re of FALSE_CLAIMS) if (re.test(res.reply)) problems.push(`${user} step ${i + 1}: Alexa claimed a change no tool made ("${res.reply.match(re)[0]}")`);
    for (const c of res.trace) if (c.mcp && c.ms > 500) problems.push(`${user} step ${i + 1}: ${c.tool} took ${c.ms} ms (over Alexa's 500 ms limit)`);
  }
  await post('/api/reset', { user }); // clean up
}

log(`# Anchor live test, ${new Date().toLocaleString()}`);
try {
  for (const user of process.argv[2] ? [process.argv[2]] : ['bob', 'ahmed']) await run(user);
} catch (err) {
  problems.push(`Test crashed: ${err.message}. Is the server running (npm start)?`);
}

log('\n## Result\n');
if (problems.length) problems.forEach(p => log(`❌ ${p}`));
else log('✅ Everything Alexa was expected to do, it did.');

mkdirSync('data', { recursive: true });
writeFileSync('data/live-test.md', lines.join('\n') + '\n');
console.log('\nSaved to data/live-test.md');
process.exit(problems.length ? 1 : 0);
