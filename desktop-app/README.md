# Buddy — desktop app

The Electron app. See the [repo README](../README.md) for the full picture, the privacy details and
the release process.

## Install as a user

Download the installer for your OS from the
[latest release](https://github.com/JeffreyHamilton6399/buddy-desktop/releases/latest) and run it.

The builds are **unsigned**, so the first launch needs one extra step:

- **macOS** — right-click the app → **Open** (don't double-click). If macOS says the app is damaged:
  `xattr -dr com.apple.quarantine /Applications/Buddy.app`
- **Windows** — SmartScreen → **More info** → **Run anyway**
- **Linux** — `chmod +x Buddy-*.AppImage`

**Nothing to configure.** On first launch Buddy downloads its own model (~770 MB, once, with a
progress bar) and then runs entirely on your machine — no key, no account, no network.

Everything is stored in Buddy's own local data folder (`%APPDATA%\buddy\` ·
`~/Library/Application Support/buddy/` · `~/.config/buddy/`): the model in `models/`, your saved
conversations in `chats/`. See the
[repo README](../README.md#using-something-other-than-the-built-in-model) for how to point Buddy at
Ollama or a cloud API instead.

## Run from source

```bash
npm ci
npm start
```

| Command | What it does |
| --- | --- |
| `npm start` | Runs the app. Electron starts its own server on an OS-assigned port. |
| `npm run server` | Runs only the local server and prints its port + auth token. |
| `npm run dev` | Standalone server on port 3005 **plus** Electron, together. Ctrl+C stops both. |
| `npm run icon` | Regenerates `buddy-icon.png` (1024×1024 RGBA, no dependencies). |
| `npm run dist` | Builds an installer for the current platform, into `dist/`. |
| `npm run dist:win` / `dist:mac` / `dist:linux` | Builds for one specific platform. |

## Layout

```
src/
  main.js              windows, tray, orb drag, the buddy:// scheme, server startup
  preload.js           contextBridge → window.buddy
  renderer/
    index.html         markup for all three modes (orb · panel · setup)
    renderer.js        entry point; picks a mode and hands over
    core.js            shared plumbing: server access, runtime state, markdown
    orb.js             the wake word, barge-in, and the orb's own state machine
    panel.js           the chat window
    settings.js        every settings pane
    capture.js         microphone and voice detection
    speech.js          playback, chunked, with an output-level tap for the orb
    styles.css         warm dark theme
  server/
    server.js          127.0.0.1 http server, routing and auth
    providers.js       dispatch: builtin, ollama, cloud, system voices, whisper
    keys.js            pasted API keys: whose they are, and what they can do
    cloud.js           chat, speech and transcription over OpenAI/Anthropic shapes
    builtin.js         llama.cpp in-process — the default brain
    model.js           the model library: downloads, verifies, and sizes them
    voice.js           Kokoro TTS, and splitting a reply into speakable chunks
    hearing.js         Whisper ASR in-process
    actions.js         the fixed list of things Buddy may do, and their parsing
    files.js           path scoping for file access — the security boundary
    history.js         saved conversations, one JSON file per chat
scripts/
  dev.js               spawns server + electron
  make-icon.js         writes the orb PNG
```

## Environment variables

Useful for development; none are needed in normal use.

| Variable | Effect |
| --- | --- |
| `BUDDY_PORT` | Ask the server for a specific port. Falls back to a free one if it's taken. |
| `BUDDY_CONFIG_DIR` | Where settings, saved keys, models and chats live. Electron sets this to `userData`. |
| `BUDDY_TOKEN` | Fixes the `X-Buddy-Token` value instead of generating one per launch. |
| `BUDDY_TRANSPARENT` | `1` forces transparent windows, `0` forces the opaque fallback. Only relevant on Linux. |

## Notes on the built-in model

- Electron must be recent enough to parse `node-llama-cpp` — Electron 28 cannot, hence Electron 43.
- The CUDA and Vulkan llama.cpp variants are excluded from the build via `files` (500 MB+ between
  them), so Windows and Linux run on CPU. macOS gets Metal for free inside its own binary.
- `npm install` pulls every variant for your platform; only the CPU one is packaged.

## Notes

- **The icon must be at least 512×512.** electron-builder refuses to generate a macOS `.icns` from
  anything smaller, and the macOS job is the only one that cares — Windows and Linux build fine from
  256×256, so a too-small icon fails on exactly one of three runners. `scripts/make-icon.js` emits
  1024×1024.
- `buddy-keys.json` and `.z-ai-config` hold API keys, are written owner-only, and are **gitignored**.
  Never commit a real key. Keys are read only in the main process; the renderer only ever sees a
  masked form, and `scrub()` strips them from every error and log line.
- File access is scoped by `server/files.js` and re-validated in `main.js` before anything touches
  the disk. Treat both as the security boundary they are — see the tests in that file's header.
- `package-lock.json` is committed on purpose; CI's `npm ci` and npm cache both need it.
