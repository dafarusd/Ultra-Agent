# Cold review — 2026-08-29

Produced by a reviewer given **no history with this codebase**: it did not know who
wrote it, what was recently changed, or what anyone was proud of. That is the
point. Several findings land directly on work done the same day it was written.

**This file is the standing work order.** Items are struck through only when the
fix is proven on a device, not when the code compiles.

---

## The order of work, decided 2026-08-29

1. **Safety first — the gate hole and the concurrency bug.** Everything else on
   this list makes the agent act *more* autonomously. An agent that acts more
   autonomously through a gate that can fail open is worse than one that does
   less. Nothing else starts until F1 and F2 are closed.
2. **Learn by watching** (L1) — roughly 90% already written, and it changes what
   the product is rather than what it can do.
3. **Provenance everywhere** (L3) — the only version of "safe" that survives the
   model being wrong.

---

## ~~F1 — The gate can authorize one app while the action lands in another~~ FIXED, PROVEN 2026-08-29

> Closed. Proven on the phone by intruding a disallowed app into a running
> navigation: 2 x `GATE: BLOCKED pkg=com.sec.android.app.clockpackage` against
> 14 x `GATE: PASSED pkg=com.android.chrome`. `performImeAction` is gated.
> Back and Home stay ungated deliberately — they are how the agent leaves.

`checkPackageAllowed()` (`AgentAccessibilityService.java:853`) decides against the
field `currentPackage`, set from event history (`:192`). **The code's own comments
admit that field goes stale.** Every *action*, meanwhile, resolves its target from
the live window: `clickByIndex` → `targetWindowRoot()` → `topmostWindowRoot()`
(`:490`, `:555`), and `performTap(x,y)` (`:872`) fires absolute coordinates lifted
from a dump of that same topmost window.

**So the gate can PASS on a stale but still-allowed package while the tap executes
in a different foreground app. The security boundary fails open.**

`performImeAction()` (`:1093`) has **no `checkPackageAllowed()` call at all** — it
finds any editable field in any window and submits, or dispatches a raw gesture on
the keyboard's Enter key (`:1180`), entirely outside the gate.

> Note for whoever fixes this: the 2026-08-29 session made the *read* path stop
> treating the keyboard as the foreground app and called the safety model proven.
> That was true of reads and false of writes. The fix was real and incomplete, and
> it was reported as complete.

## ~~F2 — Native generation is not thread-safe~~ FIXED, RACE NOT REPRODUCED 2026-08-29

> Generation serialised on a coroutine Mutex, handle read inside the lock,
> `unload()` waits for work in flight, JNI ref released by an RAII guard on
> every path. **The original race was never reproduced and then shown gone** —
> it needs a voice command landing inside a streaming reply. Correct by
> construction is not the same as verified.

`LocalModelEngine`'s header claims "a lock guards the native context"
(`local/LocalModelEngine.kt:10`). The lock wraps only `ensureLoaded` (`:152`) and
`unload` (`:184`). **`generate()` (`:166`) calls `nativeGenerate` with no lock.**

The JNI side uses process-global `gVm/gCallback/gOnToken` (`cpp/ultra_llm.cpp:22-24`)
with no mutex. Two independent scopes drive the shared engine — chat
(`ChatScreen.kt:206,385`) and voice (`VoiceActivity.kt:109`). One voice command
during a chat reply stomps the global callback refs and re-enters a non-reentrant
`llama_context`.

- `unload()` frees the context with no coordination against an in-flight
  `nativeGenerate` → use-after-free.
- **JNI global ref leak:** minted at `ultra_llm.cpp:102`, but the prompt-decode
  failure returns `-4` at `:110`, *before* the `DeleteGlobalRef` at `:133` — leaks
  the ref and leaves `gCallback` dangling non-null for the next call.

## F3 — Model text → action parsing aborts the whole run

`Brain.parseToolCall` (`agent/Brain.kt:640`) counts braces **without honouring
string literals**; any param value containing `{` or `}` miscounts and the call
silently degrades to "final text". The navigator matches typed text with `[^)]`
(`ReActNavigator.kt:382`, `:405`), so any string containing `)` is truncated.
`extractAction` returns null on an unanchored line → `NavResult(false, "model gave
no parseable action")` kills the entire 15-step run. **One chatty sentence from a
1B model ends the task.**

## F4 — The taint gate is blind to the UI-driving path, and matches by substring

`episode.observeSecrets()` runs on tool *result strings* (`Brain.kt:561`), but
`react_navigate` returns only a short summary (`Tools.kt:105`). **The screen text
the navigator reads, and the text it types into other apps, never enter the
episode.** A secret read on screen can be typed into any allowed app with no taint
enforcement.

`mintOrigin` (`gate/Gate.kt:58`) is pure substring, so short or common args are
trivially "user-traceable". `findSecrets` (`gate/Origins.kt:12-20`) only recognises
40+ char hex/base64/`sk-`: **a 4–6 digit OTP is never secret-shaped**, while the
notification logger redacts at 20+ chars (`AgentAccessibilityService.java:215`).
Two subsystems disagree on what a secret is.

## F5 — Accessibility node lifecycle leaks, and two walkers disagree

`collectInFlatOrder` — the click-resolution path (`:615`-`:625`) — never recycles
the nodes it walks, so **every `clickByIndex` leaks nodes**. `getForegroundPackage`
recycles none (`:310`, `:319`). `flattenNode` has **no** node cap while
`collectInFlatOrder` aborts at 1200 (`:619`), so on a dense screen the model can be
shown a valid index that `clickByIndex` reports as `"gone"` — directly under a
comment promising "the same order … so an index means the same node" (`:612`).

**Two catches hide real failures:** `performImeAction` dispatches with a null
callback and unconditionally sets `result = true` (`:1180`-`:1185`) — success it
never verified. The `screenshot` tool returns "Screenshot taken — saved to the
device gallery" (`Tools.kt:76`) from a boolean that only means *dispatched*; **the
image is never captured.**

---

## What the design cannot do — walls, not missing features

- **One task at a time, ever.** Shared native context, process-global
  `ActionGate.waiter` (`agent/ActionGate.kt:37`), global `currentPackage`, no run
  queue. Chat and voice each hold their own `pendingConfirm`, so a confirmation
  raised in voice is invisible to chat.
- **Blind to pixels.** Perception is 100% the accessibility tree. Canvas, WebGL,
  games, video, DRM and custom-drawn surfaces are absent from every observation.
  The screenshot path throws the bitmap away (`:1204`). Vision is a parallel
  perception stack, not an addition.
- **Cannot address large or off-screen structure.** Capped 1200/3000, filtered by a
  hardcoded `y in 0..2400` (`ReActNavigator.kt:317`), presented as at most 20/5/3
  (`:365`). The 30th list item is unreachable *before the model ever sees it*.
- **No policy richer than "does this string appear in the request."** The whole
  navigator is a single manifest tool, so the gate cannot see or constrain the
  hundreds of taps and text entries it performs.

---

## Latent capabilities — already almost there

### L1 — A complete cross-app behavioural stream, collected and thrown away
`onAccessibilityEvent` already records every click (text + content-desc), every
notification and every window change **across every app**, token-redacted, into
`pendingA11yLogs` (`:96`-`:260`). **`drainPendingLogs()` (`:106`) has no caller
anywhere in the codebase.** The hard part — capturing labelled, redacted, cross-app
interaction events — is done and running. Only the reader is missing.

→ *Do a task once. It watches. It never needs the model for that task again.*

### L2 — A persistent, content-stable map of every app's UI, used for almost nothing
`ScreenSignature` already fingerprints a screen independently of its content;
`ScreenControls` accumulates roles and view-ids per screen, unioned app-wide, in
Room. Today this drives exactly one thing: which text box to focus
(`ReActNavigator.kt:549`). It is already enough to **drive known screens with no
model call at all**, to detect when an app's UI changes, and to share macros
between installs. The `ScreenSignature` header itself laments that "the answer is
the same every time, and it is thrown away."

### L3 — A general information-flow tracker mislabelled as an argument guard
`Origins`/`OriginSet`/`TrackedArg` already carry per-value provenance and a taint
bit, applied only to a tool call's JSON args. Fed the accessibility tree — which
already exists on every step — the identical machinery stamps provenance on **every
field on screen**, and can enforce cross-app dataflow: a banking OTP physically
cannot be typed into a messaging field. The type system generalises cleanly; the
wiring stops at the tool boundary.

---

## Found while fixing, 2026-08-29 — not from the review

### ~~M1 — A short memory could claim a long request~~ FIXED
`bestShortcut` scored containment as `overlap / min(size)`, so a two-word memory
was perfectly "contained" in any longer request mentioning it. "battery level"
scored **1.0** against "check the battery level then open my banking app and pay
the bill", and the agent would be told that exact job had already succeeded with
one tool — the banking half of the sentence evaporating.

That is L1's failure mode one size smaller: a remembered thing firing on a
request that merely *contains* it. Fixed before building anything that replays
learned routines, not after. Scoring moved to `agent/TaskMatch.kt` so it can be
argued with in a test; both directions must now hold — containment, and how much
of the new request the memory actually accounts for. Six tests.

### ~~M2 — "accessibility service not running" told the user nothing~~ FIXED
Every read failure said the same unhelpful sentence. It now says which of two
states it is in and what to do about each. The second state is real and
horrible: after an update Android still LISTS the service, so its own switch is
drawn ON, while `dumpsys` reports `Bound services:{}` and nothing works. The only
cure is turning that switch off and on again, which nobody would guess from a
switch already in the right position.

**Proven for the "genuinely off" branch** — the message appeared in a real run.
The listed-but-not-bound branch is source-correct but was never observed firing;
the state kept collapsing to plain "off" before it could be caught.

### M3 — Conversation history bleeds between unrelated tasks (OPEN, defended)
A run asked to open a menu instead reached for a URL from an earlier, unrelated
task in the chat window. **The origin gate caught it** — `BLOCK open_url: domain
does not trace to the user's request` — so the defence worked and nothing
happened. Left alone deliberately: shrinking the history window would break
legitimate follow-ups ("do that again for X"), and the gate is the right layer
for this. Recorded because it will look like a new bug the next time it appears.
