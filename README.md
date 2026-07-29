# Buddy

A friendly AI companion that lives on your desktop as a small glowing orb. Click it — or say
**“Hey Buddy”** — and a Siri-style panel opens. Talk or type; Buddy answers out loud.

Buddy can run **two ways**, and you pick on first launch:

- **On this machine** — an [Ollama](https://ollama.com) model does the thinking, your OS's own voices
  do the talking. No key, no account, works with the network unplugged.
- **z-ai cloud** — bring your own key. Buddy calls the provider directly; there is still no Buddy
  server, no proxy and no account in between.

You can mix them too: a local model with cloud speech, or the reverse. Either way your conversations
are **saved on your device** as plain JSON you can browse from the app and delete whenever you like.

```
buddy/
├── desktop-app/                    Electron app (the whole product)
├── docs/                           Static landing page for GitHub Pages
└── .github/workflows/release.yml   Builds + publishes installers on tag push
```

---

## What “local” actually means

Buddy has three separate jobs, and each one can run in either place. This table is the whole privacy
story — there is nothing else to it:

| Job | Local option | Cloud option | Leaves your device? |
| --- | --- | --- | --- |
| **Thinking** (the model) | Ollama on `127.0.0.1` | z-ai | only in cloud mode |
| **Talking** (text → speech) | your OS's installed voices | z-ai | only in cloud mode |
| **Hearing** (speech → text) | a local Whisper server, or **off** | z-ai | only in cloud mode |
| **Your chat history** | always on your disk | — | **never** |

**In cloud mode, Buddy is local-first but not private.** The app, your key and the loopback server
all live on your machine, and nothing routes through a server belonging to this project — because
there isn't one. But your messages and voice recordings do go to z-ai to be processed.

**In local mode, nothing leaves your machine at all** — as long as *hearing* is also local or off.
Buddy tells you which of these is true, in the setup screen and in the app, rather than making you
work it out.

### About the wake word

The wake word works by detecting speech locally (Web Audio RMS against a measured noise floor) and
then transcribing a short clip to check whether you actually said “Hey Buddy.” **Where that clip
goes depends entirely on your *hearing* setting:**

- **Hearing = local Whisper** → the clip is transcribed on your machine. Ambient audio never leaves
  your device. This is the genuinely on-device wake word.
- **Hearing = z-ai** → short clips of ambient sound are sent to z-ai whenever something is loud
  enough to look like speech. Two guards keep this sane: the threshold is calibrated against your
  actual room for the first ~2 seconds (never hardcoded) and re-drifts during quiet stretches, and
  wake checks are rate-limited to one every 1.5 seconds so a noisy room can't spam the API.
- **Hearing = off** → Buddy never opens your microphone at all. The mic button is disabled and the
  wake word does not run. Typing works exactly the same.

You can also switch the wake word off from the tray menu at any time, whatever the hearing setting.

---

## Install as a user

1. Download the installer for your OS from the
   [latest release](https://github.com/your-github-username/buddy/releases/latest).
2. Run it (see [First launch](#first-launch-unsigned-builds) — the builds are unsigned).
3. On first launch Buddy asks for your z-ai **base URL** and **API key**, once. They're written to
   Buddy's local data folder and used only to call the provider.
4. The orb appears in the top-right corner. Drag it wherever you like; it remembers.

### First launch (unsigned builds)

These installers are **not code-signed**, so your OS will warn you the first time. This is expected
and not a sign that anything is wrong.

| OS | What you'll see | What to do |
| --- | --- | --- |
| **macOS** | “Buddy can't be opened because it is from an unidentified developer” — or “Buddy is damaged” | Right-click the app → **Open** (don't double-click). If it claims the app is damaged, run `xattr -dr com.apple.quarantine /Applications/Buddy.app` |
| **Windows** | SmartScreen: “Windows protected your PC” | **More info** → **Run anyway** |
| **Linux** | Nothing happens when you click the AppImage | `chmod +x Buddy-*.AppImage` then run it |

Getting rid of these warnings needs an Apple Developer certificate and a Windows code-signing
certificate; both cost money and neither is set up here.

---

## Running Buddy fully locally

Pick **On this machine** on the first-run screen. Buddy checks what you already have and tells you
what's missing.

### 1. Thinking — Ollama (one install)

```bash
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh
# Windows: download the installer from https://ollama.com

ollama pull llama3.2      # ~2 GB, comfortable on 8 GB of RAM
```

That's it. Buddy finds Ollama on `http://127.0.0.1:11434` by itself and lists whatever models you've
pulled. If Ollama isn't running, the setup screen says so and tells you the command to fix it.

Smaller machines: `llama3.2:1b` or `qwen2.5:3b`. Bigger machines: `qwen2.5:7b`, `phi4`.

### 2. Talking — already installed

Buddy uses the voices your operating system ships with, spoken directly in the app. **Nothing to
install and nothing to configure** — the setup screen lists the voices it found and lets you choose.
Windows has David/Zira, macOS has the full Speech set, Linux depends on your `speech-dispatcher`
setup.

### 3. Hearing — optional

This is the only piece that needs real work, so it's **off by default** and Buddy is completely
usable without it (you type instead of talking). To turn it on, run any OpenAI-compatible
transcription server and point Buddy at it:

```bash
# Speaches (formerly faster-whisper-server) — the easiest option
docker run --rm -p 8000:8000 ghcr.io/speaches-ai/speaches:latest
```

Then set *Voice input* to **Local Whisper server** with `http://127.0.0.1:8000/v1`. Anything exposing
`POST /audio/transcriptions` works — Speaches, faster-whisper-server, LocalAI, or `whisper.cpp`'s
server. Buddy sends the clip as a multipart file with a correct extension, because most of these
sniff the container from the filename before handing it to ffmpeg.

With hearing local, the mic **and** the wake word run entirely on your machine.

### Changing your mind later

Everything lives in one small file you can edit by hand — `buddy-settings.json` in the data folder
listed [below](#where-things-are-stored):

```json
{
  "chat": { "provider": "ollama", "model": "llama3.2", "baseUrl": "http://127.0.0.1:11434" },
  "tts":  { "provider": "system", "voice": "Microsoft Zira Desktop" },
  "asr":  { "provider": "off", "baseUrl": "http://127.0.0.1:8000/v1", "model": "Systran/faster-whisper-small" },
  "saveHistory": true
}
```

`chat.provider` is `ollama` or `z-ai`. `tts.provider` is `system` or `z-ai`. `asr.provider` is
`whisper`, `z-ai`, or `off`. Restart Buddy after editing, or POST the same shape to `/settings`.

---

## Your chat history

Every conversation is written to your own disk as soon as it happens — one readable JSON file per
chat, in `chats/` inside Buddy's data folder:

```json
{
  "id": "04ed8778-4fee-4faa-a8ce-3509b4f57c66",
  "title": "are you running locally",
  "createdAt": "2026-07-29T21:09:12.317Z",
  "updatedAt": "2026-07-29T21:09:41.882Z",
  "messages": [
    { "role": "user", "content": "are you running locally", "at": "2026-07-29T21:09:12.317Z" },
    { "role": "assistant", "content": "Hey! I'm running entirely on your machine…", "at": "…" }
  ]
}
```

In the app, the **☰ button** in the panel header opens your chats, newest first, with the time and
message count. Click one to reopen it exactly as it was; hover one to delete it. The **+ button**
starts a fresh conversation without touching the old one. Reopening Buddy drops you back into your
most recent chat rather than a blank slate.

Two things worth knowing:

- **Nothing is uploaded, ever.** History is a local file concern only. Even in cloud mode, only the
  last 20 messages of the *current* conversation are sent as context for a reply — the archive itself
  is never transmitted.
- **You are in control of it.** The drawer has a *Save new chats to this device* toggle if you'd
  rather Buddy forgot as it went, and a *Delete all saved chats* button that removes the files from
  disk. They're your files, so deleting the folder by hand works just as well.

The files are **not encrypted**. Anyone with access to your user account can read them, the same as
any other document in your home folder.

---

### Using Buddy

- **Click the orb** to open the panel. Click the tray/menu-bar icon to toggle it.
- **Type** and press Enter, or **tap the mic** to record a voice message (tap again to send it).
- **☰ opens your saved chats**; **+ starts a new one**. Escape closes the drawer.
- **The speaker button** in the panel header mutes spoken replies.
- **The tray menu** has *Open Buddy*, a *Wake word: On/Off* checkbox, and *Quit*.
- An **emerald ring** around the orb means the mic is hot and Buddy is listening for its name.
  The wake word pauses automatically while the panel is open.

---

## Run from source

```bash
cd desktop-app
npm ci
npm start
```

Other scripts:

| Command | What it does |
| --- | --- |
| `npm start` | Runs the app (Electron starts its own in-process server on a free port) |
| `npm run server` | Runs just the local server, so you can curl it |
| `npm run dev` | Standalone server on port 3005 **plus** Electron, together |
| `npm run icon` | Regenerates `buddy-icon.png` |
| `npm run dist:win` / `dist:mac` / `dist:linux` | Builds installers for one platform |
| `npm run dist` | Builds for the current platform |

### Testing the server by hand

`npm run server` prints its port and an auth token. Every route except `/health` requires that token
in an `X-Buddy-Token` header — the server is on loopback, but any web page in any browser can also
reach loopback, and the token is what keeps these endpoints Buddy's.

```bash
# The port and token come from the startup banner.
PORT=3005 TOKEN=<token from banner>

curl -s http://127.0.0.1:$PORT/health
# {"ok":true,"configured":false}

curl -s -X POST http://127.0.0.1:$PORT/setup \
  -H 'Content-Type: application/json' -H "X-Buddy-Token: $TOKEN" \
  -d '{"baseUrl":"https://api.z.ai/api/paas/v4","apiKey":"YOUR_KEY"}'
# {"ok":true}

curl -s -X POST http://127.0.0.1:$PORT/chat \
  -H 'Content-Type: application/json' -H "X-Buddy-Token: $TOKEN" \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
# {"reply":"Hey! ...","sessionId":"..."}

curl -s -X POST http://127.0.0.1:$PORT/tts \
  -H 'Content-Type: application/json' -H "X-Buddy-Token: $TOKEN" \
  -d '{"text":"Hello there"}' --output hello.wav
```

### Where things are stored

Everything lives in Electron's `userData` directory — **not** next to the app, which is read-only in
a packaged build:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\buddy\` |
| macOS | `~/Library/Application Support/buddy/` |
| Linux | `~/.config/buddy/` |

- `buddy-settings.json` — which provider serves each capability, and whether history is saved.
- `chats/<id>.json` — one file per conversation. Yours to read, back up or delete.
- `.z-ai-config` — your `baseUrl` and `apiKey`, written with `0600` where the filesystem supports it.
  **Stored unencrypted.** It's gitignored, and never logged or returned by any endpoint. Only exists
  if you use a cloud capability.
- `buddy-state.json` — the orb's position and the wake-word preference.

---

## How it fits together

```
┌─ Electron main ────────────────────────────────────────────┐
│  orb window (80×80, frameless, transparent, on top)        │
│  panel window (420×620, hidden not destroyed)              │
│  setup window (first run only)                             │
│  tray icon · manual orb drag · position persistence        │
│                                                            │
│  in-process HTTP server → 127.0.0.1:<OS-assigned port>     │
│    /health /settings /providers/status /setup              │
│    /chat /tts /asr /chats                                  │
└──────┬──────────────────────┬──────────────────────────────┘
       │                      │
       │ chats/*.json         ├── ollama    → 127.0.0.1:11434
       ▼ (never uploaded)     ├── whisper   → 127.0.0.1:8000
   your disk                  ├── system voice → the renderer, via the OS
                              └── z-ai      → the provider's API
                                             (z-ai-web-dev-sdk, main process only)
```

A few decisions worth knowing about:

- **The port is never hardcoded.** The server binds port `0` and lets the OS assign a free one; the
  actual port is handed to the renderer over IPC. “Port already in use” can't stop Buddy from
  starting. (If a fixed port is requested via `BUDDY_PORT`, it falls back to a free one when taken.)
- **The renderer is served over a custom `buddy://` scheme**, not `file://`. The CSP has to name the
  server's port in `connect-src`, and the port isn't known until launch — so the protocol handler
  generates the CSP as a real response header at request time. This also gives the renderer a secure
  origin, which `getUserMedia` requires.
- **The orb is dragged manually.** `-webkit-app-region: drag` swallows hover and click on a target
  this small, so main watches the cursor and calls `setPosition` itself. A press that moves under 5px
  in under 450ms counts as a click.
- **The SDK is only ever loaded in the main process.** No key material reaches the renderer.

### The z-ai SDK: what's actually there

`z-ai-web-dev-sdk@0.0.18` differs from what you might expect, so the server is written against the
real package rather than its docs:

| | Reality |
| --- | --- |
| `ZAI.create()` | Takes **no arguments**. It finds its own config by reading `.z-ai-config` from `process.cwd()`, then `os.homedir()`, then `/etc`. |
| Config file | Requires **both** `baseUrl` and `apiKey`, or it's ignored. `baseUrl` must include the version prefix, e.g. `https://api.z.ai/api/paas/v4`. |
| TTS | `zai.audio.tts.create({ input, voice, response_format, stream })` — the key is **`input`**, not `text`. Resolves to a raw `Response`; you read the bytes yourself. |
| ASR | `zai.audio.asr.create({ file_base64 })` — the key is **`file_base64`**, not `audio`. Resolves to parsed JSON with the transcript on `.text`. |
| Chat | `zai.chat.completions.create({ messages, thinking })` → `.choices[0].message.content`. `thinking` already defaults to `{ type: 'disabled' }`. |
| Module format | ESM-only, so the CJS server reaches it via dynamic `import()`. It's `asarUnpack`ed so it resolves from a packaged build. |

Because `ZAI.create()` resolves its config relative to `process.cwd()` and Buddy's config lives in
`userData`, the server briefly `chdir`s into the config directory around that one call and restores
the previous working directory immediately afterwards.

---

## Rebuilding the installers

### Locally

```bash
cd desktop-app
npm ci
npm run dist:win      # or dist:mac / dist:linux
```

Artifacts land in `desktop-app/dist/`. You can only build for the platform you're on, apart from
Linux targets from Linux — a Windows `.exe` needs Windows (or Wine), and a macOS `.dmg` needs macOS.

### Via GitHub Actions

Set your owner and repo in **three** places, then push a tag:

1. `desktop-app/package.json` → `build.publish.owner` / `build.publish.repo`
2. `docs/app.js` → the `OWNER` / `REPO` constants at the top
3. The release links in this README

```bash
git tag v1.0.0
git push origin v1.0.0
```

`.github/workflows/release.yml` builds on `ubuntu-latest`, `windows-latest` and `macos-latest` and
publishes every artifact to a GitHub release. It can also be started by hand from the Actions tab.

Notes:

- **`desktop-app/package-lock.json` must stay committed** — both `npm ci` and the npm cache in
  `setup-node` depend on it.
- **Pushing anything under `.github/workflows/` needs a token with the `workflow` scope.** If your
  token doesn't have it, add the file through the GitHub web UI (Actions → new workflow) instead.
- `macos-latest` runners are arm64. The mac target is configured for `["x64", "arm64"]` so Intel Macs
  get a build too; drop `x64` if you only care about Apple Silicon.

### GitHub Pages

The site is in **`docs/`**, which is the zero-config option: *Settings → Pages → Deploy from a
branch → main → /docs*. No Pages workflow is needed. (A `site/` directory would have required a
deploy workflow with `pages: write` and `id-token: write`.)

---

## Going further on the wake word

Setting *hearing* to a local Whisper server already makes “your audio stays on your device” true —
the whole VAD-plus-transcribe loop runs on `127.0.0.1`. What it isn't is *cheap*: every sound loud
enough to look like speech costs a Whisper inference.

A dedicated keyword-spotting engine would fix that, and the renderer is structured to make it a
contained change:

1. Add the engine (Porcupine needs a free Picovoice access key; openWakeWord needs a Python sidecar
   or an ONNX runtime).
2. In `src/renderer/renderer.js`, replace `checkClip()` — the function that POSTs a clip to `/asr` —
   with the engine's keyword callback. The RMS loop, cooldown and rate limiter can all go.
3. Add any native binary to `build.asarUnpack` in `package.json`.

---

## Verification status

See [`VERIFICATION.md`](VERIFICATION.md) for exactly what was tested, what passed, and what still
needs a real desktop, a live microphone or a signed build.

## License

MIT — see [LICENSE](LICENSE).
