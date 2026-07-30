# Buddy

A friendly AI companion that lives on your desktop as a small glowing orb. Click it — or say
**“Hey Buddy”** — and a Siri-style panel opens. Talk or type; Buddy answers out loud.

**There is nothing to set up.** No API key, no account, no sign-in, no provider to choose. Install
it, and on first launch Buddy fetches its own language model once — you watch a progress bar — and
then works forever, offline, on your own machine.

```
   install  →  "Getting my brain ready… 43%"  →  chat
```

Under the hood, three models run inside the app and none of them needs a network once downloaded:
[llama.cpp](https://github.com/ggerganov/llama.cpp) runs **Llama 3.2 1B** for thinking,
**Kokoro-82M** speaks the replies in a neural voice, and **Whisper tiny.en** listens for its name and
for what you say. Your conversations are **saved on your device** as plain JSON you can browse from
the app and delete whenever you like.

Everything is adjustable from one place: click **Buddy's own name** in the top-left of the panel to
open settings, where you can pick a bigger brain, choose from 28 voices, or turn listening off.

If you'd rather point Buddy at something stronger, a cloud API and a local
[Ollama](https://ollama.com) server are both supported — see
[Using something other than the built-in model](#using-something-other-than-the-built-in-model).
Nobody is asked to.

```
buddy-desktop/
├── desktop-app/                    Electron app (the whole product)
├── docs/                           Static landing page for GitHub Pages
└── .github/workflows/main.yml      Builds + publishes installers on tag push
```

---

## What “local” actually means

Buddy has three separate jobs. **Out of the box all three run on your machine**, so nothing you say
or type leaves it:

| Job | Default (no setup) | Optional alternatives | Leaves your device? |
| --- | --- | --- | --- |
| **Thinking** | Llama 3.2 1B, in-process via llama.cpp | 3 bigger models · Ollama · a cloud API | **no** |
| **Talking** | Kokoro-82M, in-process via onnxruntime | your OS's voices · a cloud API | **no** |
| **Hearing** | Whisper tiny.en, in-process | your own Whisper server · a cloud API · off | **no** |
| **Your chat history** | plain JSON on your disk | — | **never** |

The one exception is the **downloads on first launch**, all from HuggingFace: ~770 MB for the model,
then ~156 MB for the voice and ~39 MB for the ears. Only the model is waited for — Buddy opens as
soon as it can think, and the other two arrive in the background while you type. After that Buddy
runs with the network unplugged, and you can verify that by unplugging it. Nothing is phoned home,
there is no telemetry, and there is no account.

**If you switch a job to a cloud API, that job stops being private** — your messages or voice go to
that provider to be processed. Buddy says which jobs are cloud-backed in the app rather than making
you work it out, and the startup log prints `✓ fully local` only when none of them are.

### About the wake word

Say **“Hey Buddy”** and the orb pulses, opens the panel, and answers *“Yeah? What would you like?”*
Run the two together — “Hey Buddy, what's the capital of Peru” — and it skips the greeting and just
answers, because the whole sentence was already transcribed.

It works by detecting speech locally (Web Audio RMS against a measured noise floor) and then
transcribing a short clip to check whether you really said the name. **Where that clip goes depends
entirely on your *hearing* setting:**

- **Hearing = Buddy's own ears** (the default) → the clip is transcribed by Whisper inside the app.
  Ambient audio never leaves your device.
- **Hearing = your own Whisper server** → the clip goes to whatever address you configured, on your
  own network.
- **Hearing = z-ai** → short clips of ambient sound are sent to z-ai whenever something is loud
  enough to look like speech. Two guards keep this sane: the threshold is calibrated against your
  actual room (never hardcoded) and re-drifts during quiet stretches, and wake checks are
  rate-limited so a noisy room can't spam the API.
- **Hearing = off** → Buddy never opens your microphone at all. The mic button is disabled and the
  wake word does not run. Typing works exactly the same.

Two details worth knowing. Clips include the **third of a second before** speech was detected, kept
in a rolling buffer — without it the leading “Hey” is already gone by the time the detector fires.
And Buddy ignores its own voice while it is speaking, so it cannot wake itself up.

You can switch the wake word off from the tray menu or from **Settings → Hearing** at any time. If
your machine has no microphone, Buddy notices, turns the wake word off, and says so on the orb rather
than failing quietly.

---

## Install as a user

1. Download the installer for your OS from the
   [latest release](https://github.com/JeffreyHamilton6399/buddy-desktop/releases/latest).
2. Run it (see [First launch](#first-launch-unsigned-builds) — the builds are unsigned).
3. On first launch Buddy downloads its model (~770 MB, once) and shows a progress bar. Nothing to
   choose, no key to paste. If the download is interrupted it resumes.
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

## Settings

Click **Buddy's own name and orb** in the top-left of the panel. Five sections down the side:

| Section | What is in it |
| --- | --- |
| **Brain** | Every model Buddy can download itself, with sizes and what each is good for. One tap to switch, one to delete a model you are done with. Any models a running Ollama has pulled appear here too. |
| **Voice** | Which engine speaks, which of Kokoro's 28 voices, how fast, and a **Hear it** button to audition before committing. |
| **Hearing** | The “Hey Buddy” switch, which transcriber to use, and **Test the microphone** — it records you and prints back what it heard. |
| **Chats** | Whether conversations are kept, how many there are, and delete-everything. |
| **About** | Which engine is doing each job and whether it is local, so the privacy claim is checkable rather than asserted. |

Nothing here needs the file system; the sections below are for people who prefer a text editor.

---

## Using something other than the built-in model

You do not need any of this. Buddy ships working. But if you want a bigger brain or you already run
a local model server, every job can be pointed elsewhere — from **Settings → Brain**, or by hand.

Everything lives in one small file you can edit by hand — `buddy-settings.json` in the data folder
listed [below](#where-things-are-stored). Restart Buddy after editing, or POST the same shape to
`/settings`.

```json
{
  "version": 2,
  "chat": { "provider": "builtin", "builtinModel": "", "model": "", "baseUrl": "http://127.0.0.1:11434" },
  "tts":  { "provider": "kokoro", "voice": "af_heart", "speed": 1 },
  "asr":  { "provider": "local", "baseUrl": "http://127.0.0.1:8000/v1", "model": "Systran/faster-whisper-small" },
  "saveHistory": true
}
```

| Job | Setting | Values |
| --- | --- | --- |
| Thinking | `chat.provider` | `builtin` (default) · `ollama` · `z-ai` |
| Which built-in | `chat.builtinModel` | `llama-3.2-1b-instruct-q4_k_m` (default) · `llama-3.2-3b-instruct-q4_k_m` · `qwen2.5-3b-instruct-q4_k_m` · `qwen2.5-7b-instruct-q4_k_m` |
| Talking | `tts.provider` | `kokoro` (default) · `system` · `z-ai` |
| Hearing | `asr.provider` | `local` (default) · `whisper` · `z-ai` · `off` |

Upgrading from 1.1.0 moves you onto the new voice and ears automatically, unless you had deliberately
chosen the cloud or your own Whisper server — those choices are left alone.

### A bigger built-in model

**Settings → Brain** lists four, from the 770 MB default up to Qwen 2.5 7B. Each shows its download
size and roughly how much memory it wants, because that is the part that decides whether a model is
pleasant on a given laptop. Buddy verifies each download against a known SHA-256 and will not load a
file that fails.

### A bigger model via Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh   # Windows: installer from ollama.com
ollama pull qwen2.5:7b
```

Buddy probes `http://127.0.0.1:11434` on its own; anything you have pulled shows up under
**Settings → Brain** with a button to use it. This stays entirely local — it is just a larger model
than the one Buddy carries. If Ollama is not running, the section says so instead of showing an empty
list.

### A cloud API

The first-run screen has a *"Use a cloud API instead"* link if you want to skip the download
altogether. Or set `chat.provider` to `z-ai` and put a `baseUrl` and `apiKey` in `.z-ai-config`.
**This is the only configuration that sends your conversations off the machine.**

### Your own transcription server

If you would rather run Whisper yourself than use the copy inside Buddy, set `asr.provider` to
`whisper`:

```bash
# Speaches (formerly faster-whisper-server) — the easiest option
docker run --rm -p 8000:8000 ghcr.io/speaches-ai/speaches:latest
```

Anything exposing `POST /audio/transcriptions` works — Speaches, faster-whisper-server, LocalAI, or
`whisper.cpp`'s server. Buddy records raw 16 kHz samples and puts a wav header on them for these
providers, so there is no codec to agree on.

### Where the models live, and how to reclaim the space

Inside the data folder:

- `models/*.gguf` — the brain, ~770 MB for the default. **Settings → Brain** has a Delete button for
  any model that is not currently answering; you cannot delete the last one out from under yourself.
- `models/hf/` — the voice (~156 MB) and the ears (~39 MB).

Delete any of them and Buddy offers to fetch them again. Downloads resume if interrupted, and the
GGUF is checked against a known SHA-256 before use, so a half-finished file can never be loaded as a
model.

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

- **Click the orb** to open the panel, or **drag it** anywhere; it remembers where you left it.
  Click the tray/menu-bar icon to toggle the panel.
- **Say “Hey Buddy”** to open it hands-free. Ask in the same breath to skip the greeting.
- **Click Buddy's name** in the top-left for settings.
- **Type** and press Enter, or **tap the mic** to record a voice message (tap again to send it).
- **☰ opens your saved chats**; **+ starts a new one**. Escape closes whatever is over the chat.
- **The speaker button** in the panel header mutes spoken replies.
- **The tray menu** has *Open Buddy*, a *Wake word: On/Off* checkbox, and *Quit*.

What the orb is telling you:

| Orb | Meaning |
| --- | --- |
| Slow breathing glow | Idle |
| Emerald ring and dot, gentle ripple | Mic is hot, listening for its name |
| Amber ring, quick ripple, swelling with your voice | It can hear you talking right now |
| One bright pulse | It heard its name |
| Faster pulsing | It is speaking |
| A shake | Something went wrong — the toast underneath says what |

The wake word pauses automatically while the panel is open, and Buddy ignores its own voice so it
cannot wake itself.

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
# {"ok":true,"configured":false,"needsModel":true,...}

# How far the built-in model download has got, and start/resume it:
curl -s -H "X-Buddy-Token: $TOKEN" http://127.0.0.1:$PORT/model
curl -s -X POST -H "X-Buddy-Token: $TOKEN" http://127.0.0.1:$PORT/model
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

# The whole model catalogue, plus whatever Ollama is offering:
curl -s -H "X-Buddy-Token: $TOKEN" http://127.0.0.1:$PORT/models

# Download one, or give its disk space back:
curl -s -X POST   -H "X-Buddy-Token: $TOKEN" http://127.0.0.1:$PORT/models/qwen2.5-3b-instruct-q4_k_m
curl -s -X DELETE -H "X-Buddy-Token: $TOKEN" http://127.0.0.1:$PORT/models/qwen2.5-3b-instruct-q4_k_m

# The voice and the ears: how far their downloads got, and start them.
curl -s -H "X-Buddy-Token: $TOKEN" http://127.0.0.1:$PORT/speech
curl -s -X POST -H "X-Buddy-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"what":"both"}' http://127.0.0.1:$PORT/speech

# The 28 voices Buddy can speak with:
curl -s -H "X-Buddy-Token: $TOKEN" http://127.0.0.1:$PORT/voices

# How a reply gets split for speaking, one chunk at a time:
curl -s -X POST http://127.0.0.1:$PORT/tts/plan \
  -H 'Content-Type: application/json' -H "X-Buddy-Token: $TOKEN" \
  -d '{"text":"**Sure!** Two things:\n- one\n- two"}'
# {"chunks":["Sure! Two things: one.","two."]}
```

`/asr` takes raw 16 kHz mono float samples as base64 in `pcm`, not an encoded file — that is what
Whisper wants, and it means no audio codec is involved anywhere. When a provider needs a file, the
server adds a wav header itself.

### Where things are stored

Everything lives in Electron's `userData` directory — **not** next to the app, which is read-only in
a packaged build:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\buddy\` |
| macOS | `~/Library/Application Support/buddy/` |
| Linux | `~/.config/buddy/` |

- `buddy-settings.json` — which provider serves each capability, and whether history is saved.
- `models/*.gguf` — the built-in language models (~770 MB each). Delete to reclaim the space.
- `models/hf/` — the voice (~156 MB) and the ears (~39 MB), as ONNX weights.
- `chats/<id>.json` — one file per conversation. Yours to read, back up or delete.
- `.z-ai-config` — your `baseUrl` and `apiKey`, written with `0600` where the filesystem supports it.
  **Stored unencrypted.** It's gitignored, and never logged or returned by any endpoint. Only exists
  if you use a cloud capability.
- `buddy-state.json` — the orb's position and the wake-word preference.

---

## How it fits together

```
┌─ Electron main ────────────────────────────────────────────┐
│  orb window (128×128, frameless, transparent, on top)      │
│  panel window (420×620, hidden not destroyed)              │
│  setup window (first run only)                             │
│  tray icon · manual orb drag · position persistence        │
│                                                            │
│  in-process HTTP server → 127.0.0.1:<OS-assigned port>     │
│    /health /settings /providers/status /setup              │
│    /model /models /speech /voices                          │
│    /chat /tts /tts/plan /asr /chats                        │
└──────┬──────────────────────┬──────────────────────────────┘
       │                      │
       │ chats/*.json         ├── builtin  → llama.cpp, in this process   ← default
       ▼ (never uploaded)     ├── kokoro   → onnxruntime, in this process ← default
   your disk                  ├── local    → Whisper, in this process     ← default
                              ├── system voice → the renderer, via the OS
                              ├── ollama   → 127.0.0.1:11434
                              ├── whisper  → 127.0.0.1:8000
                              └── z-ai     → the provider's API
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
- **The orb window is twice the orb.** A transparent window cannot paint outside itself, so a window
  sized to the circle clipped the glow into a square. Everything the orb draws — including blur radii
  and the largest frame of every animation — is sized to fit inside 128px, and `ORB_WINDOW` in
  `main.js` and `.orb-stage` in `styles.css` are two halves of one contract.
- **Speech is generated a sentence at a time.** Kokoro runs at under 2× realtime on a CPU, so
  synthesizing a whole reply first would leave seconds of silence after the text appeared. `/tts/plan`
  splits the reply, deliberately making the first chunk shortest, and the renderer plays each chunk
  while fetching the next.
- **The microphone is captured as raw 16 kHz float via an AudioWorklet**, never MediaRecorder. That is
  Whisper's native input, so no Opus decoder is needed in the server. A rolling buffer keeps the last
  1.5 seconds so a clip can begin *before* speech was detected — otherwise the leading “Hey” is
  already gone.
- **Both audio models run in the main process**, alongside llama.cpp. One copy each, no matter how
  many windows are open, and the strict CSP in the renderer stays untouched.
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

### Adding the release workflow

**`.github/workflows/release.yml` is not in this repo yet**, and that is a token-permission problem
rather than a missing file. It exists locally and is correct; GitHub refuses any write under
`.github/workflows/` from a token that lacks the **`workflow`** scope, and the token used for the
initial push only had `repo`. Pick either fix:

**Option A — a token with the right scope (then it is just a commit)**

Create a classic token at *Settings → Developer settings → Personal access tokens* with both **`repo`**
and **`workflow`** ticked, then:

```bash
# remove the line that excludes it
sed -i '/\.github\/workflows\/release\.yml/d' .gitignore
git add .github/workflows/release.yml .gitignore
git commit -m "Add the release workflow"
git push
```

**Option B — paste it in the web UI (no new token)**

On GitHub: **Actions → New workflow → set up a workflow yourself**, paste the contents of your local
`.github/workflows/release.yml`, and commit. GitHub allows this because you are authenticating as
yourself in the browser rather than with a PAT.

### Via GitHub Actions

Once the workflow is in place, push a tag:

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

“Your audio stays on your device” is now true by default — the whole VAD-plus-transcribe loop runs
inside the app. What it isn't is *cheap*: every sound loud enough to look like speech costs a Whisper
inference (~0.5s of CPU for a short clip).

A dedicated keyword-spotting engine would fix that, and the renderer is structured to make it a
contained change:

1. Add the engine (Porcupine needs a free Picovoice access key; openWakeWord is ONNX, and
   `onnxruntime-node` is already a dependency).
2. In `src/renderer/orb.js`, replace `considerClip()` — the function that POSTs a clip to `/asr` —
   with the engine's keyword callback. The cooldown and rate limiter can go; the detector in
   `capture.js` and its ring buffer are still what you want feeding it.
3. Add any native binary to `build.asarUnpack` in `package.json`.

The transcribe-to-check approach does buy one thing a keyword spotter would not: because the clip is
fully transcribed anyway, “Hey Buddy, what's the capital of Peru” arrives as one sentence and can be
answered without a second round of listening.

---

## The built-in model

`node-llama-cpp` embeds llama.cpp with prebuilt native binaries, so there is no compile step and no
separate daemon — the model is loaded straight into the Electron main process. A few notes:

- **It needs a modern Electron.** Electron 28 cannot even parse `node-llama-cpp` (its ESM import
  attributes are newer than that V8), which is why Buddy is on Electron 43.
- **GPU acceleration comes free where it is bundled.** Apple Silicon gets Metal, since it ships inside
  the `mac-arm64-metal` binary. The CUDA and Vulkan variants are **excluded from the installer** —
  together they are over 500 MB — so Windows and Linux run on CPU. A 1B model is comfortable there.
- **Loading costs ~8 seconds and about a gigabyte of RAM.** It happens lazily on the first message,
  stays warm, and is released after 30 minutes idle.
- **Requests are serialised.** One llama.cpp context cannot serve two conversations at once.

## The voice and the ears

Both are ONNX models run through `onnxruntime-node` by
[transformers.js](https://github.com/huggingface/transformers.js), in the same process as llama.cpp.

- **Kokoro-82M, fp16.** The smaller q8 weights are half the size but synthesize at *0.9× realtime* on
  this CPU — slower than the speech plays, so Buddy would fall further behind the longer it talked.
  fp16 manages ~1.8× for 156 MB. Measurements are in [VERIFICATION.md](VERIFICATION.md).
- **Whisper tiny.en, q8.** 39 MB against base.en's 73 MB, roughly twice as fast, and it got the same
  words right on every phrase tried. Wake-word checks run constantly, so the fast one is also the
  kind one.
- **DirectML does not work for Kokoro** — it fails on a `ConvTranspose` node — so both run on CPU.
- **Whisper invents captions for silence.** Given nothing, it returns `(wind blowing)` or, reliably
  here, `you`. Anything that is only a bracketed sound effect or a known stock phrase is discarded,
  or an always-listening orb would answer questions nobody asked.
- **Each is released after 10 minutes idle**, since together they hold about 300 MB.

## Verification status

See [`VERIFICATION.md`](VERIFICATION.md) for exactly what was tested, what passed, and what still
needs a real desktop, a live microphone or a signed build.

The headline gap in **v1.2.0**: the wake word has never been triggered by an actual voice, because the
development machine has no working microphone. Everything downstream of audio capture is verified —
including Whisper on real speech and the phrase matcher — but `AudioWorklet → voice detection → clip`
has not been exercised end to end.

## License

MIT — see [LICENSE](LICENSE).
