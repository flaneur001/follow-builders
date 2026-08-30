import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildOnePassPrompt,
  buildStage1Prompt,
  generateAndDeliver,
  generateDigest,
  generateTwoStageDigest,
  generateWithDeepSeek,
  parsePrepared,
  resolvePipeline,
  validateDigest
} from './generate-digest.js';
import {
  OperationalError,
  diagnosticForError,
  formatOperationalDiagnostic
} from './operational-diagnostics.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(SCRIPT_DIR, '..');
const FOOTER = 'Generated through the Follow Builders skill: https://github.com/zarazhangrui/follow-builders';

function fixture() {
  return {
    status: 'ok',
    x: [{ name: 'X Builder', tweets: [{ text: 'RAW_X_SENTINEL', url: 'https://x.com/example/status/1' }] }],
    podcasts: [{ title: 'Podcast', transcript: 'RAW_PODCAST_SENTINEL', url: 'https://example.com/podcast' }],
    blogs: [{ title: 'Blog', content: 'RAW_BLOG_SENTINEL', url: 'https://example.com/blog' }],
    prompts: {
      summarize_tweets: 'X_PROMPT_SENTINEL', summarize_podcast: 'PODCAST_PROMPT_SENTINEL',
      summarize_blogs: 'BLOG_PROMPT_SENTINEL', digest_intro: 'DIGEST_PROMPT_SENTINEL', translate: 'TRANSLATE_PROMPT_SENTINEL'
    }
  };
}

function validDigest() {
  return [
    'Personal AI Learning & Intelligence Digest — 2026-08-29', '', '## 1. Today in 3', '',
    `A grounded source item with enough explanatory text to make the validation fixture comfortably longer than three hundred characters. ${'Evidence and analysis. '.repeat(12)}`,
    '', 'https://x.com/example/status/1', '', '## Think With It', '',
    'What boundary would make this workflow safer while preserving its useful capability?', '', FOOTER
  ].join('\n');
}

function sse(data, lineEnd = '\n') { return `data: ${data}${lineEnd}${lineEnd}`; }

function requestMock({ statusCode = 200, chunks }) {
  let options;
  let writes = '';
  let calls = 0;
  const requestImpl = (requestOptions, callback) => {
    calls += 1;
    options = requestOptions;
    const request = new EventEmitter();
    request.write = value => { writes += value; };
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = statusCode;
      callback(response);
      for (const chunk of chunks) response.emit('data', Buffer.from(chunk));
      response.emit('end');
    });
    return request;
  };
  return { requestImpl, get options() { return options; }, get writes() { return writes; }, get calls() { return calls; } };
}

test('unset pipeline defaults to one-pass and makes exactly one generation call', async () => {
  assert.equal(resolvePipeline(undefined), 'one-pass');
  const calls = [];
  const result = await generateDigest(fixture(), {
    pipeline: resolvePipeline(undefined),
    generate: async prompt => { calls.push(prompt); return validDigest(); }
  });
  assert.equal(calls.length, 1);
  assert.equal(result.digest, validDigest());
  assert.match(calls[0], /RAW_X_SENTINEL|RAW_PODCAST_SENTINEL|RAW_BLOG_SENTINEL/);
});

test('explicit one-pass makes exactly one generation call', async () => {
  const calls = [];
  await generateDigest(fixture(), { pipeline: 'one-pass', generate: async prompt => { calls.push(prompt); return validDigest(); } });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /DIGEST_PROMPT_SENTINEL/);
  assert.match(calls[0], /X_PROMPT_SENTINEL/);
});

test('explicit two-stage makes four calls and Stage 2 never receives raw sources', async () => {
  const calls = [];
  const outputs = [
    'X_NOTES_SENTINEL https://x.com/example/status/1',
    'PODCAST_NOTES_SENTINEL https://example.com/podcast',
    'BLOG_NOTES_SENTINEL https://example.com/blog',
    validDigest()
  ];
  const result = await generateDigest(fixture(), {
    pipeline: 'two-stage',
    generate: async prompt => { calls.push(prompt); return outputs[calls.length - 1]; }
  });
  assert.equal(calls.length, 4);
  assert.match(calls[0], /RAW_X_SENTINEL/);
  assert.doesNotMatch(calls[0], /RAW_PODCAST_SENTINEL|RAW_BLOG_SENTINEL/);
  assert.match(calls[1], /RAW_PODCAST_SENTINEL/);
  assert.match(calls[2], /RAW_BLOG_SENTINEL/);
  assert.match(calls[3], /X_NOTES_SENTINEL|PODCAST_NOTES_SENTINEL|BLOG_NOTES_SENTINEL/);
  assert.doesNotMatch(calls[3], /RAW_X_SENTINEL|RAW_PODCAST_SENTINEL|RAW_BLOG_SENTINEL/);
  assert.equal(result.digest, validDigest());
});

test('a two-stage generation failure prevents Stage 2', async () => {
  let stage2Called = false;
  await assert.rejects(
    generateTwoStageDigest(fixture(), {
      generate: async prompt => {
        if (prompt.includes('FINALIZED_V0_2_DIGEST_INTRO_BEGIN')) stage2Called = true;
        if (prompt.includes('X_PROMPT_SENTINEL')) throw new Error('provider unavailable');
        return 'notes';
      }
    }),
    error => error.code === 'generation_failed'
  );
  assert.equal(stage2Called, false);
});

test('one-pass validation failure returns no digest for downstream delivery', async () => {
  let deliveryCalled = false;
  await assert.rejects(
    generateAndDeliver(fixture(), {
      pipeline: 'one-pass', generate: async () => 'malformed final response',
      deliver: async () => { deliveryCalled = true; }
    }),
    error => error.code === 'validation_invalid_digest'
  );
  assert.equal(deliveryCalled, false);
});

test('one-pass generation failure returns no digest for downstream delivery', async () => {
  let deliveryCalled = false;
  await assert.rejects(
    generateAndDeliver(fixture(), {
      pipeline: 'one-pass', generate: async () => { throw new Error('provider unavailable'); },
      deliver: async () => { deliveryCalled = true; }
    }),
    error => error.code === 'generation_failed'
  );
  assert.equal(deliveryCalled, false);
});

test('DeepSeek SSE succeeds only after terminal [DONE] and uses V4 Flash high thinking', async () => {
  const mock = requestMock({ chunks: [
    sse(JSON.stringify({ choices: [{ delta: { reasoning_content: 'hidden reasoning' } }] }), '\r\n'),
    sse(JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] })) + sse(JSON.stringify({ choices: [{ delta: { content: 'world' } }] })) + sse('[DONE]')
  ] });
  const result = await generateWithDeepSeek('prompt', 'test-secret', { requestImpl: mock.requestImpl, agent: false });
  assert.equal(result, 'Hello world');
  assert.equal(mock.calls, 1);
  assert.equal(mock.options.hostname, 'api.deepseek.com');
  assert.equal(mock.options.path, '/chat/completions');
  assert.equal(mock.options.headers.Authorization, 'Bearer test-secret');
  assert.deepEqual(JSON.parse(mock.writes), {
    model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'prompt' }], stream: true,
    thinking: { type: 'enabled' }, reasoning_effort: 'high'
  });
});

test('DeepSeek SSE without terminal [DONE] fails and never retries', async () => {
  const mock = requestMock({ chunks: [sse(JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }))] });
  await assert.rejects(
    generateWithDeepSeek('prompt', 'test-secret', { requestImpl: mock.requestImpl, agent: false }),
    error => error.code === 'generation_sse_incomplete'
  );
  assert.equal(mock.calls, 1);
});

test('DeepSeek SSE rejects data after terminal [DONE]', async () => {
  const mock = requestMock({ chunks: [
    sse(JSON.stringify({ choices: [{ delta: { content: 'final' } }] })) +
      sse('[DONE]') +
      sse(JSON.stringify({ choices: [{ delta: { content: 'unexpected' } }] }))
  ] });
  await assert.rejects(
    generateWithDeepSeek('prompt', 'test-secret', { requestImpl: mock.requestImpl, agent: false }),
    error => error.code === 'generation_sse_error'
  );
  assert.equal(mock.calls, 1);
});

test('DeepSeek HTTP errors expose only a safe typed category', async () => {
  const apiKey = 'test-super-secret-key';
  const mock = requestMock({ statusCode: 403, chunks: [JSON.stringify({ error: `bad key ${apiKey}` })] });
  await assert.rejects(
    generateWithDeepSeek('prompt', apiKey, { requestImpl: mock.requestImpl, agent: false }),
    error => error.code === 'generation_http' && !error.message.includes(apiKey)
  );
});

test('preparation failure maps to a fixed safe diagnostic', () => {
  assert.throws(
    () => parsePrepared('{invalid json'),
    error => formatOperationalDiagnostic(diagnosticForError(error)) === 'stage=prepare status=failure failure=failed'
  );
});

test('DeepSeek network/request failure maps to a fixed safe diagnostic', async () => {
  const requestImpl = () => {
    const request = new EventEmitter();
    request.write = () => {};
    request.end = () => queueMicrotask(() => request.emit('error', new Error('socket detail must stay private')));
    return request;
  };
  await assert.rejects(
    generateWithDeepSeek('private request body', 'private-api-key', { requestImpl, agent: false }),
    error => formatOperationalDiagnostic(diagnosticForError(error)) === 'stage=generation status=failure failure=network'
  );
});

test('incomplete SSE maps to its fixed safe diagnostic', async () => {
  const mock = requestMock({ chunks: [sse(JSON.stringify({ choices: [{ delta: { content: 'partial private output' } }] }))] });
  await assert.rejects(
    generateWithDeepSeek('prompt', 'private-api-key', { requestImpl: mock.requestImpl, agent: false }),
    error => formatOperationalDiagnostic(diagnosticForError(error)) === 'stage=generation status=failure failure=sse_incomplete'
  );
});

test('validation failure maps to its fixed safe diagnostic', async () => {
  await assert.rejects(
    generateDigest(fixture(), { pipeline: 'one-pass', generate: async () => 'private invalid model output' }),
    error => formatOperationalDiagnostic(diagnosticForError(error)) === 'stage=validation status=failure failure=invalid_digest'
  );
});

test('delivery failure and successful run have fixed classifications', () => {
  assert.equal(
    formatOperationalDiagnostic(diagnosticForError(new OperationalError('delivery_lark_request'))),
    'stage=delivery status=failure failure=lark_request'
  );
  assert.equal(
    formatOperationalDiagnostic({ dailyDigest: true, status: 'success' }),
    'daily_digest status=success'
  );
});

test('successful one-pass progress contains only fixed operational markers', async () => {
  const events = [];
  await generateDigest(fixture(), {
    pipeline: 'one-pass', generate: async () => validDigest(), onProgress: event => events.push(formatOperationalDiagnostic(event))
  });
  assert.deepEqual(events, [
    'stage=generation status=started pipeline=one_pass',
    'stage=generation status=ok pipeline=one_pass',
    'stage=validation status=started',
    'stage=validation status=ok'
  ]);
});

test('safe diagnostics never contain secrets or generated content', () => {
  const secret = 'secret-api-key-and-webhook';
  const generated = 'private partial and final digest content';
  const error = new OperationalError('generation_network', { cause: new Error(`${secret} ${generated}`) });
  const diagnostic = formatOperationalDiagnostic(diagnosticForError(error));
  assert.equal(diagnostic, 'stage=generation status=failure failure=network');
  assert.doesNotMatch(diagnostic, new RegExp(`${secret}|${generated}`));
});

test('source URL validation rejects links outside prepared sources', () => {
  assert.throws(
    () => validateDigest(validDigest().replace('https://x.com/example/status/1', 'https://outside.example/fact'), fixture()),
    /URL not present in the prepared input/
  );
});

test('finalized v0.2 editorial prompts remain byte-for-byte unchanged', async () => {
  const expected = {
    'digest-intro.md': '9f494b263848b1007e6b670d86cf204a72d828cc20e336e60771ef923f670bbc',
    'summarize-blogs.md': '24eac1810cdc286c01631165cc166e3898b6733472150f5c252f94255e7cbb32',
    'summarize-podcast.md': '002e6d65b29f14647968d92235610b88cb46fcd9d2e9c85d8973a067bcb1b19b',
    'summarize-tweets.md': '632e12016210996fb970cd9636d2051a75dcd311dc2ced7dfe8bada5e493b2f1',
    'translate.md': '423a5ff285714548b4e18e26e5c124551e800e023cc7e6a7c234f32564703a46'
  };
  for (const [filename, digest] of Object.entries(expected)) {
    const content = await readFile(join(REPO_DIR, 'prompts', 'v0.2', filename));
    assert.equal(createHash('sha256').update(content).digest('hex'), digest);
  }
});

test('obsolete cloud digest delivery workflow is removed', async () => {
  await assert.rejects(
    access(join(REPO_DIR, '.github', 'workflows', 'daily-lark-digest.yml')),
    error => error.code === 'ENOENT'
  );
});

test('Stage 1 wrapper does not impose source quotas', () => {
  const prompt = buildStage1Prompt('X', 'prompt', []);
  assert.match(prompt, /Do not impose an artificial quota/);
  assert.doesNotMatch(prompt, /equal number|same number|per source/);
});

test('one-pass prompt contains all finalized prompt roles and raw source data', () => {
  const prompt = buildOnePassPrompt(fixture());
  assert.match(prompt, /DIGEST_PROMPT_SENTINEL|TRANSLATE_PROMPT_SENTINEL|X_PROMPT_SENTINEL|PODCAST_PROMPT_SENTINEL|BLOG_PROMPT_SENTINEL/);
  assert.match(prompt, /RAW_X_SENTINEL|RAW_PODCAST_SENTINEL|RAW_BLOG_SENTINEL/);
});
