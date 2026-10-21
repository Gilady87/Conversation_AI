# ConversationAI

**Turn local language models into conversation partners, debate opponents, and a moderator—with queued voice playback and human participation.**

ConversationAI is a browser-based playground for exploring how local LLMs respond to each other. Run a two-participant conversation or a structured debate, choose voices for each role, and introduce your own messages while the session is running.

Built with Node.js, Express, vanilla JavaScript, and the browser's Web Speech API. The supplied server includes integrations for Ollama and llama.cpp's `llama-server`; see [Current implementation notes](#current-implementation-notes) for the status of the llama-server UI connection.

## Features

| Feature | Description |
| --- | --- |
| Two-participant conversations | Alternate responses between two selected Ollama models for a configurable number of rounds. |
| Structured debates | Assign Pro, Con, and Moderator roles, with opening statements, rebuttal rounds, and a final judgment. |
| Human participation | Submit a message during a session; it is picked up at the next supported turn boundary. |
| Role-specific voices | Select a browser speech voice for each participant. |
| Queued audio | Play replies sequentially while generation can continue ahead of playback. |
| Playback status | See whether audio is playing and how many replies are waiting. |
| Session controls | Start, stop, and clear conversations; replay individual replies. |
| Local inference | Send generation requests to an Ollama or llama-server instance on your machine or network. |
| Sampling controls | The llama-server UI exposes temperature, top-p, top-k, repetition penalty, and maximum output tokens. |

## How it works

```mermaid
flowchart TD
    UI["Browser interface"] --> API["Express API"]
    API --> Q["Shared generation queue"]
    Q --> O["Ollama"]
    Q --> L["llama-server"]
    O --> R["Generated reply"]
    L --> R
    R --> UI
    UI --> S["Browser speech queue"]
    S --> V["Selected participant voice"]
```

The application separates generation from speech playback:

- The server serializes `/api/generate` requests through a shared queue.
- The browser displays completed replies and queues their speech independently.
- An utterance's end or error event releases the next queued reply—there is no estimated-duration timer.
- A session remains active until its queued speech finishes. Stop cancels browser requests and clears browser speech playback.

## Quick start

### Requirements

- Node.js and npm.
- A running Ollama instance with at least one installed model for the working Ollama flow.
- A browser with speech synthesis support for read-aloud playback. Available voices depend on the browser and operating system.

### 1. Install dependencies

From the project directory:

```powershell
npm install
```

### 2. Configure the inference endpoint

In `enhanced_server_sync.js`, set `OLLAMA_URL` to your Ollama instance:

```javascript
const OLLAMA_URL = "http://127.0.0.1:11434";
```

The supplied version points to a LAN address. Replace it with your own local or network endpoint. `OLLAMA_URL` is currently a source-code constant, not an environment variable.

For the server's llama-server integration, the default URL can be set through an environment variable:

```powershell
$env:LLAMA_SERVER_URL = "http://127.0.0.1:8080"
```

### 3. Start the application

```powershell
node enhanced_server_sync.js
```

Open **http://localhost:3000** in your browser.

To use another application port:

```powershell
$env:PORT = "3001"
node enhanced_server_sync.js
```

## Using the application

### Regular mode

1. Select **Ollama** as the backend.
2. Choose the two models and their voices. You can use the same model for both participants.
3. Set a topic and number of rounds.
4. Start the conversation. Each round contains one response from each participant.
5. Optionally submit a message to redirect the next turn.

Each model receives the previous reply as its next prompt. This is turn-by-turn prompting rather than a full persistent chat-history implementation.

### Debate mode

Choose a topic, models, and voices for three roles:

| Role | Responsibility |
| --- | --- |
| Pro | Argue in favor of the topic and respond to the opposing side. |
| Con | Argue against the topic and respond to the Pro side. |
| Moderator | Open the debate, address audience input, comment between rounds, and deliver a final judgment. |

The debate includes opening statements followed by the configured rebuttal rounds. At the end, the moderator is prompted to score both sides out of ten. Scores are displayed when the reply matches the expected `Pro: X/10, Con: Y/10` format.

The scores are model-generated judgments, not an objective benchmark.

### Voice playback

Replies are automatically added to the browser speech queue. Each queued item retains the voice selected when it was added, so changing a selector does not change replies already waiting.

Use a reply's read-aloud button to queue it again. The separate **Open in Edge** action launches a speech page through the server and is outside the main browser playback queue.

## Configuration

| Setting | Location | Behavior |
| --- | --- | --- |
| `PORT` | Environment variable | Application port; defaults to `3000`. |
| `OLLAMA_URL` | Constant in `enhanced_server_sync.js` | Base URL used for model discovery and Ollama generation. |
| `LLAMA_SERVER_URL` | Environment variable | Default llama-server URL; the supplied fallback is a LAN address. |
| `MODELS_DIR` | Environment variable | Directory recursively scanned for `.gguf` files; defaults to `./tags` relative to the launch directory. |
| Server URL | Browser interface | URL used by the llama-server connection check and the UI's generation request. See the route mismatch below. |

Environment variables can be set in PowerShell before starting Node. The supplied server does not load `.env` files itself.

## API reference

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/models` | Return available Ollama model names. |
| `GET` | `/api/local-models` | Discover `.gguf` files beneath `MODELS_DIR`. |
| `GET` | `/api/llama-server/health?url=...` | Check whether a GET request to the target server's root succeeds. |
| `POST` | `/api/generate` | Queue generation using the requested backend, model, prompt, and optional parameters. |
| `POST` | `/api/speak-with-edge` | Launch a separate speech page on the machine running Node.js. |

Example generation request:

```json
{
  "backend": "ollama",
  "model": "YOUR_INSTALLED_MODEL",
  "prompt": "Start a short conversation about local AI.",
  "params": {
    "temperature": 0.7,
    "max_tokens": 256
  }
}
```

For the server's llama-server adapter, use `"backend": "llama"` and optionally supply `serverUrl`. The adapter calls `/completion` and uses the model already loaded by that server.

## Project structure

| Path | Purpose |
| --- | --- |
| `enhanced_server_sync.js` | Express server, generation queue, inference adapters, and API routes. |
| `public/index.html` | Browser interface, conversation and debate flows, and speech queue. |
| `package.json` | Project metadata and dependencies. |
| `package-lock.json` | Dependency lockfile. |
| `run.bat` | Windows launcher included with the project. |
| `Pics/` | Local screenshot and demo preparation assets. |

Run Node from the project root so relative paths resolve as intended. The server chooses a static directory containing `index.html`, checking the launch directory before `public/`.

## Current implementation notes

- **llama-server UI route:** The supplied interface posts to `/api/llama-server/generate`, but the supplied server implements generation through `/api/generate`. The UI request must be aligned with that route, including `backend: "llama"`, a model label, and a nested `params` object, before this UI flow works end to end.
- **Model selection with llama-server:** The UI shows `Current Model`; it does not load or switch GGUF models. File discovery through `/api/local-models` is separate from model loading.
- **Ollama UI requests:** The interface sends the model and prompt to `/api/generate` without an explicit backend. The server therefore tries its default llama-server path first and falls back to Ollama. Add `backend: "ollama"` to that request if you want explicit Ollama routing.
- **Stopping generation:** Stop aborts the browser request and discards stale replies, but does not explicitly cancel inference already running on the backend.
- **Persistence:** The supplied conversation flow keeps its visible transcript in the page; it does not implement persistent session storage or transcript export.
- **Socket.IO:** The server provides a connection greeting hook. Generation replies are delivered through HTTP, rather than streamed over Socket.IO.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No Ollama models appear | Verify `OLLAMA_URL`, connectivity from the Node.js host, and installed Ollama models. |
| llama-server generation returns 404 | Check the UI/server route mismatch described above. |
| Unexpected backend handles a request | Send an explicit `backend` value to `/api/generate`. |
| No speech or missing voices | Check browser speech synthesis support and the voices available on the operating system. |
| Edge does not open | The launcher runs on the Node.js host; on Windows, `msedge` must be resolvable. |
| No GGUF files are listed | Verify `MODELS_DIR`; its default is `./tags`, not `./models`. |
| Port is already in use | Set a different `PORT` value before launching the server. |
