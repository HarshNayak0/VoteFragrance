'use strict';

let data = null;
let editingId = null;

function showMsg(id, text, kind = '') {
  const m = $(id);
  m.className = `form-msg ${kind}`;
  m.textContent = text;
}

// A button that asks "Sure?" on the first click and acts on the second.
function confirmButton(label, action) {
  let armed = false;
  const btn = el('button', { class: 'btn danger', type: 'button' }, label);
  btn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      btn.textContent = 'Click again to confirm';
      setTimeout(() => { armed = false; btn.textContent = label; }, 4000);
      return;
    }
    btn.disabled = true;
    await action();
  });
  return btn;
}

// ---------- session ----------
async function boot() {
  const session = await api('/api/admin/session');
  if (!session.configured) {
    $('login-view').hidden = false;
    $('login-form').replaceChildren(el('p', { class: 'form-msg error' },
      'The admin password is not set. Add an ADMIN_PASSWORD environment variable in your Vercel project settings, then redeploy.'));
    return;
  }
  if (!session.authenticated) {
    $('login-view').hidden = false;
    $('password').focus();
    return;
  }
  $('login-view').hidden = true;
  $('admin-view').hidden = false;
  $('logout').hidden = false;
  await refresh(true);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showMsg('login-msg', 'Checking…');
  try {
    await api('/api/admin/session', { method: 'POST', body: { password: $('password').value } });
    $('password').value = '';
    showMsg('login-msg', '');
    await boot();
  } catch (err) {
    showMsg('login-msg', err.message, 'error');
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/admin/session', { method: 'DELETE' }).catch(() => {});
  location.reload();
});

async function refresh(first = false) {
  try {
    data = await api('/api/admin/data');
  } catch (err) {
    if (err.status === 401) return location.reload();
    throw err;
  }
  $('setup-banner').hidden = Boolean(data.settings.startDate);
  if (first) {
    buildDayInputs();
    $('d-date').value = data.progress.today;
    $('d-date').max = data.progress.today;
    loadDayIntoForm();
    fillSettings();
  }
  renderDays();
  renderFragrances();
}

// ---------- daily log ----------
function buildDayInputs() {
  $('day-inputs').replaceChildren(
    ...data.progress.tasks.map((t) =>
      el('label', { for: `d-${t.key}` }, `${t.label} (${t.unit})`,
        el('input', { id: `d-${t.key}`, type: 'number', inputmode: 'numeric', min: '0', step: '1', required: true, oninput: renderChecks }))),
  );
}

function readDayForm() {
  const entry = { date: $('d-date').value, note: $('d-note').value };
  for (const t of data.progress.tasks) {
    const raw = $(`d-${t.key}`).value;
    entry[t.key] = raw === '' ? null : Number(raw);
  }
  return entry;
}

function renderChecks() {
  const entry = readDayForm();
  $('day-checks').replaceChildren(
    ...data.progress.tasks.map((t) => {
      const v = entry[t.key];
      const cls = v === null ? '' : v >= t.min && (t.max === undefined || v <= t.max) ? 'met' : 'missed';
      const rule = t.max === undefined ? `${fmtNum(t.min)}+ ${t.unit}` : `${fmtNum(t.min)}–${fmtNum(t.max)} ${t.unit}`;
      return el('li', { class: cls }, `${t.label}: needs ${rule}`);
    }),
  );
}

function loadDayIntoForm() {
  const existing = data.days[$('d-date').value];
  for (const t of data.progress.tasks) $(`d-${t.key}`).value = existing ? existing[t.key] : '';
  $('d-note').value = existing && existing.note ? existing.note : '';
  showMsg('day-msg', existing ? 'Editing a day you already logged.' : '');
  renderChecks();
}
$('d-date').addEventListener('change', loadDayIntoForm);

$('day-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showMsg('day-msg', 'Saving…');
  try {
    await api('/api/admin/day', { method: 'PUT', body: readDayForm() });
    await refresh();
    const p = data.progress;
    const outcome = p.status === 'complete'
      ? 'Day 75 done. Challenge complete, and voting is now closed!'
      : p.todayStatus === 'restarts-tomorrow'
        ? 'Saved. That day missed a task, so the challenge restarts at Day 1.'
        : `Saved. Current streak: ${p.streak} ${p.streak === 1 ? 'day' : 'days'}.`;
    showMsg('day-msg', outcome, 'ok');
  } catch (err) {
    showMsg('day-msg', err.message, 'error');
  }
});

function renderDays() {
  const dates = Object.keys(data.days).sort().reverse();
  if (!dates.length) {
    $('day-list').replaceChildren(el('li', { class: 'empty' }, 'No days logged yet.'));
    return;
  }
  $('day-list').replaceChildren(
    ...dates.map((date) => {
      const d = data.days[date];
      const summary = data.progress.tasks.map((t) => fmtTaskValue(t, d[t.key])).join(' · ');
      return el('li', { class: 'item' },
        el('div', { class: 'meta' }, el('b', {}, fmtDate(date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })), el('span', {}, summary), d.note ? el('span', {}, d.note) : null),
        el('div', { class: 'actions' },
          el('button', { class: 'btn ghost', type: 'button', onclick: () => { $('d-date').value = date; loadDayIntoForm(); $('log').scrollIntoView({ behavior: 'smooth' }); } }, 'Edit'),
          confirmButton('Delete', async () => {
            await api('/api/admin/day', { method: 'DELETE', body: { date } });
            await refresh();
            loadDayIntoForm();
          })));
    }),
  );
}

// ---------- fragrances ----------
function resetFragForm() {
  editingId = null;
  $('frag-form').reset();
  $('f-submit').textContent = 'Add to ballot';
  $('f-cancel').hidden = true;
}
$('f-cancel').addEventListener('click', () => { resetFragForm(); showMsg('frag-msg', ''); });

$('frag-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { name: $('f-name').value, house: $('f-house').value, notes: $('f-notes').value, vibe: $('f-vibe').value };
  try {
    if (editingId) await api('/api/admin/fragrances', { method: 'PUT', body: { id: editingId, ...body } });
    else await api('/api/admin/fragrances', { method: 'POST', body });
    showMsg('frag-msg', editingId ? 'Saved.' : 'Added to the ballot.', 'ok');
    resetFragForm();
    await refresh();
  } catch (err) {
    showMsg('frag-msg', err.message, 'error');
  }
});

function editFragrance(f) {
  editingId = f.id;
  $('f-name').value = f.name;
  $('f-house').value = f.house || '';
  $('f-notes').value = (f.notes || []).join(', ');
  $('f-vibe').value = f.vibe || '';
  $('f-submit').textContent = f.status === 'pending' ? 'Save and keep pending' : 'Save changes';
  $('f-cancel').hidden = false;
  showMsg('frag-msg', `Editing ${f.name}.`);
  $('frag-form').scrollIntoView({ behavior: 'smooth' });
}

function fragranceItem(f) {
  const remove = (label) => confirmButton(label, async () => {
    await api('/api/admin/fragrances', { method: 'DELETE', body: { id: f.id } });
    if (editingId === f.id) resetFragForm();
    await refresh();
  });
  const detail = [f.house, (f.notes || []).join(', '), f.status === 'approved' ? `${fmtNum(f.votes)} ${f.votes === 1 ? 'vote' : 'votes'}` : 'suggested by a visitor']
    .filter(Boolean).join(' · ');
  return el('li', { class: 'item' },
    el('div', { class: 'meta' }, el('b', {}, f.name), el('span', {}, detail)),
    el('div', { class: 'actions' },
      f.status === 'pending'
        ? el('button', { class: 'btn', type: 'button', onclick: async () => { await api('/api/admin/fragrances', { method: 'PUT', body: { id: f.id, status: 'approved' } }); await refresh(); } }, 'Approve')
        : null,
      el('button', { class: 'btn ghost', type: 'button', onclick: () => editFragrance(f) }, 'Edit'),
      remove(f.status === 'pending' ? 'Reject' : 'Remove')));
}

function renderFragrances() {
  const pending = data.fragrances.filter((f) => f.status === 'pending');
  const approved = data.fragrances.filter((f) => f.status === 'approved');
  $('pending-list').replaceChildren(...(pending.length ? pending.map(fragranceItem) : [el('li', { class: 'empty' }, 'No suggestions right now.')]));
  $('ballot-list').replaceChildren(...(approved.length ? approved.map(fragranceItem) : [el('li', { class: 'empty' }, 'Nothing on the ballot yet. Add your first fragrance above.')]));
}

// ---------- settings ----------
function fillSettings() {
  const s = data.settings;
  $('s-title').value = s.title;
  $('s-tagline').value = s.tagline;
  $('s-start').value = s.startDate || '';
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Until a start date is saved, suggest this device's time zone over the UTC default.
  $('s-tz').value = !s.startDate && s.timeZone === 'UTC' && browserTz ? browserTz : s.timeZone;
  if (Intl.supportedValuesOf) {
    $('tz-list').replaceChildren(...Intl.supportedValuesOf('timeZone').map((tz) => el('option', { value: tz })));
  }
}

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/settings', {
      method: 'PUT',
      body: { title: $('s-title').value, tagline: $('s-tagline').value, startDate: $('s-start').value || null, timeZone: $('s-tz').value.trim() },
    });
    await refresh();
    $('d-date').max = data.progress.today;
    showMsg('settings-msg', 'Saved.', 'ok');
  } catch (err) {
    showMsg('settings-msg', err.message, 'error');
  }
});

boot().catch(() => {
  $('login-view').hidden = false;
  showMsg('login-msg', "Couldn't reach the server. Refresh to try again.", 'error');
});
