const eventId = new URLSearchParams(location.search).get('id') || '';
const ME_KEY = `fixadule:me:${eventId}`;
const KNOWN_KEY = `fixadule:known:${eventId}`;
const isTouch = matchMedia('(pointer: coarse)').matches;
const $ = (id) => document.getElementById(id);

let ev = null;
let hostKey = null;
let perDay = 0;
let me = null;
let mySlots = new Set();
let myCells = [];
let groupCells = [];
const focusSources = new Map();
let stickyFocus = null;
let hoveredIdx = null;
let dragging = false;
let dirty = false;
let saveTimer = null;
let saveSeq = 0;

init();

window.addEventListener('hashchange', () => {
  if (new URLSearchParams(location.hash.slice(1)).has('host')) location.reload();
});

async function init() {
  const hashKey = new URLSearchParams(location.hash.slice(1)).get('host');
  if (hashKey) {
    saveHostKey(eventId, hashKey);
    history.replaceState(null, '', location.pathname + location.search);
  }
  hostKey = hostKeyFor(eventId);

  try {
    ev = await loadEvent();
  } catch {
    $('loading').hidden = true;
    $('not-found').hidden = false;
    return;
  }
  if (hostKey && !ev.isHost) {
    store.remove(`fixadule:host:${eventId}`);
    hostKey = null;
  }

  perDay = (ev.end - ev.start) / ev.slot;
  rememberEvent(ev);
  document.title = `${ev.title} · Fixadule`;
  $('event-title').textContent = ev.title;
  $('event-meta').textContent =
    `${ev.days.map((d) => DAY_NAMES[d]).join(', ')} · ${fmtTime(ev.start)} – ${fmtTime(ev.end)}`;

  setupLayout();
  myCells = buildGrid($('my-grid'));
  setupShare();
  setupJoin();
  setupEditor();
  if (ev.isHost) {
    groupCells = buildGrid($('group-grid'));
    setupGroup();
  }

  const saved = store.get(ME_KEY);
  if (saved) await resume(saved);

  renderAll();
  $('loading').hidden = true;
  $('app').hidden = false;

  if (ev.isHost) {
    setInterval(refresh, 8000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });
  }
  window.addEventListener('pagehide', flushOnLeave);
}

function loadEvent() {
  return api('GET', `/api/events/${eventId}`, null, hostKey ? { 'X-Host-Key': hostKey } : {});
}

async function refresh() {
  if (dragging || dirty || document.hidden) return;
  try {
    const latest = await loadEvent();
    if (dragging || dirty) return;
    ev = latest;
    renderGroup();
  } catch {
    // Offline or a temporary error; try again on the next tick.
  }
}

function setupLayout() {
  const url = eventUrl(ev.id);
  $('share-url').value = url;

  if (ev.isHost) {
    $('host-badge').hidden = false;
    $('overview').hidden = false;
    $('host-link-box').hidden = false;
    $('host-url').value = `${url}#host=${hostKey}`;
    $('invite-text').textContent = "Send this link to your friends. They'll add their free times, and only you will see the overview.";
    $('join-title').textContent = 'Add your own times';
    $('join-text').textContent = "Optional, if you're joining too.";
    $('panels').classList.add('host');
  } else {
    $('panels').classList.add('solo');
    $('invite-title').textContent = 'Know someone who should join?';
    $('invite-text').textContent = 'Share this link with them.';
    $('invite').classList.add('compact');
    $('panels').after($('invite'));
    $('join-text').textContent = "Only the host will see everyone's answers.";
  }
  $('hover-info').textContent = isTouch ? "Tap a time slot to see who's free." : "Hover over a time slot to see who's free.";
}

/* ---------- Helpers ---------- */

const posOf = (i) => ({ d: Math.floor(i / perDay), t: i % perDay });
const slotStart = (t) => ev.start + t * ev.slot;

function slotLabel(i) {
  const { d, t } = posOf(i);
  return `${DAY_NAMES[ev.days[d]]} ${fmtTime(slotStart(t))} – ${fmtTime(slotStart(t + 1))}`;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

function buildGrid(container) {
  container.innerHTML = '';
  container.style.gridTemplateColumns = `auto repeat(${ev.days.length}, minmax(0, 1fr))`;
  container.append(el('div', { class: 'corner' }));
  for (const d of ev.days) {
    container.append(el('div', { class: 'day-head', text: DAY_NAMES[d], title: DAY_NAMES_LONG[d] }));
  }

  const cells = new Array(ev.days.length * perDay);
  for (let t = 0; t < perDay; t++) {
    const onHour = slotStart(t) % 60 === 0;
    container.append(el('div', { class: 'time-label', text: onHour ? fmtHour(slotStart(t)) : '' }));
    for (let d = 0; d < ev.days.length; d++) {
      const i = d * perDay + t;
      cells[i] = el('div', { class: `cell ${onHour ? 'hour' : 'half'}`, 'data-i': i });
      container.append(cells[i]);
    }
  }
  return cells;
}

/* ---------- Share ---------- */

async function copyText(input) {
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  toast('Link copied');
}

function setupShare() {
  const input = $('share-url');
  const btn = $('share-btn');
  const canShare = isTouch && typeof navigator.share === 'function';
  if (canShare) btn.textContent = 'Share link';

  input.addEventListener('focus', () => input.select());
  $('host-url').addEventListener('focus', (e) => e.target.select());

  btn.addEventListener('click', async () => {
    if (canShare) {
      try {
        await navigator.share({ title: ev.title, text: `When are you free for "${ev.title}"? Add your times:`, url: input.value });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    copyText(input);
  });
  $('host-copy').addEventListener('click', () => copyText($('host-url')));
}

/* ---------- Identity ---------- */

function knownPeople() {
  return store.get(KNOWN_KEY) || [];
}

function remember(person) {
  const list = knownPeople().filter((p) => p.token !== person.token);
  list.push({ token: person.token, name: person.name });
  store.set(KNOWN_KEY, list);
  store.set(ME_KEY, { token: person.token, name: person.name });
}

function forget(token) {
  store.set(KNOWN_KEY, knownPeople().filter((p) => p.token !== token));
  store.remove(ME_KEY);
}

async function resume(saved) {
  try {
    const person = await api('GET', `/api/events/${eventId}/me`, null, { 'X-Person-Token': saved.token });
    startEditing(person, true);
    return true;
  } catch (err) {
    if (err.status === 404) forget(saved.token);
    return false;
  }
}

function setupJoin() {
  $('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('name-input').value.replace(/\s+/g, ' ').trim();
    if (!name) return;
    const errorEl = $('join-error');
    errorEl.hidden = true;

    const known = knownPeople().find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (known && (await resume(known))) return renderAll();

    const btn = e.submitter;
    btn.disabled = true;
    try {
      const person = await api('PUT', `/api/events/${eventId}/me`, { name, slots: [] });
      remember(person);
      startEditing(person, false);
      if (ev.isHost) await refresh();
      renderAll();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  $('switch-user').addEventListener('click', async () => {
    if (dirty) await save();
    store.remove(ME_KEY);
    stopEditing();
  });

  $('clear-btn').addEventListener('click', () => {
    if (!mySlots.size) return;
    mySlots.clear();
    renderMine();
    renderGroup();
    queueSave();
  });

  $('remove-btn').addEventListener('click', async () => {
    if (!confirm(`Remove ${me.name}'s response from this event?`)) return;
    clearTimeout(saveTimer);
    saveSeq++;
    try {
      await api('DELETE', `/api/events/${eventId}/me`, null, { 'X-Person-Token': me.token });
      dirty = false;
      forget(me.token);
      stopEditing();
      if (ev.isHost) refresh();
      toast('Your response was removed');
    } catch (err) {
      setStatus(err.message, true);
    }
  });
}

function startEditing(person, existing) {
  me = person;
  mySlots = new Set(person.slots);
  $('me-name').textContent = person.name;
  $('join').hidden = true;
  $('editor').hidden = false;
  setStatus(existing ? 'Your saved times are loaded.' : 'Changes save automatically.');
}

function stopEditing() {
  me = null;
  mySlots = new Set();
  $('name-input').value = '';
  $('editor').hidden = true;
  $('join').hidden = false;
  renderAll();
}

/* ---------- Editor (painting) ---------- */

function setupEditor() {
  const grid = $('my-grid');
  let anchor = null;
  let adding = true;
  let snapshot = null;

  document.querySelectorAll('#touch-mode button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#touch-mode button').forEach((b) => b.classList.toggle('on', b === btn));
      grid.classList.toggle('scroll-mode', btn.dataset.mode === 'scroll');
    });
  });

  grid.addEventListener('pointerdown', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell || e.button > 0 || grid.classList.contains('scroll-mode')) return;
    e.preventDefault();
    const i = Number(cell.dataset.i);
    anchor = posOf(i);
    adding = !mySlots.has(i);
    snapshot = new Set(mySlots);
    dragging = true;
    paintTo(anchor);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  function onMove(e) {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const cell = target && target.closest('#my-grid .cell');
    if (cell) paintTo(posOf(Number(cell.dataset.i)));
  }

  function onUp() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    dragging = false;
    queueSave();
  }

  function paintTo(pos) {
    mySlots = new Set(snapshot);
    const [d0, d1] = [Math.min(anchor.d, pos.d), Math.max(anchor.d, pos.d)];
    const [t0, t1] = [Math.min(anchor.t, pos.t), Math.max(anchor.t, pos.t)];
    for (let d = d0; d <= d1; d++) {
      for (let t = t0; t <= t1; t++) {
        const i = d * perDay + t;
        adding ? mySlots.add(i) : mySlots.delete(i);
      }
    }
    renderMine();
    renderGroup();
  }
}

function queueSave() {
  dirty = true;
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}

async function save() {
  clearTimeout(saveTimer);
  if (!me) return;
  const seq = ++saveSeq;
  try {
    const updated = await api('PUT', `/api/events/${eventId}/me`, { slots: [...mySlots] }, { 'X-Person-Token': me.token });
    if (seq !== saveSeq) return;
    me = updated;
    dirty = false;
    setStatus(ev.isHost ? 'All changes saved ✓' : "Saved ✓ The host can now see your times.");
    if (ev.isHost) refresh();
  } catch (err) {
    if (seq !== saveSeq) return;
    setStatus(`Couldn't save (${err.message}). Retrying…`, true);
    saveTimer = setTimeout(save, 3000);
  }
}

function flushOnLeave() {
  if (!dirty || !me) return;
  fetch(`${API_BASE}/api/events/${eventId}/me`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Person-Token': me.token },
    body: JSON.stringify({ slots: [...mySlots] }),
    keepalive: true,
  });
}

function setStatus(msg, isError = false) {
  const s = $('save-status');
  s.textContent = msg;
  s.classList.toggle('error', isError);
}

/* ---------- Host overview ---------- */

function setupGroup() {
  const grid = $('group-grid');
  grid.addEventListener('pointerover', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    hoveredIdx = Number(cell.dataset.i);
    renderHoverInfo();
  });
}

function peopleView() {
  const list = (ev.people || []).map((p) => (me && p.id === me.id ? { ...p, slots: [...mySlots] } : p));
  return { all: list, active: list.filter((p) => p.slots.length) };
}

function whoPerSlot(people) {
  const who = Array.from({ length: ev.days.length * perDay }, () => []);
  for (const p of people) {
    for (const i of p.slots) if (who[i]) who[i].push(p.name);
  }
  return who;
}

function setFocus(set) {
  $('group-grid').classList.toggle('focus-mode', !!set);
  groupCells.forEach((c, i) => c.classList.toggle('hl', !!set && set.has(i)));
}

function bindFocus(node, key, getSet) {
  node.dataset.key = key;
  focusSources.set(key, getSet);
  node.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'mouse' && !stickyFocus) setFocus(getSet());
  });
  node.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !stickyFocus) setFocus(null);
  });
  node.addEventListener('click', () => {
    stickyFocus = stickyFocus === key ? null : key;
    setFocus(stickyFocus ? getSet() : null);
    renderFocusMarkers();
  });
}

function renderFocusMarkers() {
  document.querySelectorAll('[data-key]').forEach((n) => n.classList.toggle('active', n.dataset.key === stickyFocus));
}

function heat(ratio) {
  return `rgba(22, 163, 74, ${0.18 + 0.82 * ratio})`;
}

function renderAll() {
  renderMine();
  renderGroup();
}

function renderMine() {
  myCells.forEach((c, i) => c.classList.toggle('on', mySlots.has(i)));
}

function renderGroup() {
  if (!ev.isHost) return;
  const { all, active } = peopleView();
  const total = active.length;
  const who = whoPerSlot(active);

  $('response-count').textContent = `${all.length} responded`;
  $('empty-group').hidden = all.length > 0;
  $('group').hidden = all.length === 0;
  if (!all.length) return;

  focusSources.clear();
  groupCells.forEach((c, i) => {
    const n = who[i].length;
    c.style.background = n ? heat(n / total) : '';
  });
  $('legend-scale').style.background = `linear-gradient(to right, ${heat(0)}, ${heat(1)})`;

  renderBest(active, who);
  renderPeople(all);
  renderHoverInfo(who, active);

  if (stickyFocus && !focusSources.has(stickyFocus)) stickyFocus = null;
  setFocus(stickyFocus ? focusSources.get(stickyFocus)() : null);
  renderFocusMarkers();
}

function bestTimes(people, who) {
  const minPeople = Math.min(2, people.length);
  const ranges = [];
  for (let d = 0; d < ev.days.length; d++) {
    let cur = null;
    for (let t = 0; t <= perDay; t++) {
      const names = t < perDay ? who[d * perDay + t] : [];
      const key = names.join('\u0000');
      if (cur && names.length && key === cur.key) {
        cur.endT = t + 1;
        continue;
      }
      if (cur) ranges.push(cur);
      cur = names.length && names.length >= minPeople ? { d, startT: t, endT: t + 1, key, names } : null;
    }
  }
  return ranges
    .sort((a, b) => b.names.length - a.names.length || (b.endT - b.startT) - (a.endT - a.startT) || a.d - b.d || a.startT - b.startT)
    .slice(0, 5);
}

function renderBest(people, who) {
  const list = $('best-list');
  list.innerHTML = '';
  const total = people.length;
  const ranges = bestTimes(people, who);

  if (!ranges.length) {
    const msg = !total ? 'No one has added times yet.' : total < 2 ? 'Waiting for more people to add their times…' : 'No overlapping free time yet.';
    list.append(el('li', { class: 'empty muted', text: msg }));
    return;
  }

  for (const r of ranges) {
    const set = new Set();
    for (let t = r.startT; t < r.endT; t++) set.add(r.d * perDay + t);
    const missing = people.map((p) => p.name).filter((n) => !r.names.includes(n));
    const everyone = r.names.length === total;

    const item = el('li', { class: 'best-item' },
      el('div', { class: 'best-main' },
        el('strong', { text: `${DAY_NAMES_LONG[ev.days[r.d]]} · ${fmtTime(slotStart(r.startT))} – ${fmtTime(slotStart(r.endT))}` }),
        el('span', { class: 'muted small-text', text: fmtDuration((r.endT - r.startT) * ev.slot) }),
        el('span', { class: `pill ${everyone ? 'good' : ''}`, text: everyone ? 'Everyone' : `${r.names.length}/${total}` }),
      ),
      everyone ? null : el('div', { class: 'muted small-text', text: `Missing: ${missing.join(', ')}` }),
    );
    bindFocus(item, `range:${r.d}:${r.startT}:${r.endT}`, () => set);
    list.append(item);
  }
}

function renderPeople(people) {
  const list = $('people-list');
  list.innerHTML = '';
  for (const p of people) {
    const isMe = me && p.id === me.id;
    const chip = el('button', { type: 'button', class: `chip ${isMe ? 'me' : ''} ${p.slots.length ? '' : 'idle'}` },
      p.name,
      isMe ? el('span', { class: 'muted', text: ' (you)' }) : null,
      el('span', { class: 'chip-count', text: p.slots.length ? fmtDuration(p.slots.length * ev.slot) : 'no times yet' }),
    );
    const set = new Set(p.slots);
    bindFocus(chip, `person:${p.id}`, () => set);

    const remove = el('button', {
      type: 'button',
      class: 'chip-remove',
      'aria-label': `Remove ${p.name}`,
      title: `Remove ${p.name}`,
      text: '×',
      onclick: () => removePerson(p),
    });
    list.append(el('span', { class: 'chip-wrap' }, chip, remove));
  }
}

async function removePerson(p) {
  if (!confirm(`Remove ${p.name}'s response?`)) return;
  try {
    ev = await api('DELETE', `/api/events/${eventId}/people/${p.id}`, null, { 'X-Host-Key': hostKey });
    if (me && p.id === me.id) {
      forget(me.token);
      stopEditing();
    }
    renderGroup();
    toast(`Removed ${p.name}`);
  } catch (err) {
    toast(err.message);
  }
}

function renderHoverInfo(who, people) {
  if (hoveredIdx == null) return;
  if (!people) {
    people = peopleView().active;
    who = whoPerSlot(people);
  }
  const free = who[hoveredIdx];
  const busy = people.map((p) => p.name).filter((n) => !free.includes(n));

  const box = $('hover-info');
  box.innerHTML = '';
  box.append(
    el('strong', { text: slotLabel(hoveredIdx) }),
    el('span', { class: 'pill', text: `${free.length}/${people.length} free` }),
    el('div', {}, el('span', { class: 'ok', text: 'Free: ' }), free.length ? free.join(', ') : 'nobody'),
    busy.length ? el('div', {}, el('span', { class: 'no', text: 'Busy: ' }), busy.join(', ')) : null,
  );
}
