const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function fmtTime(minutes, opts = { hour: 'numeric', minute: '2-digit' }) {
  const d = new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60);
  return d.toLocaleTimeString([], opts);
}

function fmtHour(minutes) {
  return fmtTime(minutes, { hour: 'numeric' });
}

function fmtDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const API_BASE = window.FIXADULE_API || '';

function eventUrl(id) {
  return new URL(`event.html?id=${encodeURIComponent(id)}`, location.href).href;
}

async function api(method, url, body, headers = {}) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

const store = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
  remove(key) {
    localStorage.removeItem(key);
  },
};

const hostKeyFor = (id) => store.get(`fixadule:host:${id}`);
const saveHostKey = (id, key) => store.set(`fixadule:host:${id}`, key);

const RECENT_KEY = 'fixadule:recent';

function getRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch {
    return [];
  }
}

function rememberEvent(ev) {
  const list = getRecent().filter((e) => e.id !== ev.id);
  list.unshift({ id: ev.id, title: ev.title });
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child != null) node.append(child);
  }
  return node;
}
