# Buddy

A friendly AI companion that lives on your desktop as a small glowing orb. Click it — or say
**“Hey Buddy”** — and a Siri-style panel opens. Talk or type; Buddy answers out loud.

Buddy runs entirely on your machine and calls the AI provider directly with your own key. There is
no Buddy server, no proxy, and no account.

```
buddy/
├── desktop-app/                    Electron app (the whole product)
├── docs/                           Static landing page for GitHub Pages
└── .github/workflows/release.yml   Builds + publishes installers on tag push
```

---

## What “local” actually means

Being straight about this, because the distinction matters:

**Buddy is local-first.** The app, the config and the loopback HTTP server all run on your machine.
Your API key is stored in Buddy's own data folder and is sent to exactly one place: the AI provider.
Nothing routes through a server belonging to this project, because there isn't one.

**Buddy is not fully private.** The language model, the text-to-speech and the speech recognition
all run on the z-ai provider's servers. Your messages and your voice recordings are sent there to be
processed.

**The wake word uses Option B — VAD plus remote ASR.** Buddy detects speech locally (Web Audio RMS
against a measured noise floor), then sends a short clip to the provider's ASR to check whether you
actually said “Hey Buddy.” So **while the wake word is on, brief clips of ambient audio leave your
device** whenever something is loud enough to look like speech. Two guards keep this reasonable:

- The trigger threshold is calibrated against the room, not hardcoded. Buddy measures the ambient
  level for the first ~2 seconds and sets the threshold relative to it, then keeps drifting the floor
  during quiet stretches.
- Wake checks are rate-limited to at most one every 1.5 seconds, so a noisy room can't spam the API.

Turn the wake word off from the tray menu and nothing is captured until you press the mic yourself.
An on-device engine (Option A) would remove this trade-off entirely — see
[Upgrading to an on-device wake word](#upgrading-to-an-on-device-wake-word).

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

### Using Buddy

- **Click the orb** to open the panel. Click the tray/menu-bar icon to toggle it.
- **Type** and press Enter, or **tap the mic** to record a voice message (tap again to send it).
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

- `.z-ai-config` — your `baseUrl` and `apiKey`, written with `0600` where the filesystem supports it.
  **Stored unencrypted.** It's gitignored, and never logged or returned by any endpoint.
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
│    GET /health · POST /setup /chat /tts /asr               │
└───────────────────────────┬────────────────────────────────┘
                            │  z-ai-web-dev-sdk (server-side only)
                            ▼
                   the z-ai provider's API
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

## Upgrading to an on-device wake word

Swapping Option B for a local engine would make “your audio stays on your device until you speak to
Buddy” genuinely true, and would be faster and cheaper. The renderer is structured to make this a
contained change:

1. Add the engine (Porcupine needs a free Picovoice access key; openWakeWord needs a Python
   sidecar or an ONNX runtime).
2. In `src/renderer/renderer.js`, replace `checkClip()` — the function that POSTs a clip to `/asr` —
   with the engine's keyword callback. The RMS loop, cooldown and rate limiter can all go.
3. Add any native binary to `build.asarUnpack` in `package.json`.
4. Update the privacy copy in `docs/index.html` and this README, since the trade-off would no longer
   apply.

---

## Verification status

See [`VERIFICATION.md`](VERIFICATION.md) for exactly what was tested, what passed, and what still
needs a real desktop, a live microphone or a signed build.

## License

MIT — see [LICENSE](LICENSE).
