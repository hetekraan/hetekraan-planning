/**
 * Lokale dev-server vanaf repo-root:
 * - /app/*, /styles/*, /icons/*, /manifest.webmanifest → public/
 * - /index.html (en /) → root index.html
 * - POST /api/ghl?action=auth → zelfde logica als api/ghl (session + HK_USERS), zodat login werkt zonder Vercel CLI
 * - overige /api/ghl → 503 (gebruik npm run dev:vercel voor getAppointments e.d.)
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const publicRoot = path.join(repoRoot, 'public');
const PORT = Number(process.env.PORT) || 3000;
const LISTEN_HOST = '0.0.0.0';

/** @returns {string[] | null} addresses, empty if none, null if enumeration failed */
function lanIpv4Addresses() {
  try {
    const out = [];
    for (const nets of Object.values(os.networkInterfaces())) {
      if (!nets) continue;
      for (const net of nets) {
        const fam = net.family;
        if ((fam === 'IPv4' || fam === 4) && !net.internal) out.push(net.address);
      }
    }
    return out;
  } catch {
    return null;
  }
}

function loadEnvFromRepo(root) {
  for (const name of ['.env.local', '.env']) {
    const fp = path.join(root, name);
    if (!fs.existsSync(fp)) continue;
    const text = fs.readFileSync(fp, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  }
}

loadEnvFromRepo(repoRoot);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function resolveUnder(baseDir, urlPath) {
  const rel = String(urlPath || '')
    .replace(/^\//, '')
    .split('/')
    .filter((p) => p && p !== '.')
    .join(path.sep);
  const full = path.resolve(baseDir, rel);
  const baseResolved = path.resolve(baseDir);
  if (full !== baseResolved && !full.startsWith(baseResolved + path.sep)) return null;
  return full;
}

function readReqBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

async function tryHandleApiGhl(req, res) {
  const u = new URL(req.url || '/', 'http://127.0.0.1');
  if (u.pathname !== '/api/ghl') return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-HK-Auth',
    });
    res.end();
    return true;
  }

  const action = u.searchParams.get('action') || '';

  if (req.method === 'POST' && action === 'auth') {
    const trace = process.env.HK_TRACE_AUTH === '1';
    let body = {};
    try {
      const raw = await readReqBody(req);
      body = JSON.parse(raw || '{}');
    } catch (_) {}
    const usr = String(body.user || '').trim().toLowerCase();
    const pwd = String(body.password || '');
    if (trace) console.log('[AUTH_TRACE][request]', { user: usr, hasPassword: !!pwd });

    await new Promise((r) => setTimeout(r, 300));

    const { signSessionToken, parseUsers } = await import(
      pathToFileURL(path.join(repoRoot, 'lib', 'session.js')).href
    );
    const { formatYyyyMmDdInAmsterdam } = await import(
      pathToFileURL(path.join(repoRoot, 'lib', 'amsterdam-calendar-day.js')).href
    );

    const users = parseUsers();
    if (trace) {
      console.log('[AUTH_TRACE][env_present]', {
        hasSessionSecret: !!process.env.SESSION_SECRET,
        hkUsersLen: String(process.env.HK_USERS || '').length,
        userKeys: Object.keys(users),
      });
    }

    if (!usr || !users[usr] || users[usr] !== pwd) {
      if (trace) console.log('[AUTH_TRACE][fail]', { reason: 'bad_credentials' });
      json(res, 401, { error: 'Gebruikersnaam of wachtwoord onjuist' });
      return true;
    }
    const token = signSessionToken(usr);
    const day = formatYyyyMmDdInAmsterdam(new Date()) || '';
    if (trace) console.log('[AUTH_TRACE][success]', { user: usr, tokenLen: token?.length || 0 });
    json(res, 200, { token, user: usr, day });
    return true;
  }

  json(res, 503, {
    error:
      'Lokaal (npm run dev) ondersteunt alleen login (POST action=auth). Voor planner-API: npm run dev:vercel',
  });
  return true;
}

async function handleRequest(req, res) {
  if (await tryHandleApiGhl(req, res)) return;

  const u = new URL(req.url || '/', 'http://127.0.0.1');
  let pathname = decodeURIComponent(u.pathname);
  if (pathname === '/') pathname = '/index.html';

  let filePath = null;
  if (
    pathname.startsWith('/app/') ||
    pathname.startsWith('/styles/') ||
    pathname.startsWith('/icons/') ||
    pathname === '/manifest.webmanifest'
  ) {
    filePath = resolveUnder(publicRoot, pathname);
  } else if (pathname === '/index.html') {
    filePath = path.join(repoRoot, 'index.html');
  }

  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Not found: ${pathname}`);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store, max-age=0',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch((e) => {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(e?.message || e));
  });
});

server.listen(PORT, LISTEN_HOST, () => {
  const baseNote =
    '(root index + public assets + POST /api/ghl?action=auth)';
  console.log(`[dev-static] Listening on ${LISTEN_HOST}:${PORT} ${baseNote}`);
  console.log(`[dev-static] Local:   http://localhost:${PORT}/`);
  const lan = lanIpv4Addresses();
  if (lan === null) {
    console.log(
      `[dev-static] On LAN: (could not detect IP — listening on ${LISTEN_HOST}; open http://<this-machine-ip>:${PORT}/ on your iPad)`
    );
  } else if (lan.length) {
    for (const ip of lan) {
      console.log(`[dev-static] On LAN: http://${ip}:${PORT}/`);
    }
  } else {
    console.log(
      `[dev-static] On LAN: (no non-loopback IPv4 found — use http://<this-machine-ip>:${PORT}/)`
    );
  }
  console.log(`[dev-static] Zet HK_USERS + SESSION_SECRET in .env.local — volledige API: npm run dev:vercel`);
});
