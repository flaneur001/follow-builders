import { writeSync } from 'node:fs';

const ERROR_DIAGNOSTICS = Object.freeze({
  environment_config: { stage: 'environment_config', failure: 'invalid' },
  prepare_failed: { stage: 'prepare', failure: 'failed' },
  generation_network: { stage: 'generation', failure: 'network' },
  generation_http: { stage: 'generation', failure: 'http' },
  generation_sse_incomplete: { stage: 'generation', failure: 'sse_incomplete' },
  generation_sse_error: { stage: 'generation', failure: 'sse_error' },
  generation_empty_output: { stage: 'generation', failure: 'empty_output' },
  generation_failed: { stage: 'generation', failure: 'failed' },
  validation_invalid_digest: { stage: 'validation', failure: 'invalid_digest' },
  delivery_lark_request: { stage: 'delivery', failure: 'lark_request' }
});

function safeToken(value) {
  const token = String(value || '');
  if (!/^[a-z0-9_]+$/.test(token)) throw new Error('Unsafe operational diagnostic token');
  return token;
}

class OperationalError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = 'OperationalError';
    this.code = code;
  }
}

function diagnosticForError(error, fallbackCode = 'generation_failed') {
  const code = error instanceof OperationalError && ERROR_DIAGNOSTICS[error.code]
    ? error.code
    : fallbackCode;
  const diagnostic = ERROR_DIAGNOSTICS[code] || ERROR_DIAGNOSTICS.generation_failed;
  return { stage: diagnostic.stage, status: 'failure', failure: diagnostic.failure };
}

function formatOperationalDiagnostic({ dailyDigest, stage, status, failure, pipeline }) {
  if (dailyDigest) return `daily_digest status=${safeToken(status)}`;
  const fields = [`stage=${safeToken(stage)}`, `status=${safeToken(status)}`];
  if (failure) fields.push(`failure=${safeToken(failure)}`);
  if (pipeline) fields.push(`pipeline=${safeToken(pipeline)}`);
  return fields.join(' ');
}

function emitOperationalDiagnostic(diagnostic, fd = Number(process.env.FOLLOW_BUILDERS_DIAGNOSTIC_FD || 2)) {
  writeSync(fd, `${formatOperationalDiagnostic(diagnostic)}\n`);
}

export {
  ERROR_DIAGNOSTICS,
  OperationalError,
  diagnosticForError,
  emitOperationalDiagnostic,
  formatOperationalDiagnostic
};
