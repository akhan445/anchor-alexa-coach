// Tiny JSON-file store: one file per user in data/users/<userId>.json.
// Fast (local disk, synchronous), which keeps every tool well under Alexa+'s 500 ms limit.
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.STORE_DIR || path.resolve('data/users');

// Demo users start empty, so the demo shows the whole first-time setup.
const NAMES = { bob: 'Bob', ahmed: 'Ahmed' };

function seed(userId) {
  return {
    name: NAMES[userId.replace(/^test-/, '')] || userId, // test-bob (from npm run live-test) is also called Bob
    anchors: { mode: null, custom: [] }, // mode: 'custom' | 'prayer'
    prayer: { latitude: 43.6532, longitude: -79.3832, method: 'NorthAmerica', madhab: 'Shafi' }, // Toronto
    routines: { morning: null, evening: null }, // { time: '07:00', steps: [...], runs: [], lastChange? }
    plan: { date: null, tasks: {} }, // today's tasks, keyed by anchor name: { before: [...], at: [...] }
    active: null, // the routine in progress: { routine, steps, index, stepStartedAt, timings }
    checkIns: [], // { anchor, reflection, done, at }
    feedback: [], // { routine, text, at, applied }
    tip: null, // a coaching tip from Bedrock, said at the next check-in
  };
}

const file = userId => path.join(DIR, `${userId}.json`);

export function load(userId) {
  if (!fs.existsSync(file(userId))) return seed(userId);
  // Fill in any fields added since the file was saved, so older files keep working.
  return { ...seed(userId), ...JSON.parse(fs.readFileSync(file(userId), 'utf8')) };
}

export function save(userId, state) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(userId), JSON.stringify(state, null, 2));
}

export function resetUser(userId) {
  if (fs.existsSync(file(userId))) fs.rmSync(file(userId));
}
