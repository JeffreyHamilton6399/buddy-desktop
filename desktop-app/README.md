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

On first launch Buddy asks where it should run:

- **On this machine** — needs [Ollama](https://ollama.com) (`ollama pull llama3.2`). Voice replies use
  your OS's own voices, with nothing to install. Nothing leaves your device.
- **z-ai cloud** — asks for a base URL and API key once.

Everything is stored in Buddy's own local data folder (`%APPDATA%\buddy\` ·
`~/Library/Application Support/buddy/` · `~/.config/buddy/`), including your saved conversations in
`chats/`. See the [repo README](../README.md#running-buddy-fully-locally) for the full local setup.

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
    renderer.js        chat, mic, TTS, ASR, wake word, tiny markdown renderer
    styles.css         warm dark theme
  server/
    server.js          127.0.0.1 http server, routing and auth
    providers.js       cloud vs local dispatch: ollama, system voices, local whisper
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
| `BUDDY_CONFIG_DIR` | Where `.z-ai-config` is read from and written to. Electron sets this to `userData`. |
| `BUDDY_TOKEN` | Fixes the `X-Buddy-Token` value instead of generating one per launch. |
| `BUDDY_TRANSPARENT` | `1` forces transparent windows, `0` forces the opaque fallback. Only relevant on Linux. |

## Notes

- **The icon must be at least 512×512.** electron-builder refuses to generate a macOS `.icns` from
  anything smaller, and the macOS job is the only one that cares — Windows and Linux build fine from
  256×256, so a too-small icon fails on exactly one of three runners. `scripts/make-icon.js` emits
  1024×1024.
- `.z-ai-config` is **gitignored**. Never commit a real key. `.z-ai-config.example` shows the shape.
- The z-ai SDK is loaded only in the main process — no key material reaches the renderer.
- `package-lock.json` is committed on purpose; CI's `npm ci` and npm cache both need it.
