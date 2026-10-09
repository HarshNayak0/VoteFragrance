'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { computeProgress, addDays, todayIn, parseDayEntry } = require('../lib/challenge');

const GOOD = { workoutMin: 50, steps: 12000, deficit: 400, frenchMin: 15 };

function logRange(start, count, entry = GOOD) {
  const days = {};
  for (let i = 0; i < count; i++) days[addDays(start, i)] = { ...entry };
  return days;
}

test('no start date, or a start in the future', () => {
  assert.strictEqual(computeProgress({ startDate: null, today: '2026-10-09', days: {} }).status, 'not-set');
  assert.strictEqual(computeProgress({ startDate: '2026-11-01', today: '2026-10-09', days: {} }).status, 'not-started');
});

test('streak counts passing days and leaves today pending', () => {
  const p = computeProgress({ startDate: '2026-10-01', today: '2026-10-04', days: logRange('2026-10-01', 3) });
  assert.strictEqual(p.status, 'in-progress');
  assert.strictEqual(p.streak, 3);
  assert.strictEqual(p.attempt, 1);
  assert.strictEqual(p.todayStatus, 'pending');
  assert.deepStrictEqual(p.calendar.map((c) => c.status), ['pass', 'pass', 'pass', 'pending']);
  assert.strictEqual(p.totals.steps, 36000);
});

test('each task enforces its rule, including the deficit ceiling', () => {
  const cases = [
    [{ ...GOOD, workoutMin: 44 }, 'fail'],
    [{ ...GOOD, steps: 9999 }, 'fail'],
    [{ ...GOOD, deficit: 299 }, 'fail'],
    [{ ...GOOD, deficit: 501 }, 'fail'],
    [{ ...GOOD, frenchMin: 9 }, 'fail'],
    [{ workoutMin: 45, steps: 10000, deficit: 500, frenchMin: 10 }, 'pass'],
    [{ ...GOOD, deficit: 300 }, 'pass'],
  ];
  for (const [entry, expected] of cases) {
    const p = computeProgress({ startDate: '2026-10-01', today: '2026-10-02', days: { '2026-10-01': entry } });
    const day = [...p.pastCalendar, ...p.calendar].find((c) => c.date === '2026-10-01');
    assert.strictEqual(day.status, expected, JSON.stringify(entry));
  }
});

test('a failed day restarts at Day 1 the next day', () => {
  const days = logRange('2026-10-01', 5);
  days['2026-10-03'].steps = 500;
  const p = computeProgress({ startDate: '2026-10-01', today: '2026-10-06', days });
  assert.strictEqual(p.attempt, 2);
  assert.strictEqual(p.attemptStart, '2026-10-04');
  assert.strictEqual(p.streak, 2);
  assert.deepStrictEqual(p.attempts[0], { number: 1, start: '2026-10-01', end: '2026-10-03', days: 2, endedBy: 'fail' });
  assert.strictEqual(p.bestStreak, 2);
});

test('a past day with no log counts as missed', () => {
  const days = logRange('2026-10-01', 2);
  days['2026-10-04'] = { ...GOOD };
  const p = computeProgress({ startDate: '2026-10-01', today: '2026-10-05', days });
  assert.strictEqual(p.attempts[0].endedBy, 'missed');
  assert.strictEqual(p.attemptStart, '2026-10-04');
  assert.strictEqual(p.streak, 1);
});

test('failing today means the restart begins tomorrow', () => {
  const days = logRange('2026-10-01', 3);
  days['2026-10-03'].frenchMin = 0;
  const p = computeProgress({ startDate: '2026-10-01', today: '2026-10-03', days });
  assert.strictEqual(p.todayStatus, 'restarts-tomorrow');
  assert.strictEqual(p.streak, 0);
});

test('75 passing days completes the challenge and stops counting', () => {
  const days = logRange('2026-10-01', 80);
  const p = computeProgress({ startDate: '2026-10-01', today: addDays('2026-10-01', 90), days });
  assert.strictEqual(p.status, 'complete');
  assert.strictEqual(p.completedOn, addDays('2026-10-01', 74));
  assert.strictEqual(p.streak, 75);
});

test('today follows the challenger time zone', () => {
  const instant = new Date('2026-10-10T02:00:00Z');
  assert.strictEqual(todayIn('UTC', instant), '2026-10-10');
  assert.strictEqual(todayIn('America/Los_Angeles', instant), '2026-10-09');
});

test('day entries must be complete numbers', () => {
  assert.ok(parseDayEntry({ ...GOOD }).entry);
  assert.match(parseDayEntry({ ...GOOD, steps: null }).error, /10,000 steps/);
  assert.match(parseDayEntry({ ...GOOD, deficit: -1 }).error, /deficit/);
  assert.match(parseDayEntry({ ...GOOD, note: 'x'.repeat(281) }).error, /280/);
});
