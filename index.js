require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Multi-turn conversation history per chat_id (in-memory)
const conversations = new Map();

// Deduplicate Feishu events (Feishu may retry on timeout)
const processedEvents = new Set();

// ── Feishu API helpers ────────────────────────────────────────────────────────

async function getTenantAccessToken() {
  const { data } = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
    }
  );
  if (data.code !== 0) throw new Error(`Feishu auth error: ${data.msg}`);
  return data.tenant_access_token;
}

async function sendMessage(receiveId, receiveIdType, text) {
  const token = await getTenantAccessToken();
  await axios.post(
    'https://open.feishu.cn/open-apis/im/v1/messages',
    {
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
    {
      params: { receive_id_type: receiveIdType },
      headers: { Authorization: `Bearer ${token}` },
    }
  );
}

// ── Claude helper ─────────────────────────────────────────────────────────────

async function askClaude(chatId, userText) {
  if (!conversations.has(chatId)) {
    conversations.set(chatId, []);
  }
  const history = conversations.get(chatId);
  history.push({ role: 'user', content: userText });

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: history,
  });

  const reply = response.content.find((b) => b.type === 'text')?.text ?? '';
  history.push({ role: 'assistant', content: reply });

  // Keep history bounded to last 40 messages (20 turns) to manage tokens
  if (history.length > 40) {
    conversations.set(chatId, history.slice(-40));
  }

  return reply;
}

// ── Webhook endpoint ──────────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  const body = req.body;

  // 1. Feishu URL verification
  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  // 2. Only handle message events
  const eventType = body.header?.event_type;
  if (eventType !== 'im.message.receive_v1') {
    return res.sendStatus(200);
  }

  // 3. Deduplicate
  const eventId = body.header?.event_id;
  if (eventId) {
    if (processedEvents.has(eventId)) return res.sendStatus(200);
    processedEvents.add(eventId);
    // Clean up old event IDs after 10 minutes
    setTimeout(() => processedEvents.delete(eventId), 10 * 60 * 1000);
  }

  // 4. Respond immediately (Feishu requires a response within 3 seconds)
  res.sendStatus(200);

  const msg = body.event?.message;
  if (!msg || msg.message_type !== 'text') return;

  const chatId = msg.chat_id;
  const chatType = msg.chat_type; // 'p2p' or 'group'
  const receiveIdType = chatType === 'p2p' ? 'chat_id' : 'chat_id';

  let userText;
  try {
    userText = JSON.parse(msg.content).text?.trim();
  } catch {
    return;
  }
  if (!userText) return;

  // In group chats, only respond when @mentioned (text starts with @_user_1 or contains bot mention)
  // Feishu strips the @mention prefix automatically in some SDKs; handle both cases
  // For simplicity, respond to all messages in p2p and all @mentions in group
  // Group message content with @mention looks like: "@_user_1 hello" — just use it as-is

  try {
    const reply = await askClaude(chatId, userText);
    await sendMessage(chatId, receiveIdType, reply);
  } catch (err) {
    console.error('Error processing message:', err.message);
    try {
      await sendMessage(chatId, receiveIdType, '抱歉，处理消息时出错，请稍后再试。');
    } catch {
      // ignore send errors in error handler
    }
  }
});

// ── Start server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`feishu-claude listening on port ${PORT}`);
});
