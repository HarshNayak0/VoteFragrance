'use strict';

let state = null;
let busy = false;

function renderProgress(p) {
  const pill = $('attempt-pill');
  const big = $('day-big');
  const status = $('day-status');
  pill.className = 'pill';

  if (p.status === 'not-set' || p.status === 'not-started') {
    pill.textContent = 'Starting soon';
    big.innerHTML = 'Day 0<small> / 75</small>';
    status.textContent = p.startDate ? `Day 1 is ${fmtDate(p.startDate, { weekday: 'long', month: 'long', day: 'numeric' })}.` : 'The start date has not been set yet.';
  } else if (p.status === 'complete') {
    pill.textContent = 'Challenge complete';
    pill.classList.add('pass');
    big.innerHTML = '75<small> / 75</small>';
    status.textContent = `Finished on ${fmtDate(p.completedOn, { month: 'long', day: 'numeric', year: 'numeric' })}${p.attempt > 1 ? ` on attempt ${p.attempt}` : ''}.`;
  } else {
    pill.textContent = `Attempt ${p.attempt}`;
    big.innerHTML = `Day ${Math.min(p.streak + 1, 75)}<small> / 75</small>`;
    if (p.todayStatus === 'restarts-tomorrow') {
      pill.classList.add('fail');
      pill.textContent = `Attempt ${p.attempt} starts tomorrow`;
      big.innerHTML = 'Day 0<small> / 75</small>';
      status.textContent = "Missed today. Back to Day 1 tomorrow.";
    } else if (p.todayStatus === 'pass') {
      big.innerHTML = `Day ${p.streak}<small> / 75</small>`;
      status.textContent = `Today is done. ${75 - p.streak} days to go.`;
    } else {
      status.textContent = `${p.streak} ${p.streak === 1 ? 'day' : 'days'} completed, ${75 - p.streak} to go.`;
    }
  }

  // Today's four tasks
  const today = [...(p.calendar || []), ...(p.pastCalendar || [])].find((c) => c.date === p.today);
  $('tasks-heading').textContent = `Today, ${fmtDate(p.today, { weekday: 'long', month: 'short', day: 'numeric' })}`;
  $('tasks').replaceChildren(
    ...p.tasks.map((t) => {
      const r = today && today.tasks.find((x) => x.key === t.key);
      const logged = r && r.value !== null;
      const cls = !logged ? '' : r.met ? 'met' : 'missed';
      return el('li', { class: `task ${cls}` },
        el('span', { class: 'mark', 'aria-hidden': 'true' }, !logged ? '' : r.met ? '✓' : '✕'),
        el('span', { class: 'label' }, t.label),
        el('span', { class: 'value' }, fmtTaskValue(t, logged ? r.value : null)));
    }),
  );

  // 75 cells for the current attempt
  const cal = $('calendar');
  const cells = [];
  const byDay = new Map((p.calendar || []).map((c) => [c.day, c]));
  for (let d = 1; d <= 75; d++) {
    const c = byDay.get(d);
    const passedAll = p.status === 'complete';
    const cls = c ? c.status : passedAll ? 'pass' : '';
    const label = c ? `Day ${d}, ${fmtDate(c.date)}: ${c.status === 'pass' ? 'complete' : c.status}` : `Day ${d}`;
    cells.push(el('div', { class: `cell ${cls}`, title: label, 'aria-label': label }, String(d)));
  }
  cal.replaceChildren(...cells);

  // Totals across every day logged since the start
  const t = p.totals;
  const stat = (value, label) => el('div', { class: 'stat' }, el('b', {}, value), el('span', {}, label));
  $('stats').replaceChildren(
    stat(fmtNum(t.steps), 'steps walked'),
    stat(`${fmtNum(Math.round(t.workoutMin / 60))} h`, 'of workouts'),
    stat(fmtNum(t.deficit), 'calories cut'),
    stat(`${fmtNum(Math.round(t.frenchMin / 60 * 10) / 10)} h`, 'of French'),
    stat(fmtNum(t.daysLogged), 'days logged'),
    stat(fmtNum(p.bestStreak || 0), 'best streak (days)'),
  );

  const past = (p.attempts || []).filter((a) => a.endedBy);
  $('attempts').replaceChildren(
    ...past.map((a) =>
      el('li', {}, `Attempt ${a.number}: ${a.days} ${a.days === 1 ? 'day' : 'days'} (${fmtDate(a.start)}–${fmtDate(a.end)}), ended by a ${a.endedBy === 'missed' ? 'day with no log' : 'missed task'}.`)),
  );
}

function renderBallot() {
  const { fragrances, total, myVote, votingOpen, winners } = state;
  const showTally = Boolean(myVote) || !votingOpen;

  const winnerBox = $('winner');
  winnerBox.hidden = winners.length === 0;
  if (winners.length) {
    const names = winners.map((id) => fragrances.find((f) => f.id === id)).map((f) => `${f.house ? f.house + ' ' : ''}${f.name}`);
    winnerBox.replaceChildren(
      el('span', { class: 'eyebrow' }, winners.length > 1 ? "It's a tie" : 'The internet has spoken'),
      el('strong', {}, names.join(' & ')),
      el('span', { class: 'muted' }, `Final tally: ${fmtNum(total)} ${total === 1 ? 'vote' : 'votes'}.`),
    );
  }
  $('vote-intro').textContent = votingOpen
    ? 'One vote per person. Change it anytime until I finish Day 75.'
    : 'Voting closed when I finished Day 75.';

  if (!fragrances.length) {
    $('ballot').replaceChildren(el('li', { class: 'empty' }, 'The lineup is coming soon. Suggest a fragrance below while you wait.'));
    $('ballot-status').textContent = '';
    return;
  }

  $('ballot').replaceChildren(
    ...fragrances.map((f) => {
      const pct = total ? Math.round((f.votes / total) * 100) : 0;
      const mine = f.id === myVote;
      const btn = el('button', {
        class: `choice${mine ? ' mine' : ''}`,
        type: 'button',
        'aria-pressed': String(mine),
        disabled: !votingOpen || busy,
        onclick: () => vote(f.id),
      },
        el('span', { class: 'fill', style: `width:${showTally ? pct : 0}%` }),
        el('span', {},
          f.house ? el('span', { class: 'house' }, f.house) : null,
          el('span', { class: 'name' }, f.name),
          f.notes && f.notes.length ? el('span', { class: 'notes' }, f.notes.join(' · ')) : null,
          f.vibe ? el('span', { class: 'notes' }, f.vibe) : null),
        el('span', { class: 'tally' },
          showTally ? `${pct}%` : mine ? '' : 'Vote',
          showTally ? el('small', {}, mine ? 'your pick' : `${fmtNum(f.votes)} ${f.votes === 1 ? 'vote' : 'votes'}`) : null));
      return el('li', {}, btn);
    }),
  );
  $('ballot-status').textContent = !votingOpen
    ? ''
    : myVote
      ? `${fmtNum(total)} ${total === 1 ? 'vote' : 'votes'} so far. Tap another bottle to switch.`
      : 'Tap a bottle to vote. Results show after you vote.';
}

async function load() {
  state = await api('/api/state');
  document.title = state.title;
  $('title').textContent = state.title;
  $('tagline').textContent = state.tagline;
  renderProgress(state.progress);
  renderBallot();
}

async function vote(id) {
  if (busy || id === state.myVote) return;
  busy = true;
  renderBallot();
  try {
    const result = await api('/api/vote', { method: 'POST', body: { fragranceId: id } });
    Object.assign(state, result);
    busy = false;
    renderBallot();
  } catch (err) {
    busy = false;
    renderBallot();
    $('ballot-status').textContent = err.message;
  }
}

$('suggest-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const msg = $('suggest-msg');
  const button = form.querySelector('button');
  button.disabled = true;
  msg.className = 'form-msg';
  msg.textContent = 'Sending…';
  try {
    const res = await api('/api/suggest', { method: 'POST', body: { name: $('s-name').value, house: $('s-house').value } });
    msg.className = 'form-msg ok';
    msg.textContent = res.message;
    form.reset();
  } catch (err) {
    msg.className = 'form-msg error';
    msg.textContent = err.message;
  }
  button.disabled = false;
});

load().catch(() => {
  $('attempt-pill').textContent = 'Offline';
  $('day-status').textContent = "Couldn't load the latest progress. Refresh to try again.";
});
setInterval(() => !busy && !document.hidden && load().catch(() => {}), 30000);
