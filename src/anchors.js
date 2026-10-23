// Anchors are the fixed points of a day: times the user picks (lunch, gym...), or prayer times,
// which move every day. Morning and evening routines with a start time are anchors too.
//
// Prayer times are calculated locally with the `adhan` library from latitude, longitude and the date,
// using the same astronomy prayer apps use. No network call, so it's instant.
// Accuracy depends on the calculation method (which sun angles define Fajr and Isha) and the madhab
// (Asr time); different mosques use different ones, so both are settings.
import { Coordinates, CalculationMethod, Madhab, PrayerTimes } from 'adhan';

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const PRAYERS = [
  ['fajr', 'Fajr'],
  ['dhuhr', 'Dhuhr'],
  ['asr', 'Asr'],
  ['maghrib', 'Maghrib'],
  ['isha', 'Isha'],
];

export const formatTime = date => date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function formatDuration(minutes) {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} minutes`;
  return m === 0 ? `${h} hour${h > 1 ? 's' : ''}` : `${h} hour${h > 1 ? 's' : ''} and ${m} minutes`;
}

// "13:30", "1:30 PM", "9 pm" -> "13:30" / "21:00". The model doesn't always send 24-hour times.
export function parseClock(text = '') {
  const m = String(text).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3]) h = (h % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// "13:30" -> a Date on the same day as `now` at 1:30 PM
export function todayAt(hhmm, now = new Date()) {
  const [h, m] = (parseClock(hhmm) || '00:00').split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d;
}

function prayerAnchors(prayer, now) {
  const params = CalculationMethod[prayer.method]();
  params.madhab = Madhab[prayer.madhab];
  const times = new PrayerTimes(new Coordinates(prayer.latitude, prayer.longitude), now, params);
  return PRAYERS.map(([key, name]) => ({ name, at: times[key], kind: 'prayer' }));
}

const ROUTINE_NAMES = { morning: 'Morning routine', evening: 'Evening wind-down' };

// All anchors for the day `now` falls on, as [{ name, at: Date, kind, routine? }], earliest first.
// Custom anchors can repeat on certain weekdays (gym Tue/Thu); no `days` means every day.
export function todaysAnchors(state, now) {
  const day = WEEKDAYS[now.getDay()];
  const list =
    state.anchors.mode === 'prayer'
      ? prayerAnchors(state.prayer, now)
      : state.anchors.custom
          .filter(a => !a.days?.length || a.days.includes(day))
          .map(a => ({ name: a.name, at: todayAt(a.time, now), kind: 'anchor' }));
  for (const routine of ['morning', 'evening']) {
    const r = state.routines[routine];
    // Prayer users start the day with Fajr, so the morning routine is coupled to it: one anchor, "Fajr & morning routine".
    if (routine === 'morning' && r && state.anchors.mode === 'prayer') {
      const fajr = list.find(a => a.name === 'Fajr');
      if (fajr) Object.assign(fajr, { name: 'Fajr & morning routine', kind: 'routine', routine: 'morning', prayer: true });
      continue;
    }
    if (r?.time) list.push({ name: ROUTINE_NAMES[routine], at: todayAt(r.time, now), kind: 'routine', routine });
  }
  // An anchor at the exact time a routine starts ("wind down at 10" + evening routine at 10) is the same moment: keep the routine.
  const routineTimes = list.filter(a => a.kind === 'routine').map(a => a.at.getTime());
  return list.filter(a => a.kind === 'routine' || !routineTimes.includes(a.at.getTime())).sort((a, b) => a.at - b.at);
}

// ['mon','tue','wed','thu','fri'] -> "weekdays", ['tue','thu'] -> "Tue and Thu"
export function describeDays(days) {
  if (!days?.length || days.length === 7) return 'every day';
  const key = [...days].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b)).join(',');
  if (key === 'mon,tue,wed,thu,fri') return 'weekdays';
  if (key === 'sun,sat') return 'weekends';
  const names = key.split(',').map(d => d[0].toUpperCase() + d.slice(1));
  return names.length === 1 ? `${names[0]}s` : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export function nextAnchor(state, now) {
  return todaysAnchors(state, now).find(a => a.at > now) || null;
}

// Where you are in the day and when the next check-in is.
export function nextAnchorSentence(state, now) {
  if (!state.anchors.mode) return "You haven't set your anchors yet.";
  const next = nextAnchor(state, now);
  if (!next) return 'No more anchors today.';
  const minutes = (next.at - now) / 60000;
  return `Next anchor: ${next.name} at ${formatTime(next.at)}, about ${formatDuration(minutes)} from now.`;
}
