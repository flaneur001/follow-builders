#!/usr/bin/env node

// ============================================================================
// Follow Builders — Delivery Script
// ============================================================================
// Sends a digest to the user via their chosen delivery method.
// Supports: Telegram bot, Email (via Resend), Lark custom bot, or stdout (default).
//
// Usage:
//   echo "digest text" | node deliver.js
//   node deliver.js --message "digest text"
//   node deliver.js --file /path/to/digest.txt
//
// The script reads delivery config from ~/.follow-builders/config.json
// and API keys from ~/.follow-builders/.env
//
// Delivery methods:
//   - "telegram": sends via Telegram Bot API (needs TELEGRAM_BOT_TOKEN + chat ID)
//   - "email": sends via Resend API (needs RESEND_API_KEY + email address)
//   - "lark": sends via a Lark custom bot (needs LARK_WEBHOOK_URL)
//   - "stdout" (default): just prints to terminal
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config as loadEnv } from 'dotenv';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const ENV_PATH = join(USER_DIR, '.env');

// -- Read input --------------------------------------------------------------

// The digest text can come from stdin, --message flag, or --file flag
async function getDigestText() {
  const args = process.argv.slice(2);

  // Check --message flag
  const msgIdx = args.indexOf('--message');
  if (msgIdx !== -1 && args[msgIdx + 1]) {
    return args[msgIdx + 1];
  }

  // Check --file flag
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    return await readFile(args[fileIdx + 1], 'utf-8');
  }

  // Read from stdin
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// -- Telegram Delivery -------------------------------------------------------

// Sends the digest via Telegram Bot API.
// The user creates a bot via @BotFather and provides the token.
// The chat ID is obtained when the user sends their first message to the bot.
async function sendTelegram(text, botToken, chatId) {
  // Telegram has a 4096 character limit per message.
  // If the digest is longer, we split it into chunks.
  const MAX_LEN = 4000;
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  for (const chunk of chunks) {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      }
    );

    if (!res.ok) {
      const err = await res.json();
      // If Markdown parsing fails, retry without parse_mode
      if (err.description && err.description.includes("can't parse")) {
        await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: chunk,
              disable_web_page_preview: true
            })
          }
        );
      } else {
        throw new Error(`Telegram API error: ${err.description}`);
      }
    }

    // Small delay between chunks to avoid rate limiting
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

// -- Email Delivery (Resend) -------------------------------------------------

// Sends the digest via Resend's email API.
// The user provides their own Resend API key and email address.
async function sendEmail(text, apiKey, toEmail) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: 'AI Builders Digest <digest@resend.dev>',
      to: [toEmail],
      subject: `AI Builders Digest — ${new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      })}`,
      text: text
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Resend API error: ${err.message || JSON.stringify(err)}`);
  }
}

// -- Lark Delivery ----------------------------------------------------------

// Lark custom bot webhook request bodies must not exceed 20 KB. Keep a small
// margin and measure the complete serialized payload so multi-byte text is safe.
const LARK_MAX_REQUEST_BYTES = 19 * 1024;

function createLarkPayload(text) {
  return {
    msg_type: 'text',
    content: { text }
  };
}

function larkPayloadSize(text) {
  return Buffer.byteLength(JSON.stringify(createLarkPayload(text)), 'utf-8');
}

function splitLarkText(text) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (larkPayloadSize(remaining) <= LARK_MAX_REQUEST_BYTES) {
      chunks.push(remaining);
      break;
    }

    const characters = Array.from(remaining);
    let low = 1;
    let high = characters.length;
    let best = 0;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = characters.slice(0, middle).join('');
      if (larkPayloadSize(candidate) <= LARK_MAX_REQUEST_BYTES) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (best === 0) {
      throw new Error('Unable to split digest within the Lark message limit');
    }

    const candidate = characters.slice(0, best).join('');
    const minimumReadableSplit = Math.floor(candidate.length / 2);
    let splitAt = candidate.lastIndexOf('\n\n') + 2;
    if (splitAt < minimumReadableSplit) splitAt = candidate.lastIndexOf('\n') + 1;
    if (splitAt < minimumReadableSplit) splitAt = candidate.lastIndexOf(' ') + 1;
    if (splitAt < minimumReadableSplit) splitAt = candidate.length;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

async function sendLark(text, webhookUrl) {
  const chunks = splitLarkText(text);

  for (const chunk of chunks) {
    let res;
    try {
      res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createLarkPayload(chunk))
      });
    } catch {
      throw new Error('Lark webhook request failed (network error)');
    }

    if (!res.ok) {
      throw new Error(`Lark webhook request failed (HTTP ${res.status})`);
    }

    let result;
    try {
      result = await res.json();
    } catch {
      throw new Error('Lark webhook returned an invalid response');
    }

    const code = result.code ?? result.StatusCode;
    if (code !== 0) {
      const safeCode = /^-?\d+$/.test(String(code)) ? code : 'unknown';
      throw new Error(`Lark webhook rejected the message (code ${safeCode})`);
    }

    // Small delay keeps sequential chunks below Lark's per-second rate limit.
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 250));
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  // Load env and config
  loadEnv({ path: ENV_PATH });

  let config = {};
  if (existsSync(CONFIG_PATH)) {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  }

  const delivery = config.delivery || { method: 'stdout' };
  const digestText = await getDigestText();

  if (!digestText || digestText.trim().length === 0) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'Empty digest text' }));
    return;
  }

  try {
    switch (delivery.method) {
      case 'telegram': {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = delivery.chatId;
        if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN not found in .env');
        if (!chatId) throw new Error('delivery.chatId not found in config.json');
        await sendTelegram(digestText, botToken, chatId);
        console.log(JSON.stringify({
          status: 'ok',
          method: 'telegram',
          message: 'Digest sent to Telegram'
        }));
        break;
      }

      case 'email': {
        const apiKey = process.env.RESEND_API_KEY;
        const toEmail = delivery.email;
        if (!apiKey) throw new Error('RESEND_API_KEY not found in .env');
        if (!toEmail) throw new Error('delivery.email not found in config.json');
        await sendEmail(digestText, apiKey, toEmail);
        console.log(JSON.stringify({
          status: 'ok',
          method: 'email',
          message: `Digest sent to ${toEmail}`
        }));
        break;
      }

      case 'lark': {
        const webhookUrl = process.env.LARK_WEBHOOK_URL;
        if (!webhookUrl) throw new Error('LARK_WEBHOOK_URL not found in .env');
        await sendLark(digestText, webhookUrl);
        console.log(JSON.stringify({
          status: 'ok',
          method: 'lark',
          message: 'Digest sent to Lark'
        }));
        break;
      }

      case 'stdout':
      default:
        // Just print to terminal — the agent or OpenClaw handles delivery
        console.log(digestText);
        break;
    }
  } catch (err) {
    console.log(JSON.stringify({
      status: 'error',
      method: delivery.method,
      message: err.message
    }));
    process.exit(1);
  }
}

main();
