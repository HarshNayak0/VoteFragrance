'use strict';

// The rules of 75 Hard: Cologne Edition. A day passes only when every task
// is met; any miss (including a day that was never logged) restarts the
// challenge at Day 1 the following day.
const CHALLENGE_DAYS = 75;

const TASKS = [
  { key: 'workoutMin', label: '45 min workout', unit: 'min', min: 45 },
  { key: 'steps', label: '10,000 steps', unit: 'steps', min: 10000 },
  { key: 'deficit', label: '300-500 cal deficit', unit: 'cal', min: 300, max: 500 },
  { key: 'frenchMin', label: '10 min of French', unit: 'min', min: 10 },
];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s) {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return typeof tz === 'string' && tz.length > 0;
  } catch {
    return false;
  }
}

// Today's date (YYYY-MM-DD) on the challenger's own clock.
function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function taskResults(entry) {
  return TASKS.map((t) => {
    const value = entry ? entry[t.key] : undefined;
    const met = typeof value === 'number' && value >= t.min && (t.max === undefined || value <= t.max);
    return { key: t.key, value: typeof value === 'number' ? value : null, met };
  });
}

const dayPasses = (entry) => taskResults(entry).every((r) => r.met);

// Walks every day from the start date to today and replays the rules.
//   startDate: 'YYYY-MM-DD' or null, today: 'YYYY-MM-DD', days: { date: entry }
function computeProgress({ startDate, today, days }) {
  const totals = { workoutMin: 0, steps: 0, deficit: 0, frenchMin: 0, daysLogged: 0 };
  for (const [date, entry] of Object.entries(days)) {
    if (startDate && date >= startDate && date <= today) {
      totals.daysLogged++;
      for (const t of TASKS) totals[t.key] += Number(entry[t.key]) || 0;
    }
  }

  const base = { challengeDays: CHALLENGE_DAYS, tasks: TASKS, today, startDate, totals };
  if (!startDate) return { ...base, status: 'not-set', streak: 0, attempts: [], calendar: [] };
  if (startDate > today) return { ...base, status: 'not-started', streak: 0, attempts: [], calendar: [] };

  const attempts = [];
  let attempt = { number: 1, start: startDate, end: null, days: 0, endedBy: null };
  const calendar = [];
  let completedOn = null;

  for (let date = startDate; date <= today; date = addDays(date, 1)) {
    const entry = days[date] || null;
    let status;
    if (dayPasses(entry)) status = 'pass';
    else if (date === today && !entry) status = 'pending';
    else status = entry ? 'fail' : 'missed';

    calendar.push({ date, status, attempt: attempt.number, day: attempt.days + 1, tasks: taskResults(entry) });

    if (status === 'pass') {
      attempt.days++;
      if (attempt.days === CHALLENGE_DAYS) {
        attempt.end = date;
        completedOn = date;
        break;
      }
    } else if (status !== 'pending') {
      attempt.end = date;
      attempt.endedBy = status;
      attempts.push(attempt);
      attempt = { number: attempt.number + 1, start: addDays(date, 1), end: null, days: 0, endedBy: null };
    }
  }
  attempts.push(attempt);

  const current = attempts[attempts.length - 1];
  const todayEntry = calendar.find((c) => c.date === today) || null;
  return {
    ...base,
    status: completedOn ? 'complete' : 'in-progress',
    completedOn,
    attempt: current.number,
    attemptStart: current.start,
    streak: current.days,
    bestStreak: Math.max(...attempts.map((a) => a.days)),
    today: todayEntry ? todayEntry.date : today,
    todayStatus: completedOn ? 'complete' : current.start > today ? 'restarts-tomorrow' : todayEntry ? todayEntry.status : 'pending',
    attempts,
    calendar: calendar.filter((c) => c.attempt === current.number),
    pastCalendar: calendar.filter((c) => c.attempt !== current.number),
  };
}

// Validates an admin's day log. Returns { entry } or { error }.
function parseDayEntry(input) {
  const entry = {};
  for (const t of TASKS) {
    const v = input[t.key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1_000_000) {
      return { error: `Enter a number for "${t.label}".` };
    }
    entry[t.key] = Math.round(v);
  }
  if (input.note !== undefined) {
    if (typeof input.note !== 'string' || input.note.length > 280) return { error: 'Notes are limited to 280 characters.' };
    entry.note = input.note.trim();
  }
  return { entry };
}

module.exports = { CHALLENGE_DAYS, TASKS, isValidDate, isValidTimeZone, addDays, todayIn, computeProgress, parseDayEntry, dayPasses };
