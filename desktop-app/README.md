# Buddy — desktop app

The Electron app. See the [repo README](../README.md) for the full picture, the privacy details and
the release process.

## Install as a user

Download the installer for your OS from the
[latest release](https://github.com/your-github-username/buddy/releases/latest) and run it.

The builds are **unsigned**, so the first launch needs one extra step:

- **macOS** — right-click the app → **Open** (don't double-click). If macOS says the app is damaged:
  `xattr -dr com.apple.quarantine /Applications/Buddy.app`
- **Windows** — SmartScreen → **More info** → **Run anyway**
- **Linux** — `chmod +x Buddy-*.AppImage`

Buddy asks for your z-ai **base URL** and **API key** once, on first launch, and stores them in its
own local data folder (`%APPDATA%\buddy\` · `~/Library/Application Support/buddy/` ·
`~/.config/buddy/`). They're sent only to the AI provider.

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
| `npm run icon` | Regenerates `buddy-icon.png` (256×256 RGBA, no dependencies). |
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
    server.js          127.0.0.1 http server: /health /setup /chat /tts /asr
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

- `.z-ai-config` is **gitignored**. Never commit a real key. `.z-ai-config.example` shows the shape.
- The z-ai SDK is loaded only in the main process — no key material reaches the renderer.
- `package-lock.json` is committed on purpose; CI's `npm ci` and npm cache both need it.
