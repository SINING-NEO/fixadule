const SLOT_MINUTES = 30;
const MAX_TITLE = 80;
const MAX_NAME = 40;
const MAX_PEOPLE = 100;
const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      const legacy = url.pathname.match(/^\/e\/([A-Za-z0-9_-]+)\/?$/);
      if (legacy) return Response.redirect(new URL(`/event.html?id=${legacy[1]}`, url).href, 301);
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    let response;
    try {
      response = await handleApi(request, env, url.pathname);
    } catch (err) {
      if (err instanceof HttpError) response = json(err.status, { error: err.message });
      else {
        console.error(err);
        response = json(500, { error: 'Something went wrong. Please try again.' });
      }
    }
    for (const [k, v] of Object.entries(CORS_HEADERS)) response.headers.set(k, v);
    return response;
  },
};

// The API is authorised by secret headers (never cookies), so any origin may call it.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Host-Key, X-Person-Token',
  'Access-Control-Max-Age': '86400',
};

async function handleApi(request, env, pathname) {
  const db = env.DB;
  const method = request.method;

  if (pathname === '/api/events') {
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    return createEvent(db, await readJson(request));
  }

  const match = pathname.match(/^\/api\/events\/([A-Za-z0-9_-]+)(?:\/(me|people\/([A-Za-z0-9_-]+)))?$/);
  if (!match) throw new HttpError(404, 'Not found.');
  const [, eventId, sub, personId] = match;

  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
  if (!ev) throw new HttpError(404, 'This event does not exist (or was removed).');
  const isHost = safeEqual(request.headers.get('X-Host-Key'), ev.host_key);

  if (!sub) {
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    return json(200, await eventView(db, ev, isHost));
  }

  if (sub === 'me') {
    const token = request.headers.get('X-Person-Token');
    const me = token
      ? await db.prepare('SELECT * FROM people WHERE event_id = ? AND token = ?').bind(eventId, token).first()
      : null;

    if (method === 'GET') {
      if (!me) throw new HttpError(404, 'Not found.');
      return json(200, personView(me, true));
    }
    if (method === 'PUT') return saveMe(db, ev, me, await readJson(request));
    if (method === 'DELETE') {
      if (me) await db.prepare('DELETE FROM people WHERE id = ?').bind(me.id).run();
      return json(200, { ok: true });
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  if (method !== 'DELETE') throw new HttpError(405, 'Method not allowed.');
  if (!isHost) throw new HttpError(403, 'Only the host can do that.');
  await db.prepare('DELETE FROM people WHERE id = ? AND event_id = ?').bind(personId, eventId).run();
  return json(200, await eventView(db, ev, true));
}

async function createEvent(db, body) {
  const title = cleanText(body.title, MAX_TITLE) || 'Hangout';

  const days = Array.isArray(body.days)
    ? [...new Set(body.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort()
    : [];
  if (!days.length) throw new HttpError(400, 'Pick at least one day.');

  const { start, end } = body;
  const validTime = (t) => Number.isInteger(t) && t >= 0 && t <= 1440 && t % SLOT_MINUTES === 0;
  if (!validTime(start) || !validTime(end) || start >= end) {
    throw new HttpError(400, 'The latest time must be after the earliest time.');
  }

  const id = randomId(6);
  const hostKey = randomId(18);
  await db
    .prepare('INSERT INTO events (id, title, days, start_min, end_min, slot, host_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, title, JSON.stringify(days), start, end, SLOT_MINUTES, hostKey, Date.now())
    .run();

  const ev = await db.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
  return json(201, { ...(await eventView(db, ev, true)), hostKey });
}

async function eventView(db, ev, isHost) {
  const view = {
    id: ev.id,
    title: ev.title,
    days: JSON.parse(ev.days),
    start: ev.start_min,
    end: ev.end_min,
    slot: ev.slot,
    isHost,
  };
  if (isHost) {
    const { results } = await db
      .prepare('SELECT * FROM people WHERE event_id = ? ORDER BY joined_at')
      .bind(ev.id)
      .all();
    view.people = results.map((p) => personView(p, false));
  }
  return view;
}

function personView(p, includeToken) {
  const view = { id: p.id, name: p.name, slots: JSON.parse(p.slots) };
  if (includeToken) view.token = p.token;
  return view;
}

async function saveMe(db, ev, me, body) {
  const total = JSON.parse(ev.days).length * ((ev.end_min - ev.start_min) / ev.slot);
  if (!Array.isArray(body.slots)) throw new HttpError(400, 'Invalid availability.');
  const slots = [...new Set(body.slots)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < total)
    .sort((a, b) => a - b);
  const now = Date.now();

  if (me) {
    await db.prepare('UPDATE people SET slots = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(slots), now, me.id).run();
    return json(200, personView({ ...me, slots: JSON.stringify(slots) }, true));
  }

  const name = cleanText(body.name, MAX_NAME);
  if (!name) throw new HttpError(400, 'Please enter your name.');
  const nameKey = name.toLowerCase();

  const taken = await db.prepare('SELECT 1 FROM people WHERE event_id = ? AND name_key = ?').bind(ev.id, nameKey).first();
  if (taken) {
    throw new HttpError(409, `"${name}" has already responded. If that's you, open the link on the device you used before — otherwise add a last initial (e.g. "${name} K").`);
  }
  const { count } = await db.prepare('SELECT COUNT(*) AS count FROM people WHERE event_id = ?').bind(ev.id).first();
  if (count >= MAX_PEOPLE) throw new HttpError(400, 'This event is full.');

  const person = {
    id: randomId(6),
    name,
    slots: JSON.stringify(slots),
    token: randomId(18),
  };
  try {
    await db
      .prepare('INSERT INTO people (id, event_id, name, name_key, slots, token, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(person.id, ev.id, name, nameKey, person.slots, person.token, now, now)
      .run();
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(409, `"${name}" has already responded. Try another name.`);
    throw err;
  }
  return json(201, personView(person, true));
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large.');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function randomId(bytes) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
