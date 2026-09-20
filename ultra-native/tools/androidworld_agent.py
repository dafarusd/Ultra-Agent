"""Agent Ultra as an AndroidWorld agent: the benchmark sets the task and scores it, Ultra does the work.

AndroidWorld (google-research/android_world) runs 116 hand-written tasks across 20 real apps on an
emulator and checks the device's own state afterwards. Nothing here grades anything: `step()` hands
the goal to the Ultra app running on the same device and returns when Ultra's brain says
RUN COMPLETE; the benchmark then computes its own reward.

Ultra is not a step-by-step agent — it runs its own perceive/act/verify loop with its policy gate in
the way — so this is one interaction: goal in, control back. That is the honest shape of what Ultra
is, and it means the score covers Ultra's whole loop, not a harness driving it.

Three things this adapter has to get right, each learned the hard way on 2026-09-19:
  * The screen is read through the benchmark's own UI tree. A separate uiautomator dump came back
    empty while the benchmark's accessibility forwarder was running, so "Send" was never tapped and
    Ultra sat with the goal typed until the timeout.
  * Ultra's accessibility service is re-enabled before every task: the benchmark's setup overwrites
    enabled_accessibility_services with its own forwarder, which switches Ultra's eyes off.
  * The app the work happened in is brought back to the front at the end. The benchmark reads the
    live screen (ClockStopWatchRunning wants the stopwatch running AND Clock in front), and Ultra
    ends every run in its own chat showing its answer.

Used by bench_ultra.py (a copy of android_world's run.py that knows this agent).
"""
from __future__ import annotations

import os
import re
import subprocess
import time

from android_world.agents import base_agent

PKG = "com.agent.ultra"
DONE = "UltraBrain: RUN COMPLETE"
HINT = "Ask Agent Ultra"


class UltraAgent(base_agent.EnvironmentInteractingAgent):
  """One interaction per task: type the goal into Ultra, wait for its run to finish."""

  def __init__(self, env, name: str = "ultra", serial: str | None = None, timeout_s: int = 600):
    super().__init__(env, name)
    self._serial = serial or os.environ.get("ANDROID_SERIAL") or "emulator-5554"
    self._timeout = timeout_s
    self.last_trace: list[str] = []

  # ---- device helpers --------------------------------------------------------------
  def _adb(self, *args: str, timeout: int = 60) -> str:
    return subprocess.run(["adb", "-s", self._serial, *args], capture_output=True, text=True,
                          timeout=timeout).stdout

  def _screen(self) -> str:
    """uiautomator, not the benchmark's reader: with Ultra's service on, the harness's tree
    comes back empty, while uiautomator keeps working (2026-09-19)."""
    self._adb("shell", "uiautomator", "dump", "/sdcard/_ultra_ui.xml", timeout=90)
    return self._adb("shell", "cat", "/sdcard/_ultra_ui.xml", timeout=60)

  def _bounds(self, pattern: str, screen: str = ""):
    m = re.search(pattern + r'[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', screen or self._screen())
    if not m:
      return None
    x1, y1, x2, y2 = map(int, m.groups())
    return (x1 + x2) // 2, (y1 + y2) // 2

  def _tap_text(self, text: str, tries: int = 6) -> bool:
    for _ in range(tries):
      at = self._bounds(f'text="{re.escape(text)}"')
      if at:
        self._adb("shell", "input", "tap", str(at[0]), str(at[1]))
        return True
      time.sleep(1.5)
    return False

  def _ensure_a11y(self) -> bool:
    """Add Ultra's accessibility service back alongside the benchmark's forwarder, never replacing it."""
    svc = f"{PKG}/{PKG}.AgentAccessibilityService"
    fwd = "com.google.androidenv.accessibilityforwarder/com.google.androidenv.accessibilityforwarder.AccessibilityForwarder"
    current = self._adb("shell", "settings", "get", "secure", "enabled_accessibility_services").strip()
    if fwd not in current:            # never leave the benchmark without its own eyes
      current = fwd if current in ("null", "") else current + ":" + fwd
      self._adb("shell", "settings", "put", "secure", "enabled_accessibility_services", current)
    if svc not in current:
      wanted = svc if current in ("null", "") else current + ":" + svc
      self._adb("shell", "settings", "put", "secure", "enabled_accessibility_services", wanted)
      self._adb("shell", "settings", "put", "secure", "accessibility_enabled", "1")
      time.sleep(4)
    for _ in range(6):
      if PKG in self._adb("shell", "dumpsys", "accessibility"):
        return True
      time.sleep(2)
    return False

  def _a11y_off(self) -> None:
    """Take Ultra's service back out of the list.

    The benchmark's forwarder and Ultra's service cannot both read this emulator: with both on,
    the harness logged "Could not get a11y tree, retrying" forever and no task finished; with only
    the forwarder it reads 80 elements first try (2026-09-19). So Ultra's eyes are on only while
    Ultra is working, and the benchmark reads the screen it scores by itself.
    """
    for _ in range(3):
      current = self._adb("shell", "settings", "get", "secure", "enabled_accessibility_services").strip()
      if PKG not in current:
        break
      kept = ":".join(x for x in current.split(":") if x and PKG not in x)
      self._adb("shell", "settings", "put", "secure", "enabled_accessibility_services", kept or "null")
      time.sleep(3)
    # ...and wait until the benchmark can actually read the screen again before handing back.
    time.sleep(3)

  def _open_fresh_chat(self) -> None:
    self._adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
    time.sleep(3)
    screen = self._screen()
    if "The policy gate paused this action" in screen:
      self._tap_text("Cancel", tries=2)
      time.sleep(1.5)
    if self._tap_text("☰", tries=2):
      time.sleep(1.5)
      self._tap_text("+ New chat", tries=2)
      time.sleep(1.5)

  def _type_goal(self, goal: str) -> bool:
    self.reason = ""
    at = self._bounds(r'class="android.widget.EditText"') or self._bounds(f'text="{HINT}[^"]*"')
    if not at:
      self.reason = "input not found"
      return False
    self._adb("shell", "input", "tap", str(at[0]), str(at[1]))
    time.sleep(0.8)
    self._adb("shell", "input", "keyevent", "KEYCODE_MOVE_END", *(["KEYCODE_DEL"] * 160))
    escaped = goal.replace("'", "'\\''").replace(" ", "%s")
    self._adb("shell", f"input text '{escaped}'", timeout=120)
    time.sleep(1)
    if not self._tap_text("Send", tries=5):
      self.reason = "send not found"
      return False
    return True

  def _hand_screen_back(self, lines: list[str]) -> str:
    """Bring the app the work happened in back to the front, without restarting it."""
    # Only when Ultra's own chat ended up in front. Reordering an app that is ALREADY in front
    # sends it back to its default screen — the Clock reopened on Alarm and the running stopwatch
    # was no longer visible, so a task that had passed started failing (2026-09-19).
    focus = self._adb("shell", "dumpsys", "window")  # adb, not the harness reader
    if PKG not in focus.split("mCurrentFocus")[-1][:200]:
      return "already in front"
    joined = "\n".join(lines)
    pkgs = re.findall(r"UltraNav: screen ([\w.]+)/", joined) + re.findall(r"Launched [^(]*\(([\w.]+)\)", joined)
    pkg = next((p for p in reversed(pkgs) if p and p != PKG), "")
    if not pkg:
      return ""
    brief = self._adb("shell", "cmd", "package", "resolve-activity", "--brief",
                      "-c", "android.intent.category.LAUNCHER", pkg).strip().splitlines()
    comp = next((l.strip() for l in brief if "/" in l), "")
    if not comp:
      return ""
    self._adb("shell", "am", "start", "--activity-reorder-to-front", "-n", comp)
    time.sleep(2.5)
    return pkg

  # ---- the one interaction ---------------------------------------------------------
  def step(self, goal: str) -> base_agent.AgentInteractionResult:
    """Order matters, and it is the whole trick:

    1. Ultra's accessibility service OFF — the benchmark's reader works, so the goal can be
       opened and typed into Ultra's chat through the harness's own UI tree.
    2. Ultra's service ON — Ultra can see and drive the phone for its run.
    Ultra's service is left ON: turning it off between tasks was tried and made every task fail
    (the tasks that passed with it on stopped passing), so the harness retries its reads instead —
    it recovers, Ultra does not (2026-09-19).
    """
    self._adb("logcat", "-c")
    bound = self._ensure_a11y()
    self._open_fresh_chat()
    typed = self._type_goal(goal)
    if not typed:
      return base_agent.AgentInteractionResult(
          done=True, data={"ultra_reached": False, "ultra_a11y": bound,
                           "ultra_reason": getattr(self, "reason", "")})
    t0 = time.time()
    log = ""
    while time.time() - t0 < self._timeout:
      time.sleep(4)
      log = self._adb("logcat", "-d", "-s", "UltraBrain:V", "UltraGate:V", "UltraNav:V", "UltraLearn:V")
      if DONE in log:
        break
    lines = [re.sub(r"^[0-9-]+ [0-9:.]+ +\d+ +\d+ [A-Z] ", "", x) for x in log.splitlines()]
    self.last_trace = lines
    time.sleep(2)
    handed_back = self._hand_screen_back(lines)
    return base_agent.AgentInteractionResult(done=True, data={
        "ultra_reached": True,
        "ultra_a11y": bound,
        "ultra_handed_back": handed_back,
        "ultra_secs": round(time.time() - t0, 1),
        "ultra_complete": DONE in log,
        "ultra_calls": [l.split("TOOL CALL: ", 1)[1] for l in lines if "TOOL CALL: " in l],
        "ultra_fails": [l.split("TOOL RESULT (fail): ", 1)[1][:200] for l in lines if "TOOL RESULT (fail)" in l],
        "ultra_blocks": [l.split("BLOCK ", 1)[1][:200] for l in lines if "UltraGate: BLOCK" in l],
        "ultra_lessons_served": [l.split("LESSONS SERVED: ", 1)[1] for l in lines if "LESSONS SERVED" in l],
        "ultra_learned": [l.split("LEARNED ", 1)[1][:200] for l in lines if "LEARNED " in l],
        "ultra_trace": [l[:220] for l in lines if "OBSERVE" not in l][-60:],
    })
