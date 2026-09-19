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
from android_world.env import json_action

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

  def _elements(self, wait: bool = True):
    try:
      return self.env.get_state(wait_to_stabilize=wait).ui_elements
    except Exception:  # noqa: BLE001 — a missed read is retried, never fatal
      return []

  def _find_index(self, want: str = "", editable: bool = False, tries: int = 6):
    """Index into the CURRENT element list — what execute_action(CLICK, index=…) expects."""
    for _ in range(tries):
      for i, el in enumerate(self._elements(wait=True)):
        if el.package_name and PKG not in str(el.package_name):
          continue
        if editable:
          if el.is_editable:
            return i, el
          continue
        label = " ".join(x for x in (el.text, el.content_description) if x)
        if want and want.lower() in label.lower():
          return i, el
      time.sleep(1.5)
    return None, None

  def _click(self, index: int | None, el=None) -> bool:
    if index is None:
      return False
    try:
      self.env.execute_action(json_action.JSONAction(action_type=json_action.CLICK, index=index))
      return True
    except Exception:  # noqa: BLE001 — fall back to the pixel the element sits on
      box = getattr(el, "bbox_pixels", None)
      if box is None:
        return False
      self.env.execute_action(json_action.JSONAction(
          action_type=json_action.CLICK, x=int((box.x_min + box.x_max) / 2),
          y=int((box.y_min + box.y_max) / 2)))
      return True

  def _ensure_a11y(self) -> bool:
    """Add Ultra's accessibility service back alongside the benchmark's forwarder, never replacing it."""
    svc = f"{PKG}/{PKG}.AgentAccessibilityService"
    current = self._adb("shell", "settings", "get", "secure", "enabled_accessibility_services").strip()
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

  def _open_fresh_chat(self) -> None:
    self._adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
    time.sleep(3)
    i, el = self._find_index("Cancel", tries=1)      # a gate card from the last task hides the input
    if i is not None:
      self._click(i, el)
      time.sleep(1.5)
    i, el = self._find_index("☰", tries=1)           # each task starts with no history of the last
    if i is not None:
      self._click(i, el)
      time.sleep(1.5)
      j, el2 = self._find_index("New chat", tries=2)
      if j is not None:
        self._click(j, el2)
        time.sleep(1.5)

  def _type_goal(self, goal: str) -> bool:
    """Ultra's chat box is Compose: the benchmark's tree shows it as a TextView holding the hint,
    never as an editable field, so it is found by that hint (2026-09-19)."""
    self.reason = ""
    i, el = self._find_index(editable=True, tries=1)
    if i is None:
      i, el = self._find_index(HINT, tries=4)
    if i is None:
      self.reason = "input not found"
      return False
    self._click(i, el)
    time.sleep(1)
    i2, _ = self._find_index(editable=True, tries=1)
    self.env.execute_action(json_action.JSONAction(
        action_type=json_action.INPUT_TEXT, text=goal, index=i2 if i2 is not None else i))
    time.sleep(1.5)
    j, el2 = self._find_index("Send", tries=4)
    if j is None:
      self.reason = "send not found"
      return False
    ok = self._click(j, el2)
    if not ok:
      self.reason = "send click failed"
    return ok

  def _hand_screen_back(self, lines: list[str]) -> str:
    """Bring the app the work happened in back to the front, without restarting it."""
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
    self._adb("logcat", "-c")
    bound = self._ensure_a11y()
    self._open_fresh_chat()
    if not self._type_goal(goal):
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
