'use strict';

const $ = (id) => document.getElementById(id);
const DAY_MS = 24 * 60 * 60 * 1000;
let state = null;
let busy = false;

function hueFor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function renderProgress({ challengeStartDate, challengeDays }) {
  if (!challengeStartDate) return;
  const start = new Date(`${challengeStartDate}T00:00:00`);
  const elapsed = Math.floor((Date.now() - start) / DAY_MS) + 1;
  const day = Math.max(0, Math.min(challengeDays, elapsed));
  $('day-label').textContent = elapsed < 1 ? 'Starts soon' : `Day ${day} of ${challengeDays}`;
  $('day-status').textContent =
    elapsed > challengeDays ? 'Challenge complete' : elapsed < 1 ? '' : `${challengeDays - day} to go`;
  $('progress-fill').style.width = `${(day / challengeDays) * 100}%`;
}

function buildCards() {
  const grid = $('grid');
  const tpl = $('card-template');
  grid.replaceChildren();
  for (const f of state.fragrances) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = f.id;
    node.style.setProperty('--hue', hueFor(f.id));
    node.querySelector('.house').textContent = f.house;
    node.querySelector('.name').textContent = f.name;
    node.querySelector('.vibe').textContent = f.vibe || '';
    const notes = node.querySelector('.notes');
    for (const n of f.notes || []) {
      const chip = document.createElement('span');
      chip.className = 'note';
      chip.textContent = n;
      notes.append(chip);
    }
    node.querySelector('.card-btn').addEventListener('click', () => vote(f.id));
    grid.append(node);
  }
}

function renderResults() {
  const counts = Object.fromEntries(state.results.map((r) => [r.id, r.votes]));
  const top = state.results[0] && state.results[0].votes > 0 ? state.results[0].votes : null;
  const showResults = Boolean(state.myVote) || !state.votingOpen;

  for (const card of $('grid').children) {
    const id = card.dataset.id;
    const votes = counts[id] || 0;
    const pct = state.total ? Math.round((votes / state.total) * 100) : 0;
    const chosen = state.myVote === id;
    card.classList.toggle('chosen', chosen);
    card.classList.toggle('leader', showResults && top !== null && votes === top);
    card.querySelector('.pick').textContent = chosen ? 'Your pick ✓' : state.myVote ? 'Switch to this' : 'Vote';
    card.querySelector('.card-btn').disabled = !state.votingOpen || busy;
    card.querySelector('.card-btn').setAttribute('aria-pressed', String(chosen));
    const result = card.querySelector('.result');
    result.hidden = !showResults;
    result.querySelector('.bar-fill').style.width = `${pct}%`;
    result.querySelector('.pct').textContent = `${votes} · ${pct}%`;
  }

  $('total').textContent = `${state.total} ${state.total === 1 ? 'vote' : 'votes'}`;
  if (!state.votingOpen) $('status').textContent = 'Voting is closed. Thanks for helping me pick!';
  else if (state.myVote) $('status').textContent = 'Vote counted. Tap another bottle to change your pick.';
  else $('status').textContent = 'Tap a bottle to cast your vote. Results appear after you vote.';
}

async function load() {
  const res = await fetch('/api/state', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Could not load');
  const first = !state;
  state = await res.json();
  if (first) {
    document.title = state.title;
    $('title').textContent = state.title;
    $('subtitle').textContent = state.subtitle;
    $('tagline').textContent = state.tagline;
    renderProgress(state);
    buildCards();
  }
  renderResults();
}

async function vote(fragranceId) {
  if (busy || fragranceId === state.myVote) return;
  busy = true;
  renderResults();
  try {
    const res = await fetch('/api/vote', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fragranceId }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Vote failed');
    Object.assign(state, body);
  } catch (err) {
    busy = false;
    renderResults();
    $('status').textContent = err.message;
    return;
  }
  busy = false;
  renderResults();
}

$('share').addEventListener('click', async () => {
  const data = { title: document.title, text: 'Help pick the fragrance I earn after 75 Hard!', url: location.href };
  try {
    if (navigator.share) await navigator.share(data);
    else {
      await navigator.clipboard.writeText(location.href);
      $('share').textContent = 'Link copied!';
      setTimeout(() => ($('share').textContent = 'Share the vote'), 2000);
    }
  } catch {
    /* user dismissed the share sheet */
  }
});

load().catch(() => ($('status').textContent = 'Could not load the lineup. Refresh to try again.'));
setInterval(() => !busy && !document.hidden && load().catch(() => {}), 15000);
