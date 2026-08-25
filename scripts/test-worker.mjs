import fs from 'fs';
import path from 'path';
import worker from '../src/worker.js';

const PUBLIC_DIR = path.join(process.cwd(), 'public');

const kvStore = new Map();
const env = {
  SCHEDULE_KV: {
    async get(key) { return kvStore.has(key) ? kvStore.get(key) : null; },
    async put(key, value) { kvStore.set(key, value); },
  },
  ADMIN_PASSWORD: 'test-password-123',
  SESSION_SECRET: 'unit-test-secret',
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      const filePath = path.join(PUBLIC_DIR, url.pathname);
      if (!fs.existsSync(filePath)) return new Response('not found', { status: 404 });
      return new Response(fs.readFileSync(filePath));
    },
  },
};

function req(pathname, opts = {}) {
  return new Request(`https://example.com${pathname}`, opts);
}

function getCookieFromResponse(res) {
  const sc = res.headers.get('set-cookie') || '';
  const m = sc.match(/admin_session=([^;]+)/);
  return m ? m[1] : null;
}

async function main() {
  let res, data;

  // 1. Public schedule endpoint should fall back to seed.json
  res = await worker.fetch(req('/api/schedule'), env);
  data = await res.json();
  console.log('1) GET /api/schedule ->', res.status, 'source=', data.source, 'people=', data.people.length);
  if (res.status !== 200 || data.source !== 'seed' || data.people.length === 0) throw new Error('FAIL 1');

  // 2. Admin status while logged out
  res = await worker.fetch(req('/api/admin/status'), env);
  data = await res.json();
  console.log('2) GET /api/admin/status (logged out) ->', data.loggedIn);
  if (data.loggedIn !== false) throw new Error('FAIL 2');

  // 3. Wrong password
  res = await worker.fetch(req('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  }), env);
  console.log('3) POST /api/admin/login wrong password ->', res.status);
  if (res.status !== 401) throw new Error('FAIL 3');

  // 4. Correct password
  res = await worker.fetch(req('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test-password-123' }),
  }), env);
  const cookie = getCookieFromResponse(res);
  console.log('4) POST /api/admin/login correct ->', res.status, 'cookie set:', !!cookie);
  if (res.status !== 200 || !cookie) throw new Error('FAIL 4');

  // 5. Admin status while logged in
  res = await worker.fetch(req('/api/admin/status', { headers: { cookie: `admin_session=${cookie}` } }), env);
  data = await res.json();
  console.log('5) GET /api/admin/status (logged in) ->', data.loggedIn, data.schedule);
  if (data.loggedIn !== true) throw new Error('FAIL 5');

  // 6. Upload without auth should fail
  res = await worker.fetch(req('/api/admin/upload', { method: 'POST', body: new FormData() }), env);
  console.log('6) POST /api/admin/upload no auth ->', res.status);
  if (res.status !== 401) throw new Error('FAIL 6');

  // 7. Upload the real xlsm with auth
  const filePath = process.argv[2];
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append('file', new File([buf], 'planning.xlsm'));
  res = await worker.fetch(req('/api/admin/upload', {
    method: 'POST',
    headers: { cookie: `admin_session=${cookie}` },
    body: fd,
  }), env);
  data = await res.json();
  console.log('7) POST /api/admin/upload with auth ->', res.status, data);
  if (res.status !== 200 || !data.ok) throw new Error('FAIL 7');

  // 8. Schedule now served from KV
  res = await worker.fetch(req('/api/schedule'), env);
  data = await res.json();
  console.log('8) GET /api/schedule after upload -> source=', data.source, 'people=', data.people.length);
  if (data.source !== 'kv') throw new Error('FAIL 8');

  // 9. Public timetable endpoint should fall back to timetable-seed.json
  res = await worker.fetch(req('/api/timetable'), env);
  data = await res.json();
  console.log('9) GET /api/timetable ->', res.status, 'source=', data.source, 'cycleDays=', data.cycleDays.length);
  if (res.status !== 200 || data.source !== 'seed' || data.cycleDays.length === 0) throw new Error('FAIL 9');

  // 10. Timetable upload without auth should fail
  res = await worker.fetch(req('/api/admin/upload-timetable', { method: 'POST', body: new FormData() }), env);
  console.log('10) POST /api/admin/upload-timetable no auth ->', res.status);
  if (res.status !== 401) throw new Error('FAIL 10');

  // 11. Upload the real timetable PDF with auth
  const pdfPath = process.argv[3];
  if (pdfPath) {
    const pdfBuf = fs.readFileSync(pdfPath);
    const ttFd = new FormData();
    ttFd.append('file', new File([pdfBuf], 'timetable.pdf'));
    res = await worker.fetch(req('/api/admin/upload-timetable', {
      method: 'POST',
      headers: { cookie: `admin_session=${cookie}` },
      body: ttFd,
    }), env);
    data = await res.json();
    console.log('11) POST /api/admin/upload-timetable with auth ->', res.status, data);
    if (res.status !== 200 || !data.ok) throw new Error('FAIL 11');

    // 12. Timetable now served from KV
    res = await worker.fetch(req('/api/timetable'), env);
    data = await res.json();
    console.log('12) GET /api/timetable after upload -> source=', data.source, 'cycleDays=', data.cycleDays.length);
    if (data.source !== 'kv') throw new Error('FAIL 12');
  } else {
    console.log('11-12) skipped (no PDF path given as 2nd arg)');
  }

  // 13. Logout clears session
  res = await worker.fetch(req('/api/admin/logout', { method: 'POST' }), env);
  const cleared = getCookieFromResponse(res);
  res = await worker.fetch(req('/api/admin/status', { headers: { cookie: `admin_session=${cleared}` } }), env);
  data = await res.json();
  console.log('13) status after logout ->', data.loggedIn);
  if (data.loggedIn !== false) throw new Error('FAIL 13');

  console.log('\nALL TESTS PASSED');
}

main().catch(e => { console.error('TEST FAILURE:', e); process.exit(1); });
