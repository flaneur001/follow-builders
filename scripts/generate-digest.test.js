import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildStage1Prompt,
  generateWithGemini,
  generateTwoStageDigest,
  validateDigest
} from './generate-digest.js';

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
      summarize_tweets: 'X_PROMPT_SENTINEL',
      summarize_podcast: 'PODCAST_PROMPT_SENTINEL',
      summarize_blogs: 'BLOG_PROMPT_SENTINEL',
      digest_intro: 'DIGEST_PROMPT_SENTINEL',
      translate: 'TRANSLATE_PROMPT_SENTINEL'
    }
  };
}

function validDigest() {
  return [
    'Personal AI Learning & Intelligence Digest — 2026-08-29',
    '',
    '## 1. Today in 3',
    '',
    `A grounded source item with enough explanatory text to make the validation fixture comfortably longer than three hundred characters. ${'Evidence and analysis. '.repeat(12)}`,
    '',
    'https://x.com/example/status/1',
    '',
    '## Think With It',
    '',
    'What boundary would make this workflow safer while preserving its useful capability?',
    '',
    FOOTER
  ].join('\n');
}

test('runs three source-specific calls before a notes-only Stage 2 call', async () => {
  const prepared = fixture();
  const calls = [];
  const outputs = [
    'X_NOTES_SENTINEL https://x.com/example/status/1',
    'PODCAST_NOTES_SENTINEL https://example.com/podcast',
    'BLOG_NOTES_SENTINEL https://example.com/blog',
    validDigest()
  ];
  const result = await generateTwoStageDigest(prepared, {
    generate: async prompt => {
      calls.push(prompt);
      return outputs[calls.length - 1];
    }
  });

  assert.equal(calls.length, 4);
  assert.match(calls[0], /X_PROMPT_SENTINEL/);
  assert.match(calls[0], /RAW_X_SENTINEL/);
  assert.doesNotMatch(calls[0], /RAW_PODCAST_SENTINEL|RAW_BLOG_SENTINEL/);
  assert.match(calls[1], /PODCAST_PROMPT_SENTINEL/);
  assert.match(calls[1], /RAW_PODCAST_SENTINEL/);
  assert.doesNotMatch(calls[1], /RAW_X_SENTINEL|RAW_BLOG_SENTINEL/);
  assert.match(calls[2], /BLOG_PROMPT_SENTINEL/);
  assert.match(calls[2], /RAW_BLOG_SENTINEL/);
  assert.doesNotMatch(calls[2], /RAW_X_SENTINEL|RAW_PODCAST_SENTINEL/);

  const stage2 = calls[3];
  assert.match(stage2, /DIGEST_PROMPT_SENTINEL/);
  assert.match(stage2, /TRANSLATE_PROMPT_SENTINEL/);
  assert.match(stage2, /X_NOTES_SENTINEL/);
  assert.match(stage2, /PODCAST_NOTES_SENTINEL/);
  assert.match(stage2, /BLOG_NOTES_SENTINEL/);
  assert.doesNotMatch(stage2, /RAW_X_SENTINEL|RAW_PODCAST_SENTINEL|RAW_BLOG_SENTINEL/);
  assert.doesNotMatch(stage2, /X_PROMPT_SENTINEL|PODCAST_PROMPT_SENTINEL|BLOG_PROMPT_SENTINEL/);
  assert.equal(result.digest, validDigest());
});

for (const failedStage of ['X', 'podcast', 'blogs']) {
  test(`a ${failedStage} Stage 1 failure prevents Stage 2`, async () => {
    const prepared = fixture();
    let stage2Called = false;
    await assert.rejects(
      generateTwoStageDigest(prepared, {
        generate: async prompt => {
          if (prompt.includes('FINALIZED_V0_2_DIGEST_INTRO_BEGIN')) stage2Called = true;
          if (prompt.includes(`${failedStage === 'X' ? 'X' : failedStage === 'podcast' ? 'PODCAST' : 'BLOG'}_PROMPT_SENTINEL`)) {
            throw new Error('provider unavailable');
          }
          return 'notes';
        }
      }),
      /Stage 1 .* generation failed: provider unavailable/
    );
    assert.equal(stage2Called, false);
  });
}

test('a Stage 2 failure prevents a validated digest', async () => {
  const prepared = fixture();
  await assert.rejects(
    generateTwoStageDigest(prepared, {
      generate: async prompt => {
        if (prompt.includes('FINALIZED_V0_2_DIGEST_INTRO_BEGIN')) {
          throw new Error('provider unavailable');
        }
        return 'notes';
      }
    }),
    /Stage 2 generation failed: provider unavailable/
  );
});

test('a Stage 2 validation failure is identified and prevents output', async () => {
  const prepared = fixture();
  await assert.rejects(
    generateTwoStageDigest(prepared, {
      generate: async prompt => prompt.includes('FINALIZED_V0_2_DIGEST_INTRO_BEGIN')
        ? 'malformed final response'
        : 'notes'
    }),
    /Stage 2 validation failed: Generated digest is unexpectedly short/
  );
});

test('source URL validation rejects links outside the prepared sources', () => {
  const prepared = fixture();
  assert.throws(
    () => validateDigest(validDigest().replace('https://x.com/example/status/1', 'https://outside.example/fact'), prepared),
    /URL not present in the prepared input/
  );
});

test('Gemini provider is stateless, high-thinking, and redacts its API key from errors', async () => {
  const apiKey = 'test-super-secret-key';
  let request;
  const fetchImpl = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: `bad key ${apiKey}` } })
    };
  };

  await assert.rejects(
    generateWithGemini('prompt', apiKey, fetchImpl),
    error => !error.message.includes(apiKey) && error.message.includes('[redacted]')
  );
  assert.equal(request.model, 'gemini-3.7-flash');
  assert.equal(request.store, false);
  assert.equal(request.generation_config.thinking_level, 'high');
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

test('workflow uses cloud secrets and sends only the validated final digest to Lark', async () => {
  const workflow = await readFile(join(REPO_DIR, '.github', 'workflows', 'daily-lark-digest.yml'), 'utf8');
  assert.match(workflow, /GEMINI_API_KEY: \$\{\{ secrets\.GEMINI_API_KEY \}\}/);
  assert.match(workflow, /FOLLOW_BUILDERS_STAGE1_DIR: \$\{\{ runner\.temp \}\}\/follow-builders-stage1/);
  assert.match(workflow, /generate-digest\.js > "\$RUNNER_TEMP\/follow-builders-digest\.txt"/);
  assert.match(workflow, /- name: Deliver digest to Lark\n\s+if: success\(\)[\s\S]*deliver\.js --file "\$RUNNER_TEMP\/follow-builders-digest\.txt"/);
  assert.doesNotMatch(workflow, /\/Users\/|\/private\/tmp\/|codex exec|GITHUB_TOKEN/);
  assert.ok(workflow.indexOf('generate-digest.js') < workflow.indexOf('deliver.js'));
});

test('Stage 1 wrapper does not impose source quotas', () => {
  const prompt = buildStage1Prompt('X', 'prompt', []);
  assert.match(prompt, /Do not impose an artificial quota/);
  assert.doesNotMatch(prompt, /equal number|same number|per source/);
});
