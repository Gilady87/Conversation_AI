/**
 * enhanced_server_sync.js
 * A drop-in Node/Express + Socket.IO server with STRICT turn-taking:
 * - Adds an AsyncQueue to serialize /api/generate calls (no overlap)
 * - Supports both llama-server and Ollama
 * - Serves static UI (index.html / en.html)
 * - Provides health check & local GGUF discovery
 * - Optional Edge TTS launcher endpoint
 *
 * How to run:
 *   npm i express socket.io cors node-fetch@2 open child_process fs path url
 *   node enhanced_server_sync.js
 *
 * Env (optional):
   OLLAMA_URL=http://127.0.0.1:11434
 *   LLAMA_SERVER_URL=http://127.0.0.1:8080
 *   MODELS_DIR=./models
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Server } = require('socket.io');
const fetch = require('node-fetch');
const { spawn } = require('child_process');

// ---- Config ----
const PORT = process.env.PORT || 3000;

const OLLAMA_URL = "http://192.168.1.17:11434";

const DEFAULT_LLAMA_SERVER = process.env.LLAMA_SERVER_URL || 'http://192.168.1.17:8080';
const MODELS_DIR = process.env.MODELS_DIR || path.join(process.cwd(), 'tags');

// ---- App / Server ----
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '4mb' }));

// Serve the uploaded UI if present
const staticCandidates = [
  process.cwd(),                // current dir (if index.html dropped here)
  path.join(process.cwd(), 'public'),
  '/mnt/data',                  // chat sandbox location where files were uploaded
];

let staticDir = staticCandidates.find(p => fs.existsSync(path.join(p, 'index.html')));
if (!staticDir) staticDir = process.cwd();
app.use(express.static(staticDir));

// ---- Strict Sequencing Queue ----
class AsyncQueue {
  constructor() { this._q = Promise.resolve(); }
  enqueue(task) {
    const run = this._q.then(() => task()).catch(err => {
      console.error('AsyncQueue task error:', err);
      // swallow to keep chain alive
    });
    this._q = run.then(() => undefined);
    return run;
  }
}
const turnQueue = new AsyncQueue();

// Helpful sleep
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Utilities ----
function sanitizeResponseText(text) {
  if (!text) return '';
  // Basic cleanup: strip code fences & trim
  return String(text)
    .replace(/^```[\s\S]*?\n/g, '')
    .replace(/```$/g, '')
    .trim();
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText} -> ${body.slice(0, 400)}`);
  }
  return res.json();
}

function listGGUF(dir = MODELS_DIR) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (p) => {
    const ents = fs.readdirSync(p, { withFileTypes: true });
    for (const ent of ents) {
      const fp = path.join(p, ent.name);
      if (ent.isDirectory()) walk(fp);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith('.gguf')) {
        const stat = fs.statSync(fp);
        out.push({
          name: ent.name,
          displayName: `${ent.name} (${(stat.size / (1024*1024)).toFixed(1)} MB)`,
          size: stat.size,
          fullPath: fp,
        });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Socket.IO (optional hooks for live status) ----
io.on('connection', (socket) => {
  socket.emit('hello', { msg: 'Connected to enhanced_server_sync' });
});

// ---- API Endpoints ----

// Return Ollama models
app.get('/api/models', async (req, res) => {
  try {
    const data = await fetchJson(`${OLLAMA_URL}/api/tags`);
    const models = (data?.models || []).map(m => m.model || m.name).filter(Boolean);
    res.json(models);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Return local .gguf models
app.get('/api/local-models', (req, res) => {
  try {
    const files = listGGUF();
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Health check for llama-server
app.get('/api/llama-server/health', async (req, res) => {
  const url = req.query.url || DEFAULT_LLAMA_SERVER;
  try {
    // Many llama-server builds expose /health or /
    const health = await fetch(`${url}/`, { method: 'GET' });
    res.json({ ok: health.ok, url });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), url });
  }
});

/**
 * POST /api/generate
 * Body: { prompt: string, model: string, backend?: 'ollama'|'llama', serverUrl?: string, params?: {} }
 * Behavior:
 *   - Enqueued (serialized) generation
 *   - If backend === 'ollama' -> use Ollama
 *   - else try llama-server at provided serverUrl or default; if fails and backend unspecified, fallback to Ollama
 */
app.post('/api/generate', async (req, res) => {
  const { prompt, model, backend, serverUrl, params = {} } = req.body || {};
  if (!prompt || !model) return res.status(400).json({ error: 'Missing prompt or model' });

  try {
    const response = await turnQueue.enqueue(async () => {
      // small guard-delta between turns so TTS in browser won't overlap
      await wait(60);

      const prefersOllama = backend === 'ollama';
      const prefersLlama = backend === 'llama' || /\.gguf$/i.test(model);

      if (prefersOllama) {
        return await generateWithOllama({ model, prompt, params });
      }

      // Try llama-server first if requested or model looks local
      if (prefersLlama) {
        try {
          return await generateWithLlamaServer({ model, prompt, params, url: serverUrl || DEFAULT_LLAMA_SERVER });
        } catch (e) {
          console.warn('llama-server failed, falling back to Ollama:', e.message);
          return await generateWithOllama({ model, prompt, params });
        }
      }

      // Default heuristic: try llama-server, fallback Ollama
      try {
        return await generateWithLlamaServer({ model, prompt, params, url: serverUrl || DEFAULT_LLAMA_SERVER });
      } catch (e) {
        return await generateWithOllama({ model, prompt, params });
      }
    });

    res.json({ response: sanitizeResponseText(response) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Launch Edge app window with the text (for better TTS voices)
app.post('/api/speak-with-edge', async (req, res) => {
  const { text } = req.body || {};
  try {
    const html = `data:text/html,${encodeURIComponent(`
      <html><head><meta charset="utf-8"><title>TTS</title></head>
      <body style="font-family:Segoe UI;margin:24px;line-height:1.6;">
      <h3>Speech</h3><pre>${(text || '').replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</pre>
      <script>
        const u = new SpeechSynthesisUtterance(${JSON.stringify(text || '')});
        u.rate = 1; u.pitch = 1;
        speechSynthesis.cancel(); speechSynthesis.speak(u);
      </script>
      </body></html>
    `)}`;

    const cmd = process.platform === 'win32' ? 'msedge' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const args = process.platform === 'win32' ? ['--app=' + html] : [html];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- Backends ----
async function generateWithOllama({ model, prompt, params }) {
  const resp = await fetchJson(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: mapParamsToOllama(params),
    })
  });
  // Ollama returns { response, done, ... }
  return resp?.response || '';
}

function mapParamsToOllama(p = {}) {
  const out = {};
  if (p.temperature != null) out.temperature = p.temperature;
  if (p.top_p != null) out.top_p = p.top_p;
  if (p.top_k != null) out.top_k = p.top_k;
  if (p.repeat_penalty != null) out.repeat_penalty = p.repeat_penalty;
  if (p.max_tokens != null) out.num_predict = p.max_tokens;
  return out;
}

async function generateWithLlamaServer({ url, model, prompt, params }) {
  // llama-server (llama.cpp) often exposes /completion (or /v1/chat/completions for OpenAI compat)
  // We'll try /completion first
  const body = {
    prompt,
    temperature: params.temperature ?? 0.7,
    top_p: params.top_p ?? 0.9,
    top_k: params.top_k ?? 40,
    repeat_penalty: params.repeat_penalty ?? 1.1,
    n_predict: params.max_tokens ?? 512,
    cache_prompt: true,
  };
  const resp = await fetchJson(`${url}/completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // { content: "...", stop: true, ... } OR llama.cpp variations
  const text = resp?.content ?? resp?.choices?.[0]?.text ?? resp?.generated_text ?? '';
  if (!text) throw new Error('Empty response from llama-server');
  return text;
}

// ---- Start ----
server.listen(PORT, () => {
  console.log(`✅ enhanced_server_sync listening on http://localhost:${PORT}`);
  console.log(`   Static dir: ${staticDir}`);
  console.log(`   Ollama: ${OLLAMA_URL}`);
  console.log(`   llama-server: ${DEFAULT_LLAMA_SERVER}`);
  console.log(`   Models dir: ${MODELS_DIR}`);
});
