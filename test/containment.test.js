/**
 * BLAST RADIUS ZERO (BRZ-0) — 4-Pillar Containment & Autonomous Agent Verification Suite
 * Uses built-in Node.js test runner (`node --test test/containment.test.js`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { executeInEphemeralSandbox, probeDockerDaemon } = require('../src/sandboxRuntime');
const { generateAgentAction, VULTR_INFERENCE_ENDPOINT } = require('../src/vultrClient');
const {
  runMission,
  runStrike,
  resolveApprovalGate,
  DEFAULT_HOSTILE_DOM_HTML
} = require('../src/agentOrchestrator');
const { createAppServer } = require('../server');

test('Pillar 1 & 2 & 4: Ephemeral Sandbox isolates PID, scrubs host secrets, blocks path escape, and wipes ephemeral dir', async () => {
  assert.ok(process.env.HOST_MASTER_SECRET, 'Host must hold HOST_MASTER_SECRET sentinel');
  assert.ok(process.env.VULTR_INFERENCE_API_KEY, 'Host must hold VULTR_INFERENCE_API_KEY sentinel');

  const probeScript = `
    const fs = require('fs');
    let escapeBlocked = false;
    try {
      fs.readFileSync('../server.js', 'utf8');
    } catch (err) {
      escapeBlocked = err.message.includes('CONTAINMENT_INTERCEPT');
    }
    console.log(JSON.stringify({
      childPid: process.pid,
      vultrKey: process.env.VULTR_INFERENCE_API_KEY || null,
      hostSecret: process.env.HOST_MASTER_SECRET || null,
      escapeBlocked
    }));
  `;

  const result = await executeInEphemeralSandbox({
    code: probeScript,
    timeoutMs: 1500,
    missionLabel: 'unit-test:pillars-1-2-4'
  });

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.stdout);

  assert.notEqual(payload.childPid, process.pid, 'Sandbox must run in a separate OS child process');
  assert.equal(payload.escapeBlocked, true, 'Preload jail must block ../server.js traversal');
  assert.equal(result.receipt.pillarProofs.processIsolated, true);

  assert.equal(payload.vultrKey, null, 'VULTR_INFERENCE_API_KEY must be scrubbed from child env');
  assert.equal(payload.hostSecret, null, 'HOST_MASTER_SECRET must be scrubbed from child env');
  assert.equal(result.receipt.pillarProofs.secretsScrubbed, true);
  assert.equal(result.receipt.pillarProofs.hostSecretsExposedCount, 0);

  assert.equal(fs.existsSync(result.receipt.ephemeralDir), false, 'Ephemeral directory must not exist after run');
  assert.equal(result.receipt.pillarProofs.ephemeralDestroyed, true);
  assert.match(result.receipt.sha256, /^[a-f0-9]{64}$/, 'Receipt must carry valid 64-char hex SHA-256');
});

test('Deep Jail Hardening (Bugs 1, 2, 3, 7): Blocks fs.promises, worker_threads, process.binding, symlinks, URL escapes, and clamps timeoutMs', async () => {
  const bypassProbeScript = `
    const fs = require('fs');
    const fsPromises = fs.promises;
    const { pathToFileURL } = require('url');
    const path = require('path');

    (async () => {
      const checks = {};

      // 1. fs.promises.readFile('../server.js')
      try {
        await fsPromises.readFile('../server.js', 'utf8');
        checks.fsPromisesReadFile = 'ESCAPED';
      } catch (e) {
        checks.fsPromisesReadFile = e.message.includes('CONTAINMENT_INTERCEPT') ? 'BLOCKED' : 'OTHER';
      }

      // 2. fs.opendirSync('..') & fs.cpSync('..', './dump')
      try {
        fs.opendirSync('..');
        checks.opendirSync = 'ESCAPED';
      } catch (e) {
        checks.opendirSync = e.message.includes('CONTAINMENT_INTERCEPT') ? 'BLOCKED' : 'OTHER';
      }

      try {
        fs.cpSync('../package.json', './stolen.json');
        checks.cpSync = 'ESCAPED';
      } catch (e) {
        checks.cpSync = e.message.includes('CONTAINMENT_INTERCEPT') ? 'BLOCKED' : 'OTHER';
      }

      // 3. Symlink creation
      try {
        fs.symlinkSync('..', './escape-link');
        checks.symlinkSync = 'ESCAPED';
      } catch (e) {
        checks.symlinkSync = e.message.includes('SYMLINK_ESCAPE_BLOCKED') ? 'BLOCKED' : 'OTHER';
      }

      // 4. URL object path escape
      try {
        const parentUrl = pathToFileURL(path.resolve(process.cwd(), '..', 'server.js'));
        fs.readFileSync(parentUrl, 'utf8');
        checks.urlEscape = 'ESCAPED';
      } catch (e) {
        checks.urlEscape = e.message.includes('CONTAINMENT_INTERCEPT') ? 'BLOCKED' : 'OTHER';
      }

      // 5. worker_threads & child_process & net module load
      try {
        require('worker_threads');
        checks.workerThreads = 'ESCAPED';
      } catch (e) {
        checks.workerThreads = e.message.includes('FORBIDDEN_MODULE_BLOCKED') ? 'BLOCKED' : 'OTHER';
      }

      try {
        require('net');
        checks.netModule = 'ESCAPED';
      } catch (e) {
        checks.netModule = e.message.includes('FORBIDDEN_MODULE_BLOCKED') ? 'BLOCKED' : 'OTHER';
      }

      // 6. Native bindings (process.binding / _linkedBinding / dlopen)
      try {
        process.binding('fs');
        checks.processBinding = 'ESCAPED';
      } catch (e) {
        checks.processBinding = e.message.includes('NATIVE_BINDING_BLOCKED') ? 'BLOCKED' : 'OTHER';
      }

      // 7. Outbound global fetch
      try {
        await fetch('https://example.com');
        checks.globalFetch = 'ESCAPED';
      } catch (e) {
        checks.globalFetch = e.message.includes('NETWORK_EGRESS_BLOCKED') ? 'BLOCKED' : 'OTHER';
      }

      // 8. Uint8Array / TypedArray path escape (Cycle 3 second-order check)
      try {
        const rawBytes = new Uint8Array(Buffer.from('../server.js'));
        fs.readFileSync(rawBytes, 'utf8');
        checks.uint8ArrayEscape = 'ESCAPED';
      } catch (e) {
        checks.uint8ArrayEscape = e.message.includes('CONTAINMENT_INTERCEPT') ? 'BLOCKED' : 'OTHER';
      }

      // 9. Stateful toString() TOCTOU object escape
      try {
        let count = 0;
        const sneakyPath = {
          toString() {
            count++;
            return count === 1 ? './safe.txt' : '../server.js';
          }
        };
        fs.readFileSync(sneakyPath, 'utf8');
        checks.statefulObjectEscape = 'ESCAPED';
      } catch (e) {
        checks.statefulObjectEscape = e.message.includes('CONTAINMENT_INTERCEPT') ? 'BLOCKED' : 'OTHER';
      }

      console.log(JSON.stringify(checks));
    })();
  `;

  const result = await executeInEphemeralSandbox({
    code: bypassProbeScript,
    timeoutMs: 999999999, // Should clamp to 8000ms
    missionLabel: 'unit-test:deep-jail-hardening'
  });

  assert.equal(result.ok, true);
  assert.equal(result.receipt.timeoutMs, 8000, 'timeoutMs must clamp to 8000ms ceiling');

  const checks = JSON.parse(result.stdout);
  assert.equal(checks.fsPromisesReadFile, 'BLOCKED');
  assert.equal(checks.opendirSync, 'BLOCKED');
  assert.equal(checks.cpSync, 'BLOCKED');
  assert.equal(checks.symlinkSync, 'BLOCKED');
  assert.equal(checks.urlEscape, 'BLOCKED');
  assert.equal(checks.workerThreads, 'BLOCKED');
  assert.equal(checks.netModule, 'BLOCKED');
  assert.equal(checks.processBinding, 'BLOCKED');
  assert.equal(checks.globalFetch, 'BLOCKED');
  assert.equal(checks.uint8ArrayEscape, 'BLOCKED');
  assert.equal(checks.statefulObjectEscape, 'BLOCKED');
});

test('Pillar 3: Watchdog timer terminates runaway infinite loop with SIGKILL', async () => {
  const result = await executeInEphemeralSandbox({
    code: 'while (true) {}',
    timeoutMs: 350,
    missionLabel: 'unit-test:pillar-3-watchdog'
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(fs.existsSync(result.receipt.ephemeralDir), false);
});

test('Pattern A (self_heal_parser): Crashes in Sandbox #1, self-heals from stderr in Sandbox #2, and verifies output', async () => {
  const mission = await runMission({ missionType: 'self_heal_parser' });

  assert.equal(mission.status, 'SELF_HEALED_VERIFIED');
  assert.equal(mission.selfHealed, true);
  assert.equal(mission.attempts.length, 2, 'Must record Attempt 1 crash and Attempt 2 self-healed pass');

  const [attempt1, attempt2] = mission.attempts;
  assert.equal(attempt1.execution.ok, false, 'Attempt 1 must fail on corrupted telemetry row');
  assert.match(attempt1.execution.stderr, /TELEMETRY_SCHEMA_CRASH/);
  assert.equal(attempt1.receipt.pillarProofs.ephemeralDestroyed, true);

  assert.equal(attempt2.execution.ok, true, 'Attempt 2 must pass with self-healed parser');
  assert.notEqual(attempt1.receipt.runId, attempt2.receipt.runId, 'Must run in two distinct ephemeral sandboxes');
  assert.notEqual(attempt1.receipt.sha256, attempt2.receipt.sha256, 'Each sandbox run must have a unique SHA-256 receipt');
  assert.equal(mission.finalOutput.status, 'SELF_HEALED_VERIFIED');
  assert.equal(mission.finalOutput.validCount, 3);
  assert.equal(mission.finalOutput.quarantinedCount, 1);
});

test('Pattern A (custom_code — Bug 5): Executes user-supplied untrusted JS in Sandbox #1 and self-heals if Attempt 1 is intercepted', async () => {
  // 1. Clean custom code passes on Attempt 1
  const cleanCustom = await runMission({
    missionType: 'custom_code',
    customCode: 'console.log(JSON.stringify({ customExec: true, sum: 21 + 21 }));'
  });
  assert.equal(cleanCustom.status, 'VERIFIED_CLEAN_PASS');
  assert.equal(cleanCustom.attempts.length, 1);
  assert.equal(cleanCustom.finalOutput.customExec, true);
  assert.equal(cleanCustom.finalOutput.sum, 42);

  // 2. Hostile custom code in prompt is trapped in Sandbox #1 and self-healed in Sandbox #2
  const hostileCustom = await runMission({
    missionType: 'custom_code',
    prompt: 'const fs = require("fs"); fs.readFileSync("../server.js", "utf8");'
  });
  assert.equal(hostileCustom.status, 'SELF_HEALED_VERIFIED');
  assert.equal(hostileCustom.selfHealed, true);
  assert.equal(hostileCustom.attempts.length, 2);
  assert.equal(hostileCustom.attempts[0].execution.ok, false);
  assert.match(hostileCustom.attempts[0].execution.stderr, /CONTAINMENT_INTERCEPT: PATH_ESCAPE_BLOCKED/);
  assert.equal(hostileCustom.attempts[1].execution.ok, true);
});

test('Pattern B (hostile_dom_audit & Bug 4): Quarantines hidden prompt injection and enforces strict gateId & 409 double-resolution guards', async () => {
  const mission = await runMission({ missionType: 'hostile_dom_audit' });

  assert.equal(mission.pattern, 'PATTERN_B_UNTRUSTED_DOM');
  assert.equal(mission.status, 'QUARANTINED_PENDING_HUMAN_GATE');
  assert.equal(mission.promptInjectionQuarantined, true);
  assert.ok(mission.threatVectorsBlocked.length >= 2);
  assert.equal(mission.cleanInvoices.length, 2);
  assert.equal(mission.approvalGate.status, 'PENDING_APPROVAL');

  // Bogus gateId must return 404 and NOT resolve the pending gate
  const bogusLookup = resolveApprovalGate({
    gateId: 'gate-non-existent-id-999',
    decision: 'APPROVE'
  });
  assert.equal(bogusLookup.ok, false);
  assert.equal(bogusLookup.statusCode, 404);
  assert.equal(mission.approvalGate.status, 'PENDING_APPROVAL', 'Pending gate must remain untouched on bogus gateId');

  // Valid resolution
  const resolution = resolveApprovalGate({
    gateId: mission.approvalGate.gateId,
    decision: 'REJECT',
    operatorNote: 'Blocked during automated containment verification'
  });
  assert.equal(resolution.ok, true);
  assert.equal(resolution.statusCode, 200);
  assert.equal(resolution.gate.status, 'BLOCKED_AND_QUARANTINED');

  // Second resolution on same gateId must return 409 Conflict
  const duplicateResolution = resolveApprovalGate({
    gateId: mission.approvalGate.gateId,
    decision: 'APPROVE'
  });
  assert.equal(duplicateResolution.ok, false);
  assert.equal(duplicateResolution.statusCode, 409);
  assert.equal(mission.approvalGate.status, 'BLOCKED_AND_QUARANTINED', 'Resolved gate must be immutable');
});

test('Red-Team Full Gauntlet: Contained 100% across all 4 strikes with 0% Host Bleed', async () => {
  const gauntlet = await runStrike({ strikeType: 'full_gauntlet', timeoutMs: 350 });

  assert.equal(gauntlet.status, 'ALL_STRIKES_CONTAINED_ZERO_BLEED');
  assert.equal(gauntlet.allPillarsVerified, true);
  assert.equal(gauntlet.hostBleedPercent, 0);
  assert.equal(gauntlet.strikes.length, 4);

  for (const strike of gauntlet.strikes) {
    assert.equal(strike.contained, true, `Strike ${strike.strikeType} must be 100% contained`);
    assert.equal(strike.receipt.pillarProofs.ephemeralDestroyed, true);
  }
});

test('HTTP Server Endpoints & Edge Cases (Bug 6): /api/health, /api/agent/mission, /api/redteam/strike, 400/404/409/413 status codes', async () => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.pillarsEnforced.processIsolation, true);
    assert.equal(health.vultrInference.endpoint, 'https://api.vultrinference.com/v1/chat/completions');

    const missionRes = await fetch(`${baseUrl}/api/agent/mission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ missionType: 'cve_crypto_audit' })
    });
    assert.equal(missionRes.status, 200);
    const missionData = await missionRes.json();
    assert.equal(missionData.ok, true);
    assert.equal(missionData.finalOutput.status, 'AUDIT_COMPLETE');

    // Verify POST /api/agent/run alias (Fix #4)
    const runAliasRes = await fetch(`${baseUrl}/api/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ missionType: 'cve_crypto_audit' })
    });
    assert.equal(runAliasRes.status, 200);
    const runAliasData = await runAliasRes.json();
    assert.equal(runAliasData.ok, true);
    assert.equal(runAliasData.finalOutput.status, 'AUDIT_COMPLETE');

    const strikeRes = await fetch(`${baseUrl}/api/redteam/strike`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strikeType: 'exfil_secrets' })
    });
    assert.equal(strikeRes.status, 200);
    const strikeData = await strikeRes.json();
    assert.equal(strikeData.ok, true);
    assert.equal(strikeData.contained, true);
    assert.equal(strikeData.secretsLeakedCount, 0);

    // Invalid JSON -> 400
    const badJsonRes = await fetch(`${baseUrl}/api/agent/mission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json'
    });
    assert.equal(badJsonRes.status, 400);

    // Unknown strikeType -> 400
    const badStrikeRes = await fetch(`${baseUrl}/api/redteam/strike`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strikeType: 'non_existent_strike' })
    });
    assert.equal(badStrikeRes.status, 400);

    // Unknown missionType -> 400
    const badMissionRes = await fetch(`${baseUrl}/api/agent/mission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ missionType: 'non_existent_mission' })
    });
    assert.equal(badMissionRes.status, 400);

    // Oversized body (>256KB) -> 413 without ECONNRESET
    const hugeBody = JSON.stringify({ prompt: 'A'.repeat(300 * 1024) });
    const oversizedRes = await fetch(`${baseUrl}/api/agent/mission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: hugeBody
    });
    assert.equal(oversizedRes.status, 413);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Anti-Spoof Fix #1 & #3: Blocks ESM dynamic import() ChildProcess/net escapes, dns, delete process.binding, and readlinkSync', async () => {
  const esmBypassProbe = `
    const fs = require('fs');

    (async () => {
      const results = {};

      // 1. ESM dynamic import('node:child_process') + new cp.ChildProcess().spawn(...)
      try {
        const cp = await import('node:child_process');
        const p = new cp.ChildProcess();
        p.spawn({ file: process.execPath, args: [process.execPath, '-e', '1'] });
        results.esmChildProcess = 'ESCAPED';
      } catch (err) {
        results.esmChildProcess = err.message.includes('[CONTAINMENT_INTERCEPT:') ? 'BLOCKED' : ('OTHER: ' + err.message);
      }

      // 2. ESM dynamic import('node:net') + net.connect(80, '1.1.1.1')
      try {
        const net = await import('node:net');
        net.connect(80, '1.1.1.1');
        results.esmNetConnect = 'ESCAPED';
      } catch (err) {
        results.esmNetConnect = err.message.includes('[CONTAINMENT_INTERCEPT:') ? 'BLOCKED' : ('OTHER: ' + err.message);
      }

      // 3. require('dns').lookup('vultr.com', () => {})
      try {
        require('dns').lookup('vultr.com', () => {});
        results.dnsLookup = 'ESCAPED';
      } catch (err) {
        results.dnsLookup = err.message.includes('[CONTAINMENT_INTERCEPT:') ? 'BLOCKED' : ('OTHER: ' + err.message);
      }

      // 4. delete process.binding; process.binding('spawn_sync')
      try {
        try { delete process.binding; } catch {}
        process.binding('spawn_sync');
        results.deleteProcessBinding = 'ESCAPED';
      } catch (err) {
        results.deleteProcessBinding = err.message.includes('[CONTAINMENT_INTERCEPT:') ? 'BLOCKED' : ('OTHER: ' + err.message);
      }

      // 5. fs.readlinkSync('../outside')
      try {
        fs.readlinkSync('../outside');
        results.readlinkSyncEscape = 'ESCAPED';
      } catch (err) {
        results.readlinkSyncEscape = err.message.includes('[CONTAINMENT_INTERCEPT:') ? 'BLOCKED' : ('OTHER: ' + err.message);
      }

      console.log(JSON.stringify(results));
    })();
  `;

  const result = await executeInEphemeralSandbox({
    code: esmBypassProbe,
    timeoutMs: 2500,
    missionLabel: 'unit-test:esm-prototype-jail-lockdown'
  });

  assert.equal(result.ok, true);
  const checks = JSON.parse(result.stdout);
  assert.equal(checks.esmChildProcess, 'BLOCKED');
  assert.equal(checks.esmNetConnect, 'BLOCKED');
  assert.equal(checks.dnsLookup, 'BLOCKED');
  assert.equal(checks.deleteProcessBinding, 'BLOCKED');
  assert.equal(checks.readlinkSyncEscape, 'BLOCKED');

  // Verify honest runtimeMode and probeDockerDaemon() telemetry (Fix #3)
  assert.equal(result.receipt.runtimeMode, 'OS_EPHEMERAL_CHILD_JAIL');
  const dockerStatus = probeDockerDaemon();
  assert.equal(typeof dockerStatus.dockerDaemonDetected, 'boolean');
  assert.equal(dockerStatus.activeDriver, 'OS_EPHEMERAL_CHILD_JAIL');
});

test('Anti-Spoof Fix #2: Live Vultr Cloud Inference calls fetch() across all missions and attempts without short-circuiting', async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];

  globalThis.fetch = async (url, options) => {
    fetchCalls.push({
      url,
      headers: options.headers,
      body: JSON.parse(options.body)
    });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [
            {
              message: {
                content:
                  'Live Vultr model reasoning for sandbox execution.\n```javascript\nif (false) throw new TypeError("TELEMETRY_SCHEMA_CRASH");\nconsole.log(JSON.stringify({ status: "LIVE_OK" }));\n```'
              }
            }
          ]
        };
      }
    };
  };

  try {
    const testKey = 'vltr_real_test_api_key_1234567890';

    const r1 = await generateAgentAction({
      missionType: 'self_heal_parser',
      attempt: 1,
      apiKeyOverride: testKey
    });
    assert.equal(r1.mode, 'LIVE_VULTR_CLOUD_INFERENCE');
    assert.match(r1.reasoning, /Live Vultr model reasoning/);
    assert.match(r1.code, /LIVE_OK/);

    const r2 = await generateAgentAction({
      missionType: 'self_heal_parser',
      attempt: 2,
      stderrContext: 'TypeError: [TELEMETRY_SCHEMA_CRASH]',
      apiKeyOverride: testKey
    });
    assert.equal(r2.mode, 'LIVE_VULTR_CLOUD_INFERENCE');

    const r3 = await generateAgentAction({
      missionType: 'hostile_dom_audit',
      attempt: 1,
      domPayload: DEFAULT_HOSTILE_DOM_HTML,
      apiKeyOverride: testKey
    });
    assert.equal(r3.mode, 'LIVE_VULTR_CLOUD_INFERENCE');

    const r4 = await generateAgentAction({
      missionType: 'cve_crypto_audit',
      attempt: 1,
      apiKeyOverride: testKey
    });
    assert.equal(r4.mode, 'LIVE_VULTR_CLOUD_INFERENCE');

    assert.equal(fetchCalls.length, 4, 'Must genuinely invoke fetch() on all 4 missions/attempts');
    for (const call of fetchCalls) {
      assert.equal(call.url, VULTR_INFERENCE_ENDPOINT);
      assert.equal(call.headers.Authorization, `Bearer ${testKey}`);
    }

    // Verify rich payload context in user prompts
    assert.match(fetchCalls[0].body.messages[1].content, /CORRUPTED_NAN_SPIKE/);
    assert.match(fetchCalls[1].body.messages[1].content, /TELEMETRY_SCHEMA_CRASH/);
    assert.match(fetchCalls[2].body.messages[1].content, /INV-2026-901/);
    assert.match(fetchCalls[3].body.messages[1].content, /CVE-2026-VULTR-BRZ-01/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Morning-After Pipeline 04 Hardening: Blocks Node 22 process.getBuiltinModule, node:sqlite, process.report, process.loadEnvFile, v8 heap dump, WASI, glob escapes, and verifies /api/config/key live contract', async () => {
  const node22EscapeProbe = `
    const fs = require('fs');
    const fsPromises = require('fs/promises');

    (async () => {
      const results = {};

      // 1. process.getBuiltinModule('v8')
      try {
        process.getBuiltinModule('v8');
        results.getBuiltinModuleV8 = 'ESCAPED';
      } catch (e) {
        results.getBuiltinModuleV8 = e.message.includes('CONTAINMENT_INTERCEPT') ? 'BLOCKED' : 'OTHER';
      }

      // 2. fs.globSync('../*') & fs.promises.glob('../*')
      try {
        if (fs.globSync) {
          fs.globSync('../*');
          results.globSync = 'ESCAPED';
        } else {
          results.globSync = 'BLOCKED';
        }
      } catch (e) {
        results.globSync = e.message.includes('CONTAINMENT_INTERCEPT') ? 'BLOCKED' : 'OTHER';
      }

      try {
        if (fsPromises.glob) {
          for await (const _ of fsPromises.glob('../*')) {}
          results.promisesGlob = 'ESCAPED';
        } else {
          results.promisesGlob = 'BLOCKED';
        }
      } catch (e) {
        results.promisesGlob = e.message.includes('CONTAINMENT_INTERCEPT') ? 'BLOCKED' : 'OTHER';
      }

      // 3. process.report.writeReport('../leak.json')
      try {
        process.report.writeReport('../leak.json');
        results.processReport = 'ESCAPED';
      } catch (e) {
        results.processReport = e.message.includes('CONTAINMENT_INTERCEPT') ? 'BLOCKED' : 'OTHER';
      }

      // 4. process.loadEnvFile('../.env')
      try {
        process.loadEnvFile('../.env');
        results.processLoadEnvFile = 'ESCAPED';
      } catch (e) {
        results.processLoadEnvFile = e.message.includes('CONTAINMENT_INTERCEPT') ? 'BLOCKED' : 'OTHER';
      }

      // 5. ESM import('node:v8').writeHeapSnapshot('../heap.heapsnapshot')
      try {
        const v8Mod = await import('node:v8');
        v8Mod.writeHeapSnapshot('../heap.heapsnapshot');
        results.esmV8Heap = 'ESCAPED';
      } catch (e) {
        results.esmV8Heap = e.message.includes('CONTAINMENT_INTERCEPT') ? 'BLOCKED' : 'OTHER';
      }

      // 6. ESM import('node:sqlite').DatabaseSync('../escape.sqlite')
      try {
        const sqlite = await import('node:sqlite');
        new sqlite.DatabaseSync('../escape.sqlite');
        results.esmSqlite = 'ESCAPED';
      } catch (e) {
        results.esmSqlite = e.message.includes('CONTAINMENT_INTERCEPT') ? 'BLOCKED' : 'OTHER';
      }

      // 7. ESM import('node:wasi').WASI
      try {
        const wasi = await import('node:wasi');
        new wasi.WASI({ version: 'preview1', preopens: { '/': '/' } });
        results.esmWasi = 'ESCAPED';
      } catch (e) {
        results.esmWasi = e.message.includes('CONTAINMENT_INTERCEPT') ? 'BLOCKED' : 'OTHER';
      }

      // 8. ESM import('node:module').createRequire('../server.js')
      try {
        const mod = await import('node:module');
        mod.createRequire('../server.js');
        results.esmModuleCreateRequire = 'ESCAPED';
      } catch (e) {
        results.esmModuleCreateRequire = e.message.includes('CONTAINMENT_INTERCEPT') ? 'BLOCKED' : 'OTHER';
      }

      // 9. Raw unverified integer FD readFileSync(0) vs legitimate jailed fs.openSync FD
      try {
        fs.readFileSync(0, 'utf8');
        results.unverifiedFdRead = 'ESCAPED';
      } catch (e) {
        results.unverifiedFdRead = e.message.includes('UNVERIFIED_FILE_DESCRIPTOR') ? 'BLOCKED' : 'OTHER';
      }

      const validFd = fs.openSync('./fd-test.txt', 'w+');
      fs.writeFileSync(validFd, 'ok-fd');
      fs.closeSync(validFd);
      results.jailedFdRoundtrip = fs.readFileSync('./fd-test.txt', 'utf8') === 'ok-fd' ? 'OK' : 'FAIL';

      console.log(JSON.stringify(results));
    })();
  `;

  const sandboxRes = await executeInEphemeralSandbox({
    code: node22EscapeProbe,
    timeoutMs: 3000,
    missionLabel: 'unit-test:pipeline04-node22-hardening'
  });

  assert.equal(sandboxRes.ok, true);
  const checks = JSON.parse(sandboxRes.stdout);
  assert.equal(checks.getBuiltinModuleV8, 'BLOCKED');
  assert.equal(checks.globSync, 'BLOCKED');
  assert.equal(checks.promisesGlob, 'BLOCKED');
  assert.equal(checks.processReport, 'BLOCKED');
  assert.equal(checks.processLoadEnvFile, 'BLOCKED');
  assert.equal(checks.esmV8Heap, 'BLOCKED');
  assert.equal(checks.esmSqlite, 'BLOCKED');
  assert.equal(checks.esmWasi, 'BLOCKED');
  assert.equal(checks.esmModuleCreateRequire, 'BLOCKED');
  assert.equal(checks.unverifiedFdRead, 'BLOCKED');
  assert.equal(checks.jailedFdRoundtrip, 'OK');

  // Verify /api/config/key returns top-level liveKeyConfigured and updates defaultModel
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const cfgRes = await fetch(`${baseUrl}/api/config/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'vltr_live_test_key_pipeline04_9999',
        model: 'deepseek-r1'
      })
    });
    assert.equal(cfgRes.status, 200);
    const cfgData = await cfgRes.json();
    assert.equal(cfgData.ok, true);
    assert.equal(cfgData.liveKeyConfigured, true);
    assert.equal(cfgData.defaultModel, 'deepseek-r1');
    assert.equal(cfgData.vultrInference.liveKeyConfigured, true);
    assert.equal(cfgData.vultrInference.defaultModel, 'deepseek-r1');

    // Reset runtime key back to empty after test
    await fetch(`${baseUrl}/api/config/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: '',
        model: 'deepseek-v4.1-flash-1017'
      })
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Helmet 01 & 04 Cockpit UX Audit: Pre-baked v0.8 HTML panes, warm latestMission snapshot on /api/ledger, and model selector sync', async () => {
  const indexHtml = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(indexHtml, /initializing-sha256-containment-receipt/, 'HTML must not ship placeholder receipt text');
  assert.doesNotMatch(indexHtml, /rcpt-init/, 'HTML must not ship rcpt-init placeholder');
  assert.match(indexHtml, /SELF_HEALED_VERIFIED/, 'HTML must pre-bake v0.8 self-healed telemetry');
  assert.match(indexHtml, /deepseek-v4\.1-flash-1017/, 'HTML must default to live Vultr model deepseek-v4.1-flash-1017');

  const mission = await runMission({ missionType: 'cve_crypto_audit' });
  assert.equal(mission.status, 'VERIFIED_CLEAN_PASS');

  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const ledgerRes = await fetch(`${baseUrl}/api/ledger`);
    assert.equal(ledgerRes.status, 200);
    const ledgerData = await ledgerRes.json();
    assert.ok(ledgerData.latestMission, '/api/ledger must include warm latestMission snapshot for instant zero-blank-pane boot');
    assert.equal(ledgerData.latestMission.missionId, mission.missionId);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
