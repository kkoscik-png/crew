import * as XLSX from 'xlsx';
import { parseWorkbook } from './parse.js';

const KV_KEY = 'schedule';
const SESSION_COOKIE = 'admin_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h

// ---------- helpers ----------

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bufToHex(sig);
}

async function makeSessionToken(secret) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const sig = await hmac(secret, String(exp));
  return `${exp}.${sig}`;
}

async function verifySessionToken(secret, token) {
  if (!token) return false;
  const [expStr, sig] = token.split('.');
  if (!expStr || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmac(secret, expStr);
  return timingSafeEqual(expected, sig);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function requireAdmin(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  return verifySessionToken(env.SESSION_SECRET, token);
}

async function loadSchedule(env, request) {
  const stored = await env.SCHEDULE_KV.get(KV_KEY);
  if (stored) return { source: 'kv', model: JSON.parse(stored) };
  // Fall back to the bundled seed file shipped as a static asset.
  const seedUrl = new URL('/seed.json', request.url);
  const resp = await env.ASSETS.fetch(new Request(seedUrl));
  if (resp.ok) {
    return { source: 'seed', model: await resp.json() };
  }
  return { source: 'none', model: { people: [], generatedAt: null, sheetYear: null } };
}

// ---------- route handlers ----------

async function handleSchedule(request, env) {
  const { source, model } = await loadSchedule(env, request);
  return json({ ...model, source });
}

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, { status: 400 });
  }
  if (!env.ADMIN_PASSWORD) {
    return json({ error: 'The admin panel is not configured (ADMIN_PASSWORD is missing).' }, { status: 500 });
  }
  if (typeof body.password !== 'string' || !timingSafeEqual(body.password, env.ADMIN_PASSWORD)) {
    return json({ error: 'Incorrect password.' }, { status: 401 });
  }
  const token = await makeSessionToken(env.SESSION_SECRET);
  return json({ ok: true }, {
    headers: {
      'set-cookie': `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`,
    },
  });
}

function handleLogout() {
  return json({ ok: true }, {
    headers: { 'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` },
  });
}

async function handleAdminStatus(request, env) {
  const loggedIn = await requireAdmin(request, env);
  const { source, model } = await loadSchedule(env, request);
  return json({
    loggedIn,
    schedule: {
      source,
      generatedAt: model.generatedAt,
      sheetYear: model.sheetYear,
      peopleCount: (model.people || []).length,
    },
  });
}

async function handleUpload(request, env) {
  if (!(await requireAdmin(request, env))) {
    return json({ error: 'Login required.' }, { status: 401 });
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Could not read the uploaded file.' }, { status: 400 });
  }
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') {
    return json({ error: 'No file in the request.' }, { status: 400 });
  }
  const buf = await file.arrayBuffer();
  let model;
  try {
    const wb = XLSX.read(buf, { type: 'array' });
    model = parseWorkbook(XLSX, wb);
  } catch (e) {
    return json({ error: `Could not process the file: ${e.message}` }, { status: 400 });
  }
  if (!model.people || model.people.length === 0) {
    return json({ error: 'No people found in the Planning sheet.' }, { status: 400 });
  }
  await env.SCHEDULE_KV.put(KV_KEY, JSON.stringify(model));
  return json({
    ok: true,
    sheetYear: model.sheetYear,
    peopleCount: model.people.length,
    generatedAt: model.generatedAt,
  });
}

// ---------- entry ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/api/schedule' && request.method === 'GET') {
        return await handleSchedule(request, env);
      }
      if (pathname === '/api/admin/login' && request.method === 'POST') {
        return await handleLogin(request, env);
      }
      if (pathname === '/api/admin/logout' && request.method === 'POST') {
        return handleLogout();
      }
      if (pathname === '/api/admin/status' && request.method === 'GET') {
        return await handleAdminStatus(request, env);
      }
      if (pathname === '/api/admin/upload' && request.method === 'POST') {
        return await handleUpload(request, env);
      }
    } catch (e) {
      return json({ error: `Server error: ${e.message}` }, { status: 500 });
    }

    // Anything else under /api/* that isn't matched -> 404 JSON.
    if (pathname.startsWith('/api/')) {
      return json({ error: 'Not found.' }, { status: 404 });
    }
    // Should not normally be reached (assets are served automatically),
    // but fall back to the asset handler just in case.
    return env.ASSETS.fetch(request);
  },
};
