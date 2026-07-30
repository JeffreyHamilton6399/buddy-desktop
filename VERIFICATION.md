# Verification report

Everything below was run on the development machine: **Windows 10 Pro (19045), Node 24.15.0**.
The spec-era checks below ran on Electron 28; everything from v1.1.0 onward ran on Electron 43, which
the built-in model requires. Where the spec's checklist assumed a Linux host, the equivalent Windows check was
run instead and is called out as such.

From v1.1.0 the default needs no key at all. The cloud-path checks below still used a **dummy key**,
because no real one was available. That still proves
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
| `POST /chat` with token, no config | `{"error":"…needs an API key…","needsSetup":true}` | 500 |
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
| Download button href | `https://github.com/JeffreyHamilton6399/buddy-desktop/releases/latest` |
| Hero, nav "Demo" and footer links | all resolve to the repo or `/releases/latest` |
| OS detection | relabelled the button "Download for Windows" |
| Feature cards / steps | 5 / 3 |
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

## v1.1.0 — the built-in model

Buddy no longer asks for anything. It carries its own brain.

### What was verified

| Check | Result |
| --- | --- |
| `node-llama-cpp` under **Electron 28** | ✗ cannot even parse it — `Unexpected token 'with'`, V8 too old for ESM import attributes |
| `node-llama-cpp` under **Electron 43** | ✓ native binding loads, generation works, Vulkan detected |
| Electron 28 → 43 regression sweep | ✓ orb, panel, tray, `buddy://` protocol, permissions, markdown, disabled mic all unchanged |
| Model download | ✓ 770 MB fetched with live progress, speed and ETA |
| **Resume** after interruption | ✓ truncated the file to 640 MB; the app resumed the last 130 MB via `Range` |
| SHA-256 verification | ✓ **caught a real mismatch** — see below |
| Inference through the module | ✓ context carries across turns, concurrent requests serialise (`APPLE`/`BANANA` never crossed), the error path rejects cleanly, the queue survives a failure, idle unload fires |
| First run, no settings, no key | ✓ downloads, verifies, writes local-only settings, starts the orb |
| Chat with the built-in model in the real UI | ✓ *"I'm Buddy, a local AI assistant…"* — with no key and no account |
| **Packaged** app, built-in model | ✓ native binary loads from `app.asar.unpacked`, replies, restores prior conversation from disk |
| Installer size | ✓ **137 MB** (CUDA and Vulkan variants excluded; they add 500 MB+) |
| First-run UI states | ✓ rendered deterministically against synthetic snapshots — see below |

### The SHA-256 check earned its keep

The first download completed all 770 MB and then **failed verification**. The cause was my own bad
constant: I had taken the expected digest from the HTTP `etag`, which on Xet-backed HuggingFace repos
is the **xetHash**, not the file's SHA-256.

| | Value |
| --- | --- |
| `etag` / xetHash — what I wrongly used | `7314cd62…` |
| `lfs.oid` from `/paths-info` — the real SHA-256 | `6f85a640…` |

The re-download passed, and the file's digest was then confirmed independently outside the app. Two
changes came out of it: the correct hash is documented in `model.js` with a warning never to use the
etag, and a failed check now renames the file to `.badhash` rather than deleting it — if that error
ever fires again it is far more likely to be a stale expected hash than corrupt bytes, and the file is
the evidence.

### First-run states, verified without racing a download

The progress screen is the entire first-run experience, so it was tested by feeding the real renderer
synthetic `/model` snapshots rather than hoping to screenshot a live download at the right moment:

| State | Rendered |
| --- | --- |
| downloading | `331 MB of 770 MB · 7.2 MB/s · about 1 minute left`, bar at `43%` |
| verifying | `Checking the download…`, bar at `100%` |
| error | `The model server returned 503`, retry button shown, bar at `27.3%` |

That last one is a fix, not just a check: the error state originally showed an **empty** bar while the
copy underneath promised "your progress was kept". The bar now shows how far it actually got.

### Honest limitations of the built-in model

- **It is a 1B model.** It holds the Buddy persona and answers simple questions well; it is not
  competent at hard reasoning, long documents or code. The README points at Ollama for anything more.
- **Windows and Linux run on CPU.** The Vulkan and CUDA llama.cpp variants are excluded to keep the
  installer at 137 MB, so the GPU acceleration seen during development (Vulkan, on this machine) is
  **not** what shipped builds use. macOS gets Metal free inside its own binary. CPU inference for a 1B
  is usable but slower than the numbers measured here.
- **First reply of a session costs ~8 seconds** while the model loads. It then stays warm for 30
  minutes.
- **Memory:** roughly 1 GB resident while loaded.

## Published state

The repo is live at **<https://github.com/JeffreyHamilton6399/buddy-desktop>** (public, `main`).

**GitHub Pages is on and serving `docs/`.** Verified against the deployed site, not just locally:
<https://jeffreyhamilton6399.github.io/buddy-desktop/> returns 200, all four assets resolve with the
right content types, zero console errors, and the JS-wired links resolve to
`https://github.com/JeffreyHamilton6399/buddy-desktop/releases/latest` on the real page.

**The release workflow lives at `.github/workflows/main.yml`** and was added through the GitHub web
UI, because the token available for pushing had `repo` scope but not `workflow` — GitHub rejects any
write under `.github/workflows/` from such a token.

**`v1.1.0` is the current release** (v1.0.0 remains, key-based). Installers for all three platforms, built by that workflow on three
runners in parallel:
<https://github.com/JeffreyHamilton6399/buddy-desktop/releases/tag/v1.1.0>

| Asset | Size |
| --- | --- |
| `Buddy-Setup-1.1.0.exe` | 136 MB |
| `Buddy-1.1.0-arm64.dmg` | 154 MB |
| `Buddy-1.1.0.dmg` | 156 MB |
| `Buddy-1.1.0.AppImage` | 172 MB |
| `buddy_1.1.0_amd64.deb` | 140 MB |

Verified end to end, unauthenticated: `/releases/latest` returns a 302 to the `v1.1.0` tag (so the
landing page's download button resolves), every asset returns 200, and range requests return correct
file magic — `4d5a` (MZ) for the exe, `78da` (zlib) for the dmg, `213c` (`!<arch>`) for the deb, and `7f45` (ELF) for the AppImage. All five assets on v1.1.0 checked.

### Two bugs the first release run caught

The first `v1.0.0` attempt failed on two of three runners. Both were real defects that only a genuine
multi-platform build could surface, and both are fixed — the second run went 3/3.

1. **macOS: the icon was too small.** The spec specified 256×256; electron-builder refuses to generate
   a macOS `.icns` from anything under 512×512 and failed with *"must be at least 512x512"*. Windows
   and Linux accept 256, so this broke exactly one of three platforms. `make-icon.js` now emits
   1024×1024, and the `.icns` conversion that previously failed was confirmed working locally.
2. **Linux: missing `.deb` metadata.** The AppImage built fine, then `dpkg` rejected the deb —
   electron-builder will not guess `homepage` or `maintainer`. Both are now set explicitly, with the
   maintainer using a GitHub `users.noreply` address since that field is embedded in the package and
   publicly readable.

A false lead worth recording: `app-builder` appeared to reject the hand-written PNG while accepting a
Chromium-encoded one. Testing both files from both a relative and an absolute path showed the flip was
**path form, not file content** — Chromium's PNG was rejected too when passed relatively. The icon was
always valid, and an IDAT-chunking change made on that wrong assumption was reverted.

### Still outstanding

- **The installers have never been executed.** The packaged app was launched from
  `dist/win-unpacked/`, but `Buddy-Setup-1.0.0.exe` was never run, so the NSIS install flow —
  shortcuts, Start Menu entry, uninstall — is **unverified**. Nothing on macOS or Linux has been run
  at all.
- **`.deb` installs get a generic menu icon.** electron-builder reports `size: 0` for a single-file
  Linux icon and installs it to `hicolor/0x0/apps/`, which desktop environments ignore. This is stock
  electron-builder 24 behaviour; fixing it means restructuring into a `build/icons/` set. AppImage is
  unaffected.
- **Auto-update is not wired up**, despite the `latest*.yml` files electron-builder publishes.

---

## v1.2.0 — Buddy's own voice and ears, and a settings panel

Four complaints drove this round: the voice was bad, there was no way to choose a model, the header
"didn't give a feel or sense of anything", and the orb showed a square ring. All ran on **Electron 43
/ Node 24.15.0, Windows 10 Pro (19045)**.

### The choices were measured, not guessed

Everything about which model to ship was decided by running them on this machine rather than by
reading model cards. Kokoro, synthesizing the same phrase, warm:

| Weights | On disk | Speed | Verdict |
| --- | --- | --- | --- |
| q8 | 88 MB | **0.9× realtime** | unusable — generates slower than it plays, so Buddy falls further behind the longer it talks |
| fp16 | 156 MB | 2.4× | **shipped** |
| q4 | 291 MB | 2.4× | no smaller than fp32 in practice |
| fp32 | 310 MB | 2.6× | twice the disk for 8% more speed |

Through the real `/tts` endpoint, warm and with the ack cache bypassed, fp16 held **1.7–1.9×
realtime** — enough that chunked playback stays ahead of itself. DirectML was tried for both models
and **fails on Kokoro** (`ConvTranspose` unsupported by the DML provider), so both run on CPU.

Whisper, transcribing four phrases spoken by two different Kokoro voices:

| Model | On disk | Load | 4 clips | Accuracy |
| --- | --- | --- | --- | --- |
| **tiny.en** | 39 MB | 0.85s | 2.26s | all four correct |
| base.en | 73 MB | 8.4s | 3.47s | all four correct |

tiny.en is half the size and about 1.5× faster for the same result, so it ships. Wake-word checks run
constantly, which makes the cheap one the right one.

### End to end, through the real endpoints

Kokoro was made to speak a phrase and Whisper to read it back, both through the running server:

```
said:  "Hey Buddy, remind me to water the plants tomorrow morning."
heard: "Hey buddy, remind me to water the plants tomorrow morning."
contains "hey buddy": true
```

### Four bugs found by running it

1. **Silence transcribed as words.** Two seconds of digital silence came back from Whisper as `"you"`
   — a documented hallucination, and the single most common input for an always-listening orb, which
   would have had Buddy answering questions nobody asked. Bracketed sound effects *and* a set of known
   stock phrases are now discarded. Re-checked after the fix: digital silence, faint hiss and a 50 ms
   blip all return empty.
2. **Speech started far too late.** The first chunk of a reply was up to 240 characters — about three
   seconds of synthesis before the first word. Chunks are now ~150 characters and the *first* is capped
   at 70, so speaking starts in about a second. List items also ran together (`"the ocean is large it
   is salty"`) and now get terminal punctuation so the voice pauses.
3. **A first-run loop that could never end.** Setup wrote only `chat.provider` on finishing, so an
   install whose `tts`/`asr` pointed at the cloud kept them — and cloud capabilities with no API key
   never count as configured, so setup reopened on every launch, forever. Hit accidentally while
   testing, which is how it was found. Setup now writes all three providers explicitly.
4. **A BOM in `buddy-state.json` silently reset the orb.** `JSON.parse` throws on a leading byte-order
   mark and the catch treated it as a first run, losing the saved position. Nothing Buddy writes has
   one; an editor might. Now stripped.

### Verified by driving the real app

The app was launched and driven with synthetic mouse input on a real desktop, and screenshotted:

- **The square ring is gone.** Confirmed against a zoomed screen capture: the halo fades smoothly into
  the desktop with no rectangular edge.
- **Clicking the orb opens the panel.** `travelled=0.0px` was measured on mousedown/mouseup, and the
  orb held its position exactly across repeated clicks — the click-versus-drag split works.
- **Position migration works.** An install saved at `1374,174` with the old 80px window reopened at
  `1340,140` with the 128px one, leaving the visible circle in the same place on screen.
- **Settings opens from the identity** and all five panes render: the model catalogue with sizes and an
  "Answering now" badge, 28 Kokoro voices, the hearing controls, chats, and an About pane that reports
  each job as "on this machine".
- **Chat works with the local model.** "name three colours" → "Red, Blue, Green.", with
  `model loaded in 8.2s (0.74 GB, vulkan)` and `voice ready in 1.4s (Kokoro fp16)` in the log.
- **The packaged build works.** `electron-builder --win --dir` produced a 577 MB app whose voice list
  populated and whose "Hear it" preview succeeded — proving transformers.js, `onnxruntime-node` and
  `kokoro-js` all load from `app.asar.unpacked`. Only win32 ONNX binaries were included; the darwin and
  linux sets (141 MB) were pruned.

### An approach tried and abandoned

The orb window was first made 148px with the surplus set click-through via
`setIgnoreMouseEvents(true, { forward: true })`, so it would not swallow clicks meant for windows
underneath. It was **removed after testing**: it depends on Electron forwarding mouse-move messages to
decide when to become solid again, that forwarding did not arrive reliably here, and the failure mode
is an orb that **cannot be clicked at all** — verified, twice, with no `mousedown` reaching the
renderer. The window is now 128px, always interactive, and every animation is sized to fit inside it.
The cost is an invisible 128px square that captures clicks where 80px used to; that is the same class
of behaviour as before, and it always works.

### What could not be verified here

- **The wake word has never been triggered by a real voice.** This machine has **no active microphone**
  — the only input device is a disconnected Bluetooth headset — so `getUserMedia` fails with
  `NotFoundError`. Buddy handles that correctly and visibly (it turns the wake word off, tells the tray,
  and shows "Mic blocked" on the orb), and every stage *after* audio capture is verified: the detector's
  maths, `/asr` on real speech, the fuzzy phrase matcher, and the greeting. But the live path —
  AudioWorklet → voice detection → clip → wake — is **untested end to end**, including the
  pre-roll buffer that is supposed to stop the leading "Hey" being clipped. This is the biggest gap in
  this release.
- **Nothing was heard.** No audio output was captured, so the *quality* of the Kokoro voice is
  unjudged. What is verified is that it produces well-formed 24 kHz wav audio of the expected length,
  at a speed that keeps ahead of playback.
- **`system` and `z-ai` speech paths were not re-run** after the refactor; only the two in-app engines
  were exercised.
- **No installer was built or run** — only `--dir`. macOS and Linux were not built at all, so the
  per-platform ONNX pruning is verified only for Windows.
- **The 3B and 7B models were never downloaded.** Their sizes and SHA-256 digests come from
  HuggingFace's `paths-info` API (the same source, and the same method, that produced the 1B entry
  whose digest was independently confirmed correct by a real download). The download and checksum code
  is shared with the 1B model, but these four entries have not each been fetched and verified.
- **`sharp` is shipped but never used.** transformers.js imports it statically for image pipelines
  Buddy has no use for, costing ~20 MB and carrying libvips CVEs that no Buddy code path can reach.
  It cannot be excluded without patching the dependency.

---

## v1.2.2 — answering at the orb, and where the slowness actually was

### "The AI is slow" was not the model

Measured through the running server before changing anything:

| | Before | After |
| --- | --- | --- |
| First message of a session | **11.94s** | **0.49s** |
| Any later message | 0.08–0.14s | 0.08–0.17s |
| First spoken word of a reply | 3.45s | 1.24s |

Generation was never the problem — the 1B model on Vulkan answers at 36–58 words per second, which is
faster than the speech can be played. Almost all of the 11.9s was llama.cpp loading the model, and
most of the rest was Kokoro loading on its first use. Both now load at startup, in the background,
while nobody is waiting: the log reports `warm and ready in 14.7s` and the first real question is
answered in half a second.

The orb also asks the server to warm up the moment it hears its name, which overlaps any reload with
the second or so of greeting it speaks back.

### The full spoken round trip

Kokoro was used to speak questions in a different voice, which Whisper then transcribed, so the whole
loop ran through the real endpoints:

```
asked : "What is the capital of Peru?"
heard : "What is the capital of Peru?"
reply : "The capital of Peru is Lima."
timing: hear 0.73s + think 0.40s + speak 1.13s = 2.27s to the first spoken word
```

Two of the three test questions came back verbatim. The third exposed a real defect: a clip Whisper
found no words in produced an empty message, which reached the model and threw *"There was no user
message to reply to"* as a 500. `/chat` now answers 400 with `empty: true` instead, and the orb
treats it as "heard nothing" and goes back to waiting.

### What could not be verified, again

**The wake word still has not been triggered by a real voice** — this machine has no working
microphone, so the orb cannot reach any of its listening states here and the green ring, the question
window and its seven-second timeout have never been seen on screen. Everything either side of the
microphone is verified: transcription, the phrase matcher, the chat call, the shortened spoken reply,
and the speech. The state machine between them is not.

What was checked in the app: it launches, warms all three models, logs no errors, and clicking the orb
still opens the panel — the click and drag path survived the rewrite.
