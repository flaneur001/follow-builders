#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_USER_DIR = join(homedir(), '.follow-builders');
const DEFAULT_PRODUCTION_SCRIPT = join(SCRIPT_DIR, 'run-production-digest.sh');
const SUCCESS_FILENAME = 'daily-success.json';
const LOCK_FILENAME = 'daily-digest.lock';
const ELIGIBLE_HOUR = 8;
const COMPLETED_STATUSES = new Set(['success', 'skipped']);
const ELIGIBILITY_STATUSES = new Set([
  'before_window', 'darkwake', 'session_not_ready', 'network_not_ready',
  'already_completed', 'lock_busy', 'ready', 'guard_error'
]);

function localDate(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function emitEligibility(status, writeLine = line => process.stderr.write(`${line}\n`)) {
  if (!ELIGIBILITY_STATUSES.has(status)) throw new Error('Unsafe eligibility status');
  writeLine(`eligibility status=${status}`);
}

function emitDailySuccess(writeLine = line => process.stderr.write(`${line}\n`)) {
  writeLine('daily_digest status=success');
}

function readCompletedDate(userDir = DEFAULT_USER_DIR) {
  try {
    const state = JSON.parse(readFileSync(join(userDir, SUCCESS_FILENAME), 'utf8'));
    return COMPLETED_STATUSES.has(state.status) && /^\d{4}-\d{2}-\d{2}$/.test(state.localDate)
      ? state.localDate
      : null;
  } catch {
    return null;
  }
}

function writeSuccessMarker(date, userDir = DEFAULT_USER_DIR) {
  mkdirSync(userDir, { recursive: true, mode: 0o700 });
  const destination = join(userDir, SUCCESS_FILENAME);
  const temporary = join(userDir, `.daily-success.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ localDate: date, status: 'success' })}\n`, { mode: 0o600 });
  renameSync(temporary, destination);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireLock(userDir = DEFAULT_USER_DIR, ownerPid = process.pid, isAlive = processIsAlive) {
  mkdirSync(userDir, { recursive: true, mode: 0o700 });
  const lockDir = join(userDir, LOCK_FILENAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify({ pid: ownerPid })}\n`, { mode: 0o600 });
      return { acquired: true, lockDir, ownerPid };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')); } catch {}
      if (owner && isAlive(owner.pid)) return { acquired: false, lockDir };
      if (!owner) {
        try {
          if (Date.now() - statSync(lockDir).mtimeMs < 60_000) return { acquired: false, lockDir };
        } catch {}
      }
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
  return { acquired: false, lockDir };
}

function releaseLock(lock) {
  if (!lock?.acquired) return;
  try {
    const owner = JSON.parse(readFileSync(join(lock.lockDir, 'owner.json'), 'utf8'));
    if (owner.pid !== lock.ownerPid) return;
  } catch {
    return;
  }
  rmSync(lock.lockDir, { recursive: true, force: true });
}

function probeInteractiveSession({ execFile = execFileSync, username = userInfo().username } = {}) {
  try {
    const consoleUser = execFile('/usr/bin/stat', ['-f', '%Su', '/dev/console'], { encoding: 'utf8' }).trim();
    if (consoleUser !== username || consoleUser === 'root' || consoleUser === 'loginwindow') {
      return 'session_not_ready';
    }
    const powerRoot = execFile('/usr/sbin/ioreg', ['-r', '-n', 'IOPMrootDomain', '-d', '1'], { encoding: 'utf8' });
    if (!/"IOPMUserTriggeredFullWake"\s*=\s*Yes/.test(powerRoot)) return 'darkwake';
    const display = execFile('/usr/sbin/ioreg', ['-r', '-n', 'IODisplayWrangler', '-d', '1'], { encoding: 'utf8' });
    if (!/"DevicePowerState"\s*=\s*4/.test(display)) return 'session_not_ready';
    return 'ready';
  } catch {
    return 'session_not_ready';
  }
}

function probeNetwork({ spawn = spawnSync } = {}) {
  const result = spawn('/usr/bin/curl', [
    '--silent', '--show-error', '--head', '--output', '/dev/null',
    '--connect-timeout', '5', '--max-time', '10',
    '--proxy', 'http://127.0.0.1:9674',
    'https://api.deepseek.com/'
  ], { stdio: 'ignore', timeout: 12_000 });
  return !result.error && result.status === 0;
}

async function runScheduledDigest({
  now = new Date(), userDir = DEFAULT_USER_DIR,
  sessionProbe = probeInteractiveSession, networkProbe = probeNetwork,
  runProduction, writeLine, ownerPid = process.pid, isAlive = processIsAlive
} = {}) {
  const date = localDate(now);
  if (now.getHours() < ELIGIBLE_HOUR) {
    emitEligibility('before_window', writeLine);
    return { status: 'skipped', reason: 'before_window' };
  }
  if (readCompletedDate(userDir) === date) {
    emitEligibility('already_completed', writeLine);
    return { status: 'skipped', reason: 'already_completed' };
  }
  const sessionStatus = sessionProbe();
  if (sessionStatus !== 'ready') {
    emitEligibility(sessionStatus === 'darkwake' ? 'darkwake' : 'session_not_ready', writeLine);
    return { status: 'skipped', reason: sessionStatus };
  }

  const lock = acquireLock(userDir, ownerPid, isAlive);
  if (!lock.acquired) {
    emitEligibility('lock_busy', writeLine);
    return { status: 'skipped', reason: 'lock_busy' };
  }
  try {
    if (readCompletedDate(userDir) === date) {
      emitEligibility('already_completed', writeLine);
      return { status: 'skipped', reason: 'already_completed' };
    }
    if (!networkProbe()) {
      emitEligibility('network_not_ready', writeLine);
      return { status: 'skipped', reason: 'network_not_ready' };
    }
    emitEligibility('ready', writeLine);
    const exitCode = await runProduction();
    if (exitCode !== 0) return { status: 'failed', exitCode };
    writeSuccessMarker(date, userDir);
    emitDailySuccess(writeLine);
    return { status: 'success', exitCode: 0 };
  } finally {
    releaseLock(lock);
  }
}

async function main() {
  const result = await runScheduledDigest({
    runProduction: () => {
      const child = spawnSync('/bin/sh', [DEFAULT_PRODUCTION_SCRIPT], {
        cwd: join(SCRIPT_DIR, '..'), env: process.env, stdio: 'inherit'
      });
      return child.error ? 1 : (child.status ?? 1);
    }
  });
  process.exit(result.status === 'failed' ? result.exitCode || 1 : 0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main().catch(() => {
  emitEligibility('guard_error');
  process.exit(1);
});

export {
  acquireLock, emitDailySuccess, emitEligibility, localDate, probeInteractiveSession, probeNetwork,
  readCompletedDate, releaseLock, runScheduledDigest, writeSuccessMarker
};
