# Verification report

Everything below was run on the development machine: **Windows 10 Pro (19045), Node 24.15.0,
Electron 28.3.3**. Where the spec's checklist assumed a Linux host, the equivalent Windows check was
run instead and is called out as such.

No real z-ai API key was available, so every network check used a **dummy key**. That still proves
the whole chain end to end — a `401` from the provider means the request was built, authenticated
locally, routed through the SDK and accepted by the real endpoint. Only the provider's own
authorisation step fails.

---

## Checklist from the spec

| # | Item | Result |
| --- | --- | --- |
| 1 | `npm ci` in `desktop-app/` succeeds | ✅ 311 packages, exit 0 |
| 2 | Server boots, binds a port, `GET /health` → 200 `{ ok: true }` | ✅ `{"ok":true,"configured":false}` |
| 3 | With a dummy config, `/setup` writes the file and `/health` then reports `configured: true` | ✅ both confirmed, file written to the config dir |
| 4 | Electron launches and shows **both** windows without console errors | ✅ verified visually on a real desktop, not just headless |
| 5 | `npx electron-builder --linux AppImage` produces an artifact | ⚠️ **substituted** — see [below](#the-one-substituted-check) |
| 6 | Landing page opens with no console errors; Download button → `/releases/latest` | ✅ zero page errors |

---

## Detail

### 1. Install

```
npm ci  →  added 311 packages in 15s, exit 0
```

`package-lock.json` (lockfileVersion 3, 325 packages) is committed, so CI's `npm ci` and
`setup-node`'s npm cache both work.

### 2 & 3. Server endpoints

Run standalone via `node src/server/server.js` with `BUDDY_CONFIG_DIR` pointed at a scratch
directory, then exercised with curl:

| Request | Response | Status |
| --- | --- | --- |
| `GET /health` (no config) | `{"ok":true,"configured":false}` | 200 |
| `POST /chat` **without** a token | `{"error":"Missing or invalid X-Buddy-Token"}` | 401 |
| `POST /chat` with token, no config | `{"error":"Run setup to add your API key","needsSetup":true}` | 500 |
| `POST /setup` missing `baseUrl` | `{"ok":false,"error":"baseUrl is required …"}` | 400 |
| `POST /setup` valid | `{"ok":true}` | 200 |
| `GET /health` (after setup) | `{"ok":true,"configured":true}` | 200 |
| `GET /health` with `Origin: https://evil.example` | `{"error":"Origin not allowed"}` | 403 |
| `POST /nope` | `{"error":"No route for POST /nope"}` | 404 |
| `POST /tts` with blank text | `{"error":"text is required"}` | 400 |
| `POST /asr` with empty audio | `{"error":"audio (base64) is required"}` | 400 |

The config file was written to the configured directory with a trailing slash stripped from
`baseUrl`, and the key never appeared in any response or log line.

**The SDK config lookup was specifically confirmed.** `POST /chat` with the dummy key returned the
provider's own `401 … code 1002`, which proves `ZAI.create()` found `.z-ai-config` in the *external*
config directory (not the working directory) via the scoped `chdir`, and that the request reached
`https://api.z.ai/api/paas/v4/chat/completions` for real.

### 4. Electron windows

Both paths were launched and screenshotted on a real Windows desktop:

- **First run, no config** → the standalone setup window appears on its own, transparent and
  frameless, with the orb, both inputs and the gradient save button. The panel is still hidden at
  this point, which is exactly why setup needs its own window.
- **With a config present** → the orb window (80×80) and the panel window (420×620, hidden) are both
  created. Confirmed via the Win32 window list, and the orb was visually confirmed rendering
  transparently on top of another application.
- **Clicking the orb** opened the panel positioned just below it, with the header, status line,
  greeting message, and composer all rendering correctly. When there was no room below, the panel
  flipped above the orb and clamped inside the work area as designed.
- **A full chat round-trip** was driven through the real UI (synthetic click, typed text, Enter). The
  user bubble rendered right-aligned, the request passed the token check, and the provider's 401 came
  back into a rose-tinted error bubble with the status flipping to `offline`.
- **Orb position persistence** works — `buddy-state.json` was written with the orb's coordinates and
  restored on the next launch.
- **Abandoning setup ends the run.** The setup window is frameless, so a dismiss button was added
  during review — without one, a user who didn't want to continue had only Alt+F4. Clicking it closes
  the window and the app exits with no orphaned processes.
- **No renderer console errors, load failures or preload errors** were reported by the diagnostics
  hooks in any run.

### 5. The one substituted check

`npx electron-builder --linux AppImage` **was not run**, because this is a Windows host and building
a Linux AppImage from Windows needs Docker or a Linux machine. The Windows equivalent was built
instead and it succeeded:

```
npx electron-builder --win nsis  →  exit 0
dist/Buddy Setup 1.0.0.exe            76,386,745 bytes
dist/Buddy Setup 1.0.0.exe.blockmap       81,014 bytes
```

Two things about that build are worth recording:

- **`asarUnpack` works.** `z-ai-web-dev-sdk` landed in
  `resources/app.asar.unpacked/node_modules/z-ai-web-dev-sdk/dist/`, outside the archive.
- **The exe metadata is correctly branded** (`ProductName: Buddy`, `FileVersion: 1.0.0`), so `rcedit`
  ran properly.

**The packaged app was then launched and driven through a full chat round-trip.** This matters more
than the source-tree run, because packaging is where asar paths and ESM resolution usually break. The
packaged build served its renderer over the `buddy://` scheme from inside the asar, started its
server on an assigned port, found the config in `userData`, dynamically imported the ESM SDK from
`app.asar.unpacked`, and reached the live provider endpoint. Only the dummy key failed.

> One local snag worth knowing about if you rebuild on Windows: electron-builder's `winCodeSign`
> bundle contains macOS symlinks, and extracting it fails without symlink privileges
> (`A required privilege is not held by the client`). Working around it once by extracting
> `winCodeSign-2.6.0.7z` into
> `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` with `-xr!*.dylib` fixes it
> permanently. Enabling Windows Developer Mode also fixes it. CI is unaffected.

### 6. Landing page

Loaded `docs/index.html` in a real browser engine and inspected the result:

| Check | Result |
| --- | --- |
| Console errors / failed requests | **none** |
| Download button href | `https://github.com/your-github-username/buddy/releases/latest` |
| Hero, nav "Demo" and footer links | all resolve to the repo or `/releases/latest` |
| OS detection | relabelled the button "Download for Windows" |
| Feature cards / steps | 4 / 3, as specified |
| Footer pinned to the bottom | yes |
| Horizontal overflow at 1280px and at 390px | none in either |
| Mobile nav collapses to a toggle at 390px | yes |
| "No indigo, no blue" | **enforced by inspection** — every computed `color`, `background-color` and `border-color` on every element was checked for a blue-dominant channel. Zero hits. |

A robustness bug was found and fixed here: the scroll-reveal animation left above-the-fold content at
`opacity: 0` if the transition never got a chance to run. The hidden starting state is now scoped to
a `.js` class and above-the-fold elements are shown immediately, so the page is fully readable even
if scripting is slow, throttled or disabled entirely.

---

## Local providers and saved chats

Added after the first round: each capability can now run locally, and conversations persist to disk.

### Server side — 38 assertions, all passing

Verified against stub servers speaking the **real** Ollama and OpenAI-transcription wire protocols,
because neither Ollama nor a Whisper server is installed on this machine.

| Area | Confirmed |
| --- | --- |
| Provider switching | `/settings` accepts all three capabilities, reports `fullyLocal: true`, and lists no cloud capabilities |
| Configured without a key | Local mode reports `configured: true` with no `.z-ai-config` present at all |
| Ollama chat | Correct model, `stream: false`, system prompt first, and reply read off `.message.content` |
| Context growth | Turn two sent 4 messages where turn one sent 2 — history is fed back as context |
| System voice | `/tts` returns `{ mode: 'system', text, voice }` rather than audio, so nothing goes over the network |
| Local transcription | Clip posted as a genuine multipart file with a `clip.webm` filename; transcript read back |
| Provider probe | Ollama reported reachable with its model list; Whisper reachability detected |
| Persistence | Conversation written to `chats/<uuid>.json` with timestamps; title derived from the first message |
| Rename / delete / clear | All work, and removal takes the file off disk |
| **Survives a restart** | A **second process** read the conversations back off disk with titles, messages and replies intact |
| Guards | Non-UUID ids 404; `..%2F..%2Fsecret` traversal in an id refused; history needs the token; wrong method gives 405 not 404 |

### The app, driven for real

A stub was bound to Ollama's **actual default port** (`127.0.0.1:11434`) so the real discovery path
was exercised, then the app was driven with synthetic clicks and keystrokes:

- **First-run setup** offers both modes. Selecting *On this machine* probed the local stack live and
  reported “Ollama is running with 3 models”, listed those models, and found **3 offline system
  voices** (`localService: true`) with no configuration.
- **The privacy copy is generated from the actual choices**, not hardcoded. With hearing off it reads
  “Nothing leaves this machine, and with voice input off Buddy never opens your microphone.” Choosing
  z-ai hearing changes it to name exactly what gets sent.
- **Saving wrote the expected `buddy-settings.json`** (`chat: ollama/llama3.2:latest`, `tts: system`,
  `asr: off`) and started the orb and panel.
- **Two full conversational turns went through the local model.** The stub logged
  `model=llama3.2:latest messages=2` then `messages=4`, proving both dispatch and context growth. The
  replies rendered with markdown bold and bullet lists.
- **The OS voice really spoke.** The panel header showed `speaking` with the equaliser animating,
  which on the system-TTS path only happens inside `speakWithSystemVoice` — the renderer path, no
  network involved.
- **The history drawer listed both conversations** newest-first with times and message counts, the
  current one highlighted, plus the save toggle and delete-all control.
- **Clicking an older conversation reopened it exactly as it was**, all four messages with markdown
  intact.
- **With hearing off the mic button is disabled**, visibly dimmed against the same button in cloud
  mode, and the wake word does not open the microphone at all.

### Extra checks not in the spec

- **Markdown renderer and wake-phrase matcher — 38 assertions, all passing.** Covers bold, italics,
  inline and fenced code, lists, links, paragraphs and line breaks; HTML escaping (`<img
  onerror=…>`, `<script>`) and rejection of `javascript:` URLs; plus 10 wake phrases that must match
  ("hey body", "hey butty", "ok buddy", …) and 6 that must not ("send this to everybody", "the quick
  brown fox", …).
- **Two real bugs were caught by verifying rather than assuming:**
  1. `registerIpc()` pulled in `server.js` *before* `BUDDY_TOKEN` was set, so the server generated a
     different token than the one handed to the renderer — every `/chat`, `/tts` and `/asr` call
     would have returned 401. Fixed by setting the environment before anything requires the module.
  2. The speaking equaliser was permanently visible, because an author `display: flex` rule outranks
     the user-agent rule for `[hidden]`. Fixed with an explicit `.equalizer[hidden]` rule.

---

## What could not be verified here

These need a real key, a live microphone, or another operating system. They are **untested**, not
known-broken.

**Needs a real Ollama / Whisper install**

- Buddy's client code is verified against the documented wire protocols, but no **real** Ollama or
  Whisper server has answered it. The stubs return the right shapes; a real model could differ in
  ways stubs cannot reveal — chiefly response latency (a slow first token on a cold model) and
  whether a given Whisper build accepts webm/opus directly or needs ffmpeg present.
- Actual model quality, memory use and speed on this hardware are unknown.
- The `whisper` transcription path has never seen genuine audio, only a 2 KB buffer of filler bytes.

**Needs a real z-ai API key**

- A successful `/chat` reply, and the reply rendering through the markdown path.
- `/tts` returning audio, the `<audio>` playback, and the equaliser animating during speech. The
  response handling covers both a raw audio body and a JSON body carrying base64, because the
  provider's exact non-streamed response shape could not be observed.
- `/asr` returning a transcript. The transcript is read from `.text` per the SDK's own documented
  example, with fallbacks for `.transcript`, `.result`, `.data.text` and a `segments` array.
- Whether `https://api.z.ai/api/paas/v4` is the right `baseUrl` for **all three** services. Chat is
  confirmed to exist at that base; `/audio/tts` and `/audio/asr` were never reached with a valid key.
  The setup screen makes `baseUrl` an editable, required field for exactly this reason.

**Needs a live microphone**

- The wake word end to end: noise-floor calibration, the sustain/hang thresholds, the 1.5s rate
  limit, the 2.5s cooldown, the `"Yeah?"` acknowledgement, and the emerald ring/dot indicators.
- The panel's mic button recording, transcribing and auto-sending.
- The mic-denied path *was* exercised incidentally — `getUserMedia` failed in one run, and Buddy
  correctly flashed red, showed a "Mic blocked" toast, turned the wake word off and synced the tray
  checkbox. That path is confirmed; the success path is not.

**Needs macOS or Linux**

- `app.dock.hide()`, the menu-bar item, and `NSMicrophoneUsageDescription` actually being honoured.
- The `.dmg` and `.AppImage`/`.deb` builds.
- The Linux transparency fallback. The heuristic (compositing desktop → transparent, otherwise an
  opaque rounded window) is implemented and overridable with `BUDDY_TRANSPARENT=0|1`, but it has only
  been exercised on Windows, where transparency is always available.
- The tray icon's appearance as a macOS template image.

**Needs signing certificates**

- The Gatekeeper and SmartScreen prompts, and whether the documented workarounds land as written.
  The builds are unsigned by design, so the warnings are expected.

**Needs a configured GitHub repo**

- `.github/workflows/release.yml` has never run. It cannot, until `owner`/`repo` are filled in
  (three places, listed in the README) and a `v*` tag is pushed.
- GitHub Pages serving `docs/`. The directory layout is the zero-config one, but Pages has not been
  switched on.
- Consequently there is **no published release and no `v1.0.0` tag** — the locally built
  `Buddy Setup 1.0.0.exe` is the deliverable installer for now.
