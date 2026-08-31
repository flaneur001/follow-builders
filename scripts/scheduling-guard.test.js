import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  probeInteractiveSession,
  readCompletedDate,
  runScheduledDigest
} from './scheduling-guard.js';

function temporaryUserDir() {
  return mkdtempSync(join(tmpdir(), 'follow-builders-guard-test-'));
}

function options(userDir, overrides = {}) {
  return {
    now: new Date(2026, 7, 31, 9, 0, 0),
    userDir,
    sessionProbe: () => 'ready',
    networkProbe: () => true,
    writeLine: () => {},
    ...overrides
  };
}

test('DarkWake is ineligible and makes no paid or delivery call', async t => {
  const userDir = temporaryUserDir();
  t.after(() => rmSync(userDir, { recursive: true, force: true }));
  let networkCalls = 0;
  let productionCalls = 0;
  const result = await runScheduledDigest(options(userDir, {
    sessionProbe: () => 'darkwake',
    networkProbe: () => { networkCalls += 1; return true; },
    runProduction: async () => { productionCalls += 1; return 0; }
  }));
  assert.equal(result.reason, 'darkwake');
  assert.equal(networkCalls, 0);
  assert.equal(productionCalls, 0);
  assert.equal(readCompletedDate(userDir), null);
});

test('macOS full-wake signal distinguishes DarkWake without checking generated content', () => {
  const execFile = (command, args) => {
    if (command === '/usr/bin/stat') return 'jin\n';
    if (args.includes('IOPMrootDomain')) return '"IOPMUserTriggeredFullWake" = No\n';
    return '"DevicePowerState" = 4\n';
  };
  assert.equal(probeInteractiveSession({ execFile, username: 'jin' }), 'darkwake');
});

test('uncertain wake state fails closed without checking network or production', async t => {
  const userDir = temporaryUserDir();
  t.after(() => rmSync(userDir, { recursive: true, force: true }));
  const sessionProbe = () => probeInteractiveSession({
    execFile: () => { throw new Error('signal unavailable'); }, username: 'jin'
  });
  let networkCalls = 0;
  let productionCalls = 0;
  const result = await runScheduledDigest(options(userDir, {
    sessionProbe,
    networkProbe: () => { networkCalls += 1; return true; },
    runProduction: async () => { productionCalls += 1; return 0; }
  }));
  assert.equal(result.reason, 'session_not_ready');
  assert.equal(networkCalls, 0);
  assert.equal(productionCalls, 0);
});

test('network-not-ready makes no paid or delivery call and releases the lock', async t => {
  const userDir = temporaryUserDir();
  t.after(() => rmSync(userDir, { recursive: true, force: true }));
  let productionCalls = 0;
  const result = await runScheduledDigest(options(userDir, {
    networkProbe: () => false,
    runProduction: async () => { productionCalls += 1; return 0; }
  }));
  assert.equal(result.reason, 'network_not_ready');
  assert.equal(productionCalls, 0);
  assert.equal(readCompletedDate(userDir), null);
  assert.equal(statSync(userDir).isDirectory(), true);
  const later = await runScheduledDigest(options(userDir, {
    runProduction: async () => { productionCalls += 1; return 1; }
  }));
  assert.equal(later.status, 'failed');
  assert.equal(productionCalls, 1);
});

test('failed production leaves no daily success marker', async t => {
  const userDir = temporaryUserDir();
  t.after(() => rmSync(userDir, { recursive: true, force: true }));
  let generationCalls = 0;
  let deliveryCalls = 0;
  const result = await runScheduledDigest(options(userDir, {
    runProduction: async () => {
      generationCalls += 1;
      return 1;
    }
  }));
  assert.equal(result.status, 'failed');
  assert.equal(generationCalls, 1);
  assert.equal(deliveryCalls, 0);
  assert.equal(readCompletedDate(userDir), null);
});

test('successful production records minimal state and same-day trigger skips', async t => {
  const userDir = temporaryUserDir();
  t.after(() => rmSync(userDir, { recursive: true, force: true }));
  let generationCalls = 0;
  let deliveryCalls = 0;
  const lines = [];
  const first = await runScheduledDigest(options(userDir, {
    writeLine: line => lines.push(line),
    runProduction: async () => {
      generationCalls += 1;
      deliveryCalls += 1;
      return 0;
    }
  }));
  assert.equal(first.status, 'success');
  assert.equal(readCompletedDate(userDir), '2026-08-31');
  assert.deepEqual(JSON.parse(readFileSync(join(userDir, 'daily-success.json'), 'utf8')), {
    localDate: '2026-08-31', status: 'success'
  });
  assert.equal(statSync(join(userDir, 'daily-success.json')).mode & 0o777, 0o600);
  assert.ok(lines.includes('daily_digest status=success'));

  const second = await runScheduledDigest(options(userDir, {
    runProduction: async () => {
      generationCalls += 1;
      deliveryCalls += 1;
      return 0;
    }
  }));
  assert.equal(second.reason, 'already_completed');
  assert.equal(generationCalls, 1);
  assert.equal(deliveryCalls, 1);
});

test('explicitly skipped local date makes no paid or delivery call', async t => {
  const userDir = temporaryUserDir();
  t.after(() => rmSync(userDir, { recursive: true, force: true }));
  writeFileSync(join(userDir, 'daily-success.json'),
    `${JSON.stringify({ localDate: '2026-08-31', status: 'skipped' })}\n`, { mode: 0o600 });
  let generationCalls = 0;
  let deliveryCalls = 0;
  const result = await runScheduledDigest(options(userDir, {
    runProduction: async () => {
      generationCalls += 1;
      deliveryCalls += 1;
      return 0;
    }
  }));
  assert.equal(result.reason, 'already_completed');
  assert.equal(generationCalls, 0);
  assert.equal(deliveryCalls, 0);
});

test('explicit skip from previous local date does not block today', async t => {
  const userDir = temporaryUserDir();
  t.after(() => rmSync(userDir, { recursive: true, force: true }));
  writeFileSync(join(userDir, 'daily-success.json'),
    `${JSON.stringify({ localDate: '2026-08-30', status: 'skipped' })}\n`, { mode: 0o600 });
  let generationCalls = 0;
  let deliveryCalls = 0;
  const result = await runScheduledDigest(options(userDir, {
    runProduction: async () => {
      generationCalls += 1;
      deliveryCalls += 1;
      return 0;
    }
  }));
  assert.equal(result.status, 'success');
  assert.equal(generationCalls, 1);
  assert.equal(deliveryCalls, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(userDir, 'daily-success.json'), 'utf8')), {
    localDate: '2026-08-31', status: 'success'
  });
});

test('next local day is eligible again', async t => {
  const userDir = temporaryUserDir();
  t.after(() => rmSync(userDir, { recursive: true, force: true }));
  let productionCalls = 0;
  const runProduction = async () => { productionCalls += 1; return 0; };
  await runScheduledDigest(options(userDir, { runProduction }));
  const next = await runScheduledDigest(options(userDir, {
    now: new Date(2026, 8, 1, 9, 0, 0), runProduction
  }));
  assert.equal(next.status, 'success');
  assert.equal(productionCalls, 2);
  assert.equal(readCompletedDate(userDir), '2026-09-01');
});

test('concurrent trigger observes lock_busy and only one production run proceeds', async t => {
  const userDir = temporaryUserDir();
  t.after(() => rmSync(userDir, { recursive: true, force: true }));
  let productionCalls = 0;
  let releaseFirst;
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const gate = new Promise(resolve => { releaseFirst = resolve; });

  const firstPromise = runScheduledDigest(options(userDir, {
    runProduction: async () => {
      productionCalls += 1;
      notifyStarted();
      await gate;
      return 0;
    }
  }));
  await started;
  const second = await runScheduledDigest(options(userDir, {
    runProduction: async () => { productionCalls += 1; return 0; }
  }));
  assert.equal(second.reason, 'lock_busy');
  releaseFirst();
  const first = await firstPromise;
  assert.equal(first.status, 'success');
  assert.equal(productionCalls, 1);
});
