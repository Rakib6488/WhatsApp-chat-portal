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

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    executablePath: puppeteer.executablePath(),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

client.on('qr', async (qr) => {
  state = { status: 'qr', qr: await QRCode.toDataURL(qr, { margin: 1, width: 300 }) };
});
client.on('authenticated', () => { state = { status: 'authenticating', qr: null }; });
client.on('auth_failure', (m) => { console.error('auth_failure', m); state = { status: 'disconnected', qr: null }; });
client.on('ready', () => { state = { status: 'ready', qr: null }; console.log('WhatsApp ready'); });
client.on('disconnected', (reason) => {
  console.log('disconnected', reason);
  state = { status: 'disconnected', qr: null };
  setTimeout(() => client.initialize().catch(console.error), 3000);
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
    if (!to || !text) return res.status(400).json({ error: 'to ar text lagbe' });
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
  } catch (e) { /* ignore */ }
  state = { status: 'starting', qr: null };
  setTimeout(() => client.initialize().catch(console.error), 2000);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log('Bridge listening on', PORT));
client.initialize().catch(console.error);