// WhatsApp bridge: QR login + forward messages to Apps Script (Google Sheet)
const { Client, LocalAuth } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');
const QRCode = require('qrcode');
const express = require('express');
const axios = require('axios');

const PORT = process.env.PORT || 3000;
const BRIDGE_KEY = process.env.BRIDGE_KEY; // same secret as Script Property BRIDGE_KEY
const GAS_URL = process.env.GAS_URL;       // Apps Script web app /exec URL

if (!BRIDGE_KEY || !GAS_URL) {
  console.error('BRIDGE_KEY ar GAS_URL environment variable set korte hobe.');
  process.exit(1);
}

let state = { status: 'starting', qr: null };
let initializePromise = null;
let reconnectTimer = null;
let reconnectAfterInitialization = false;
let reconnectDelay = 5000;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  userAgent: false,
  puppeteer: {
    executablePath: puppeteer.executablePath(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ],
  },
});

function scheduleReconnect(delay = reconnectDelay) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    initializeClient();
  }, delay);
}

function initializeClient() {
  if (initializePromise) {
    reconnectAfterInitialization = true;
    return initializePromise;
  }

  initializePromise = client.initialize()
    .catch(async (error) => {
      console.error('WhatsApp initialization failed:', error);
      state = { status: 'disconnected', qr: null };
      try {
        await client.destroy();
      } catch (cleanupError) {
        console.error('WhatsApp cleanup failed:', cleanupError);
      }
      scheduleReconnect(reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    })
    .finally(() => {
      initializePromise = null;
      if (reconnectAfterInitialization && state.status === 'disconnected') {
        scheduleReconnect(1000);
      }
      reconnectAfterInitialization = false;
    });

  return initializePromise;
}

client.on('qr', async (qr) => {
  state = { status: 'qr', qr: await QRCode.toDataURL(qr, { margin: 1, width: 300 }) };
});
client.on('authenticated', () => { state = { status: 'authenticating', qr: null }; });
client.on('auth_failure', (m) => { console.error('auth_failure', m); state = { status: 'disconnected', qr: null }; });
client.on('ready', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectDelay = 5000;
  state = { status: 'ready', qr: null };
  console.log('WhatsApp ready');
});
client.on('disconnected', (reason) => {
  console.log('disconnected', reason);
  state = { status: 'disconnected', qr: null };
  scheduleReconnect();
});

// Fires for both incoming and outgoing messages
client.on('message_create', async (msg) => {
  try {
    if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return;
    const chatId = msg.fromMe ? msg.to : msg.from;
    let name = chatId.split('@')[0];
    try {
      const chat = await msg.getChat();
      name = chat.name || name;
    } catch (e) { /* ignore */ }

    await axios.post(
      GAS_URL,
      {
        key: BRIDGE_KEY,
        type: 'message',
        id: msg.id._serialized,
        chatId,
        name,
        fromMe: !!msg.fromMe,
        body: msg.body || (msg.hasMedia ? '[media]' : ''),
        ts: msg.timestamp,
      },
      { timeout: 30000, maxRedirects: 5 }
    );
  } catch (e) {
    console.error('push failed:', e.message);
  }
});

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (req.headers['x-api-key'] !== BRIDGE_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/status', (req, res) => res.json(state));

app.post('/send', async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (typeof to !== 'string' || !to.trim() || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'to and text must be non-empty strings' });
    }
    if (state.status !== 'ready') return res.status(503).json({ error: 'WhatsApp connected na' });
    const m = await client.sendMessage(to, text);
    res.json({ ok: true, id: m.id._serialized });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/logout', async (req, res) => {
  try {
    await client.logout();
  } catch (error) {
    console.error('WhatsApp logout failed:', error);
    return res.status(500).json({ error: 'WhatsApp logout failed' });
  }
  state = { status: 'starting', qr: null };
  scheduleReconnect(2000);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log('Bridge listening on', PORT));
initializeClient();