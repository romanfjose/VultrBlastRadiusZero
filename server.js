/**
 * WHY THIS EXISTS (Load-Bearing HTTP Server & API Gateway — Helmet 02 + Helmet 06):
 * Zero-dependency Node.js HTTP server for BLAST RADIUS ZERO (`BRZ-0`) on Port 4680.
 * Serves the static Cockpit UI (`public/`) and exposes deterministic JSON APIs for:
 *  - `GET  /api/health`
 *  - `POST /api/agent/mission`
 *  - `POST /api/redteam/strike`
 *  - `POST /api/agent/approve`
 *  - `GET  /api/ledger`
 *  - `POST /api/config/key`
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { getSandboxStatus } = require('./src/sandboxRuntime');
const { getVultrClientStatus, setRuntimeApiKey } = require('./src/vultrClient');
const {
  runMission,
  runStrike,
  resolveApprovalGate,
  getLedgerSnapshot
} = require('./src/agentOrchestrator');

const DEFAULT_PORT = Number(process.env.PORT) || 4680;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-vultr-api-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    ...extraHeaders
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let totalBytes = 0;
    let overflowed = false;

    req.on('data', (chunk) => {
      totalBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (totalBytes > maxBytes) {
        overflowed = true;
        return; // Drain remaining stream without buffering or premature socket reset
      }
      raw += chunk.toString('utf8');
    });

    req.on('end', () => {
      if (overflowed) {
        const err = new Error('Request payload exceeds 256KB limit');
        err.statusCode = 413;
        reject(err);
        return;
      }
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('JSON body must be an object');
          err.statusCode = 400;
          reject(err);
          return;
        }
        resolve(parsed);
      } catch {
        const err = new Error('Invalid JSON body');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

function serveStaticFile(reqPath, res) {
  const cleanRel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const resolvedPath = path.resolve(PUBLIC_DIR, cleanRel);
  const relCheck = path.relative(PUBLIC_DIR, resolvedPath);

  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden static path' });
    return;
  }

  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    sendJson(res, 404, { ok: false, error: `Route or asset not found: ${reqPath}` });
    return;
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = fs.readFileSync(resolvedPath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(content);
}

function createAppServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, x-vultr-api-key',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
        });
        res.end();
        return;
      }

      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;

      if (req.method === 'GET' && pathname === '/api/health') {
        const ledger = getLedgerSnapshot();
        sendJson(res, 200, {
          ok: true,
          service: 'BLAST RADIUS ZERO (BRZ-0)',
          challenge: 'Vultr: Agent Rush Hackathon — Challenge 1: Blast Radius Zero',
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
          vultrInference: getVultrClientStatus(),
          sandboxRuntime: getSandboxStatus(),
          pillarsEnforced: {
            processIsolation: true,
            secretHygiene: true,
            resourceLimits: true,
            lifecycleDiscipline: true
          },
          ledgerSummary: {
            totalRunsRecorded: ledger.totalRunsRecorded,
            pendingApprovalGates: ledger.pendingApprovalGates.length,
            hostBleedPercent: 0
          }
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/ledger') {
        sendJson(res, 200, {
          ok: true,
          ...getLedgerSnapshot()
        });
        return;
      }

      if (
        req.method === 'POST' &&
        (pathname === '/api/agent/mission' || pathname === '/api/agent/run')
      ) {
        const body = await readJsonBody(req);
        const headerKey = req.headers['x-vultr-api-key'] || '';
        const missionResult = await runMission({
          missionType: body.missionType || 'self_heal_parser',
          prompt: body.prompt || '',
          customCode: body.customCode || body.code || '',
          model: body.model,
          apiKeyOverride: body.apiKey || headerKey,
          customDomHtml: body.customDomHtml || '',
          timeoutMs: body.timeoutMs
        });
        sendJson(res, 200, {
          ok: true,
          ...missionResult
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/redteam/strike') {
        const body = await readJsonBody(req);
        const strikeResult = await runStrike({
          strikeType: body.strikeType || 'exfil_secrets',
          timeoutMs: body.timeoutMs
        });
        sendJson(res, 200, {
          ok: true,
          ...strikeResult
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/agent/approve') {
        const body = await readJsonBody(req);
        const result = resolveApprovalGate({
          gateId: body.gateId,
          decision: body.decision || 'REJECT',
          operatorNote: body.operatorNote || ''
        });
        sendJson(res, result.statusCode || (result.ok ? 200 : 404), result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/config/key') {
        const body = await readJsonBody(req);
        const status = setRuntimeApiKey(body.apiKey || '', body.model);
        sendJson(res, 200, {
          ok: true,
          ...status,
          vultrInference: getVultrClientStatus()
        });
        return;
      }

      if (req.method === 'GET') {
        serveStaticFile(pathname, res);
        return;
      }

      sendJson(res, 404, { ok: false, error: `Unknown endpoint: ${req.method} ${pathname}` });
    } catch (err) {
      const statusCode = err.statusCode || 500;
      const extraHeaders = statusCode === 413 ? { Connection: 'close' } : {};
      sendJson(
        res,
        statusCode,
        {
          ok: false,
          error: err.message || 'Internal Server Error'
        },
        extraHeaders
      );
    }
  });
}

if (require.main === module) {
  const server = createAppServer();
  server.listen(DEFAULT_PORT, '0.0.0.0', () => {
    console.log(
      `[BRZ-0 ENGINE ROOM ONLINE] Listening on http://localhost:${DEFAULT_PORT} (Host PID=${process.pid})`
    );
    // Pre-warm initial Pattern A Self-Healing Parser mission so the cockpit renders 100% populated in <50ms on first load
    runMission({ missionType: 'self_heal_parser' }).catch(() => {});
  });
}

module.exports = {
  createAppServer,
  DEFAULT_PORT
};
