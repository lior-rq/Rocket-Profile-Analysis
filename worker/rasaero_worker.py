r"""RASAero II job worker - runs INSIDE the Windows VM.

Polls a jobs folder on the shared drive (Z:\jobs) for job.json files written by
the Mac-side pipeline, drives RASAero II with pywinauto to run / export them,
and writes done.json when finished.

    python rasaero_worker.py --jobs Z:\jobs --repo Z:\            (daemon)
    python rasaero_worker.py --jobs Z:\jobs --repo Z:\ --once     (one job, then exit)
    python rasaero_worker.py --inspect Z:\output\rasaero_ui.txt   (dump the UI tree for debugging)

Job types (see rpa/jobs.py):
    rerun_save : open input -> Flight Simulation -> Rerun All -> save as result.CDX1
    export     : same, then 'View Data' on row 1 -> File > Export -> export.csv

GUI details (control names, key sequences, waits) live in worker_config.json
next to this file so they can be tuned without touching the code.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import traceback

import xml.etree.ElementTree as ET
from pathlib import Path

try:
    from pywinauto.application import Application
    from pywinauto.keyboard import send_keys
except ImportError:  # pragma: no cover - documented in worker/README.md
    print("pywinauto is required inside the VM:  python -m pip install pywinauto")
    raise

WORKER_VERSION = 36  # bump when editing; the job log shows which version ran
RELOAD_EXIT_CODE = 3  # 'restart me' for run_worker.py

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = {
    "rasaero_exe": r"C:\Program Files (x86)\RASAero II\RASAero II.exe",
    "main_title_re": "RASAero II",
    "flight_sim_button_re": "Flight Sim",
    "flight_sim_title_re": "Flight Sim",
    "view_data_title_re": "Flight Sim|Data",
    "short_delay_s": 0.6,
    "long_delay_s": 2.0,
    "sim_min_wait_s": 3.0,
    "sim_per_row_s": 0.5,
    "sim_max_wait_s": 900.0,
    "cpu_idle_threshold": 2.0,
    "view_data_right_presses": 7,
    "select_motor_file_each_job": True,
    "menu": {
        "select_motor_file": "File->Select Motor File",
        "rerun_all": "Simulations->Rerun All Simulations",
        "export": "File->Export",
    },
    "keys": {
        "rerun_all": "%{RIGHT}{DOWN}{DOWN}{ENTER}",
        "export": "%f{RIGHT}{ENTER}",
        "time_base_confirm": "{TAB}{ENTER}",
        "view_data_prefix": "^{HOME}",
    },
    "time_base_downs": {"0.01": 0, "0.1": 1, "0.5": 2, "1.0": 3},
    "save_prompt_yes_titles": ["Yes", "&Yes", "OK"],
    "save_prompt_no_titles": ["No", "&No"],
}


def load_worker_config(path: Path | None) -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    p = path or (HERE / "worker_config.json")
    if p.exists():
        user = json.loads(p.read_text())
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    return cfg


def escape_keys(text: str) -> str:
    """Make a literal string safe for pywinauto.keyboard.send_keys."""
    out = []
    for ch in text:
        if ch in "+^%~(){}[]":
            out.append("{" + ch + "}")
        else:
            out.append(ch)
    return "".join(out)


class Log:
    """Job log: written to a local file (always works) and mirrored to the
    share best-effort - the WebDAV share drops out for seconds at a time and
    a log write must never kill a job."""

    def __init__(self, path: Path | None, mirror: Path | None = None):
        self.path = path
        self.mirror = mirror

    def __call__(self, msg: str):
        line = time.strftime("%H:%M:%S ") + msg
        print(line, flush=True)
        for target, tries in ((self.path, 5), (self.mirror, 1)):
            if not target:
                continue
            for _ in range(tries):
                try:
                    with open(target, "a", encoding="utf-8") as f:
                        f.write(line + "\n")
                    break
                except OSError:
                    time.sleep(0.5)


def retry_io(fn, what: str, attempts: int = 30, delay: float = 2.0):
    """Run a filesystem operation on the share, retrying transient failures."""
    last = None
    for _ in range(attempts):
        try:
            return fn()
        except OSError as e:
            last = e
            time.sleep(delay)
    raise OSError(f"{what}: share unavailable ({last})")


class RASAero:
    def __init__(self, cfg: dict, log: Log, debug_dir: Path | None = None):
        self.cfg = cfg
        self.log = log
        self.debug_dir = debug_dir
        self.app: Application | None = None
        self.main = None
        self._shots = 0

    # ---- process ----------------------------------------------------------
    @staticmethod
    def kill_all():
        subprocess.run(["taskkill", "/F", "/IM", "RASAero II.exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def start(self):
        self.kill_all()
        time.sleep(1.0)
        self.app = Application(backend="uia").start(self.cfg["rasaero_exe"])
        self.main = self.app.window(title_re=self.cfg["main_title_re"])
        self.main.wait("visible ready", timeout=30)
        # pin the main form by handle: a title/visibility lookup fails while
        # one of RASAero's modal forms (Aero Plots, Mach-Alt) is open
        self.main = self.app.window(handle=self.main.wrapper_object().handle)
        time.sleep(self.cfg["long_delay_s"])
        self.main.set_focus()
        self.log("RASAero started")

    def stop(self):
        try:
            if self.app:
                self.app.kill()
        except Exception:
            pass
        self.kill_all()
        self.app = None
        self.main = None

    # ---- debugging helpers ------------------------------------------------
    def screenshot(self, tag: str):
        if not self.debug_dir:
            return
        try:
            self._shots += 1
            p = self.debug_dir / f"shot{self._shots:02d}-{tag}.png"
            from PIL import ImageGrab  # no UIA here: screenshots are taken while heavy windows are open

            ImageGrab.grab().save(str(p))
            self.log(f"screenshot {p.name}")
        except Exception as e:  # pragma: no cover
            self.log(f"screenshot failed: {e}")

    # Windows whose UIA tree is enormous (Aero Plots: a grid with thousands
    # of rows). Walking them with descendants() takes minutes and times out,
    # so the generic helpers skip them; they are only touched via children().
    heavy_handles: set[int] = set()

    def dump_tree(self, path: Path, depth: int = 8):
        """Write the accessibility tree of every RASAero window (for inspection)."""
        import contextlib
        import io

        with open(path, "a", encoding="utf-8") as f:
            for w in self.rasaero_windows():
                f.write(f"\n===== window: {w.window_text()!r} class={w.class_name()!r}\n")
                spec = self.app.window(handle=w.handle)
                buf = io.StringIO()
                try:
                    with contextlib.redirect_stdout(buf):
                        if w.handle in self.heavy_handles:
                            buf.write("   (skipped: heavy window, not walked)\n")
                        elif hasattr(spec, "dump_tree"):
                            spec.dump_tree(depth=depth)
                        else:
                            spec.print_control_identifiers(depth=depth)
                except Exception as e:
                    buf.write(f"(failed: {e})\n")
                f.write(buf.getvalue())

    def all_windows(self):
        """Top-level RASAero windows plus windows owned by the main window
        (RASAero's dialogs and the Aero Plots / Flight Simulation forms show
        up as child Windows of the main form in UIA)."""
        out = list(self.rasaero_windows())
        seen = {w.handle for w in out}
        try:
            for w in self.main.wrapper_object().descendants(control_type="Window"):
                if w.handle not in seen:
                    out.append(w)
                    seen.add(w.handle)
        except Exception:
            pass
        return out

    def enum_windows(self) -> list[tuple[int, str, str]]:
        """(hwnd, title, class) of every visible top-level window of the
        RASAero process, via EnumWindows - independent of UIA, which misses
        RASAero's owned forms (Aero Plots) and stalls while it computes."""
        if not self.app:
            return []
        import ctypes
        from ctypes import wintypes

        pid = self.app.process
        user32 = ctypes.windll.user32
        found = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        def cb(hwnd, _):
            wpid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
            if wpid.value == pid and user32.IsWindowVisible(hwnd):
                buf = ctypes.create_unicode_buffer(512)
                user32.GetWindowTextW(hwnd, buf, 512)
                cls = ctypes.create_unicode_buffer(256)
                user32.GetClassNameW(hwnd, cls, 256)
                found.append((int(hwnd), buf.value, cls.value))
            return True

        user32.EnumWindows(cb, 0)
        return found

    # ---- Win32 helpers (no UIA): used for RASAero's Aero Plots form, whose
    # accessibility tree (a grid with thousands of rows) cannot be walked -
    # UIA calls on it time out and have crashed RASAero.
    @staticmethod
    def win32_close(hwnd: int):
        import ctypes

        WM_CLOSE = 0x0010
        ctypes.windll.user32.PostMessageW(ctypes.c_void_p(hwnd), WM_CLOSE, 0, 0)

    @staticmethod
    def win32_focus(hwnd: int):
        import ctypes

        user32 = ctypes.windll.user32
        user32.ShowWindow(ctypes.c_void_p(hwnd), 9)  # SW_RESTORE
        send_keys("%")  # a keypress lets our process change the foreground window
        time.sleep(0.2)
        user32.SetForegroundWindow(ctypes.c_void_p(hwnd))
        time.sleep(0.3)

    @staticmethod
    def win32_rect(hwnd: int) -> tuple[int, int, int, int]:
        import ctypes
        from ctypes import wintypes

        r = wintypes.RECT()
        ctypes.windll.user32.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(r))
        return r.left, r.top, r.right, r.bottom

    def win32_exists(self, hwnd: int) -> bool:
        return any(h == hwnd for h, _, _ in self.enum_windows())

    def close_hwnd(self, hwnd: int, timeout: float = 15.0) -> bool:
        """Close one specific window by handle (WM_CLOSE), never Alt+F4 to
        whatever is in front - that has closed the worker's own console."""
        self.win32_close(hwnd)
        t0 = time.time()
        while time.time() - t0 < timeout:
            if not self.win32_exists(hwnd):
                self.heavy_handles.discard(hwnd)
                return True
            time.sleep(0.5)
        self.log(f"window {hwnd:#x} did not close")
        return False

    def wait_responsive(self, hwnd: int, timeout: float, settle: int = 3) -> bool:
        """Block until the window's UI thread answers messages again (RASAero
        shows the Aero Plots form first and computes its table afterwards,
        during which every UIA call times out). True if it became responsive."""
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        SMTO_ABORTIFHUNG = 0x0002
        t0 = time.time()
        good = 0
        while time.time() - t0 < timeout:
            res = wintypes.DWORD()
            ok = user32.SendMessageTimeoutW(wintypes.HWND(hwnd), 0x0000, 0, 0, SMTO_ABORTIFHUNG, 1000, ctypes.byref(res))
            good = good + 1 if ok else 0
            if good >= settle:
                self.log(f"window {hwnd:#x} responsive after {time.time() - t0:.0f}s")
                return True
            time.sleep(1.0)
        self.log(f"window {hwnd:#x} still busy after {timeout:.0f}s")
        return False

    def rasaero_windows(self):
        out = []
        for h, _, _ in self.enum_windows():
            if h in self.heavy_handles:
                continue
            try:
                out.append(self.app.window(handle=h).wrapper_object())
            except Exception:
                pass
        return out

    # ---- generic UI actions -----------------------------------------------
    def wait_idle(self, min_wait: float, max_wait: float):
        time.sleep(min_wait)
        try:
            self.app.wait_cpu_usage_lower(threshold=self.cfg["cpu_idle_threshold"], timeout=max_wait, usage_interval=1.0)
        except Exception as e:
            self.log(f"cpu-idle wait gave up: {e}")

    def find_dialog_button(self, titles: list[str]):
        """(window, button wrapper) for the first dialog button whose text is
        in `titles`, searching every RASAero window except the main form's own
        toolbar (dialogs are owned children of the main form in UIA)."""
        main_handle = None
        try:
            main_handle = self.main.wrapper_object().handle
        except Exception:
            pass
        wanted = {t.lower() for t in titles}
        for w in self.all_windows():
            try:
                if w.handle == main_handle or w.handle in self.heavy_handles:
                    continue
                for btn in w.descendants(control_type="Button"):
                    if (btn.window_text() or "").strip().lower() in wanted:
                        return w, btn
            except Exception as e:
                self.log(f"find_dialog_button: {w!r}: {e}")
                continue
        return None, None

    def click_dialog_button(self, titles: list[str], timeout: float, fallback_keys: str | None = None) -> bool:
        t0 = time.time()
        while time.time() - t0 < timeout:
            w, btn = self.find_dialog_button(titles)
            if btn is not None:
                self.log(f"dialog {w.window_text()!r}: clicking {btn.window_text()!r}")
                btn.click_input()
                time.sleep(self.cfg["short_delay_s"])
                return True
            time.sleep(0.3)
        if fallback_keys:
            self.log(f"no dialog button {titles} found; sending {fallback_keys!r}")
            send_keys(fallback_keys)
            time.sleep(self.cfg["short_delay_s"])
        return False

    def dialog_text(self) -> str:
        """Text of any modal message box (for error reporting)."""
        parts = []
        for w in self.rasaero_windows():
            if w == self.main:
                continue
            try:
                for c in w.descendants(control_type="Text"):
                    parts.append(c.window_text())
            except Exception:
                pass
        return " | ".join(p for p in parts if p)

    def find_menu_item(self, title_re: str, exclude=None):
        """A MenuItem whose title matches, in any RASAero window (dropdowns are
        separate top-level windows). Returns the wrapper or None."""
        import re

        rx = re.compile(title_re, re.IGNORECASE)
        for w in self.rasaero_windows():
            try:
                if w.handle in self.heavy_handles:
                    items = []
                    for c in w.children():
                        if c.friendly_class_name() in ("MenuBar", "Menu"):
                            items += c.children()
                else:
                    items = w.descendants(control_type="MenuItem")
                for item in items:
                    if rx.search(item.window_text() or "") and item is not exclude:
                        return item
            except Exception:
                continue
        return None

    def menu(self, window, path: str, fallback_keys: str | None):
        """Open a menu path like 'File->Select Motor File' by clicking the items.
        RASAero's .NET MenuStrip does not expose the UIA Invoke pattern, so
        pywinauto's menu_select() cannot be used."""
        window.set_focus()
        time.sleep(self.cfg["short_delay_s"])
        parts = [p.strip() for p in path.split("->")]
        try:
            top = self.find_menu_item("^" + re.escape(parts[0]) + "$")
            if top is None:
                raise RuntimeError(f"top-level menu {parts[0]!r} not found")
            top.click_input()
            time.sleep(self.cfg["short_delay_s"])
            for name in parts[1:]:
                item = self.find_menu_item(re.escape(name), exclude=top)
                if item is None:
                    self.screenshot("menu-missing")
                    self.dump_tree(self.debug_dir / "ui_tree_menu.txt") if self.debug_dir else None
                    send_keys("{ESC}")
                    raise RuntimeError(f"menu item {name!r} not found under {parts[0]!r}")
                item.click_input()
                time.sleep(self.cfg["short_delay_s"])
            self.log(f"menu {path}")
        except Exception as e:
            if not fallback_keys:
                raise
            self.log(f"menu {path!r} by clicking failed ({type(e).__name__}: {e}); using keys {fallback_keys!r}")
            send_keys("{ESC}")
            window.set_focus()
            send_keys(fallback_keys, pause=self.cfg["short_delay_s"])
        time.sleep(self.cfg["long_delay_s"])

    def file_dialog_open(self) -> bool:
        return any(c == "#32770" for _, _, c in self.enum_windows())

    def type_path_into_file_dialog(self, path: str):
        """Common file dialogs open with focus in the 'File name' box. The
        dialog can be slow to appear / to accept Enter (WebDAV listings), so
        wait for it, then retry the Enter / Open button until it is gone."""
        t0 = time.time()
        while not self.file_dialog_open() and time.time() - t0 < 20:
            time.sleep(0.3)
        time.sleep(self.cfg["long_delay_s"])
        send_keys("^a")
        send_keys(escape_keys(path), with_spaces=True, pause=0.01)
        send_keys("{ENTER}")
        for attempt in range(6):
            time.sleep(self.cfg["long_delay_s"])
            if not self.file_dialog_open():
                return
            # an overwrite confirmation ("already exists, replace?") -> Yes
            w, yes = self.find_dialog_button(["Yes", "&Yes"])
            if yes is not None:
                self.log("confirming overwrite")
                yes.click_input()
                continue
            self.log(f"file dialog still open (attempt {attempt + 1}); retrying")
            w, btn = self.find_dialog_button(["Open", "&Open", "Save", "&Save"])
            if btn is not None:
                btn.click_input()
            else:
                send_keys("{ENTER}")
        self.screenshot("file-dialog-stuck")
        raise RuntimeError(f"file dialog did not accept {path}")

    # ---- RASAero-specific steps ------------------------------------------
    def select_motor_file(self, motor_file: str):
        self.menu(self.main, self.cfg["menu"]["select_motor_file"], None)
        self.type_path_into_file_dialog(motor_file)
        self.log(f"motor file: {motor_file}")
        # an error box here means RASAero could not parse the file
        w, btn = self.find_dialog_button(["OK"])
        if btn is not None:
            msg = self.dialog_text()
            self.screenshot("motor-file-error")
            btn.click_input()
            raise RuntimeError(f"RASAero complained after Select Motor File: {msg}")

    def design_part_count(self) -> int:
        """Number of parts in the main form's component list (0 = no design loaded)."""
        try:
            lb = self.main.child_window(auto_id="ListBox1", control_type="List").wrapper_object()
            return len(lb.children(control_type="ListItem"))
        except Exception as e:
            self.log(f"design_part_count: {e}")
            return -1

    def open_cdx1(self, path: str, attempts: int = 3):
        for attempt in range(attempts):
            self.main.set_focus()
            send_keys("^o")
            self.type_path_into_file_dialog(path)
            w, btn = self.find_dialog_button(["OK"])
            if btn is not None:
                msg = self.dialog_text()
                self.screenshot("open-error")
                btn.click_input()
                raise RuntimeError(f"RASAero complained after opening the file: {msg}")
            time.sleep(self.cfg["long_delay_s"])
            n = self.design_part_count()
            if n != 0:
                self.log(f"opened {path} ({n} parts)")
                return
            self.log(f"open attempt {attempt + 1}: design is empty after opening {path}; retrying")
            self.screenshot(f"open-empty{attempt + 1}")
            time.sleep(self.cfg["long_delay_s"] * 2)
        raise RuntimeError(f"could not open {path}: design stays empty")

    def push_toolbar_button(self, title_re: str, timeout: float = 15.0, raw_handle: bool = False):
        """Click a main-window ToolStrip button and return the window it
        opened (the new top-level RASAero window, whatever its title), or
        None. The main window is raised first: click_input() works in screen
        coordinates and lands on whatever is in front (the worker's own
        console during the first bring-up)."""
        before = {h for h, _, _ in self.enum_windows()}
        self.main.set_focus()
        time.sleep(self.cfg["short_delay_s"])
        btn = self.main.child_window(title_re=title_re, control_type="Button")
        btn.wait("visible enabled", timeout=15)
        # click_input, not invoke(): the button shows a modal form, so a
        # synchronous UIA Invoke never returns and times out after ~2 min.
        btn.click_input()
        # Aero Plots computes its whole table (to Mach 25) before the form
        # responds; UIA calls during that time out (0x80131505), so wait for
        # the process to go idle before touching the tree.
        # The form pumps messages while it computes its table (so a
        # responsiveness probe passes) but UIA calls still time out until the
        # process goes idle - wait on CPU first.
        self.wait_idle(self.cfg["long_delay_s"], self.cfg["sim_max_wait_s"])
        t0 = time.time()
        while time.time() - t0 < timeout:
            new = [(h, t, c) for h, t, c in self.enum_windows() if h not in before and c != "SysShadow" and "tooltips" not in c.lower()]
            titled = [x for x in new if x[1].strip()]
            if titled:
                self.log(f"button {title_re!r}: new windows " + ", ".join(f"{t!r}/{c}" for _, t, c in new))
                self.wait_responsive(titled[0][0], self.cfg["sim_max_wait_s"])
                time.sleep(self.cfg["long_delay_s"])
                if raw_handle:
                    return titled[0][0]
                for _ in range(10):
                    try:
                        return self.app.window(handle=titled[0][0]).wrapper_object()
                    except Exception as e:
                        self.log(f"wrapping new window: {e}")
                        time.sleep(2.0)
                return None
            time.sleep(0.5)
        time.sleep(self.cfg["long_delay_s"])
        self.log(f"button {title_re!r}: no new titled window; windows now: " + ", ".join(f"{t!r}/{c}" for _, t, c in self.enum_windows()))
        return None

    # ---- Aero Plots (no UIA while it is open; see heavy_handles) ------------
    def ap_click(self, hwnd: int, name: str, wait: bool = True):
        """Click a control of the Aero Plots form by its position in the
        form (worker_config.json: aero_plots_layout)."""
        from pywinauto import mouse

        dx, dy = self.cfg["aero_plots_layout"][name]
        left, top, _, _ = self.win32_rect(hwnd)
        mouse.click(coords=(left + dx, top + dy))
        time.sleep(self.cfg["short_delay_s"])
        if wait:
            time.sleep(self.cfg["long_delay_s"])
            self.wait_idle(0.0, self.cfg["sim_max_wait_s"])
            self.wait_responsive(hwnd, self.cfg["sim_max_wait_s"])

    def ap_select_plot_range(self, hwnd: int, label: str):
        """Pick an entry of the 'Plot Data to' list (Mach 3/5/8/10/25)."""
        from pywinauto import mouse

        items = self.cfg["aero_plots_plot_range_items"]
        if label not in items:
            raise ValueError(f"unknown plot range {label!r}; known: {list(items)}")
        self.ap_click(hwnd, "combo_plot_range", wait=False)
        time.sleep(self.cfg["short_delay_s"])
        dx, dy = items[label]
        left, top, _, _ = self.win32_rect(hwnd)
        mouse.click(coords=(left + dx, top + dy))
        time.sleep(self.cfg["long_delay_s"])
        self.wait_idle(0.0, self.cfg["sim_max_wait_s"])
        self.wait_responsive(hwnd, self.cfg["sim_max_wait_s"])
        self.log(f"aero plots: plot range {label}")

    def ap_export_csv(self, hwnd: int, csv_path: str, attempts: int = 3):
        """File -> Export -> To CSV File, then the save dialog. Keyboard only
        (the dialog lives in RASAero's process; no UIA while Aero Plots is
        open). The dialog can swallow keystrokes while its WebDAV folder
        listing loads, so the file name is typed once it is responsive and
        the whole thing is retried if no file appears."""
        for attempt in range(attempts):
            if os.path.exists(csv_path):
                os.remove(csv_path)
            self.win32_focus(hwnd)
            send_keys(self.cfg["keys"]["aero_export"], pause=self.cfg["short_delay_s"])
            t0 = time.time()
            dlg = None
            while time.time() - t0 < 30:
                dlgs = [h for h, _, c in self.enum_windows() if c == "#32770"]
                if dlgs:
                    dlg = dlgs[0]
                    break
                time.sleep(0.3)
            if dlg is None:
                self.log("no save dialog appeared for the CSV export")
                self.screenshot("aero-export-nodialog")
                send_keys("{ESC}{ESC}")
                continue
            self.wait_responsive(dlg, 60)
            time.sleep(self.cfg["long_delay_s"] * 2)
            send_keys("%n")  # focus the File name box
            time.sleep(0.5)
            send_keys("^a")
            send_keys(escape_keys(csv_path), with_spaces=True, pause=0.02)
            time.sleep(0.5)
            send_keys("{ENTER}")
            time.sleep(self.cfg["long_delay_s"])
            if wait_for_file(csv_path, timeout=90):
                self.log(f"aero plots exported {csv_path}")
                return
            self.screenshot(f"aero-export-missing{attempt + 1}")
            self.log(f"export attempt {attempt + 1}: no file; closing the dialog and retrying")
            for h in [h for h, _, c in self.enum_windows() if c == "#32770"]:
                self.win32_close(h)
            time.sleep(self.cfg["long_delay_s"])
        raise RuntimeError(f"aero export did not produce {csv_path}")

    def enter_mach_alt(self, points: list[list[float]]):
        """Options -> Mach-Alt: add (Mach, altitude ft) points, then Done."""
        self.menu(self.main, "Options->Mach-Alt", None)
        time.sleep(self.cfg["long_delay_s"])
        dlg = None
        for w in self.all_windows():
            if (w.window_text() or "").strip().lower() == "mach_alt":
                dlg = w
                break
        if dlg is None:
            raise RuntimeError("Mach_Alt dialog did not open")
        edits = dlg.descendants(control_type="Edit")
        if len(edits) < 2:
            raise RuntimeError(f"Mach_Alt dialog: expected 2 edit boxes, found {len(edits)}")
        accept = [b for b in dlg.descendants(control_type="Button") if b.window_text() == "Accept"][0]
        for mach, alt in points:
            for box, val in ((edits[0], f"{mach:g}"), (edits[1], f"{alt:g}")):
                box.click_input()
                send_keys("^a{BACKSPACE}")
                send_keys(val)
                time.sleep(0.2)
            accept.click_input()
            time.sleep(self.cfg["short_delay_s"])
        self.screenshot("mach-alt-entered")
        done = [b for b in dlg.descendants(control_type="Button") if b.window_text() == "Done"][0]
        done.click_input()
        time.sleep(self.cfg["long_delay_s"])
        self.log(f"Mach-Alt: entered {len(points)} point(s)")

    def open_flight_sim(self):
        fs = self.push_toolbar_button(self.cfg["flight_sim_button_re"])
        if fs is None:
            self.log("flight-sim window did not appear; continuing with keyboard focus")
        self.fs = fs
        return fs

    def open_aero_plots(self) -> int | None:
        """Open the Aero Plots form; returns its HWND (Win32 only - see the
        note on heavy_handles) or None."""
        hwnd = self.push_toolbar_button(self.cfg.get("aero_plots_button_re", "Aero Plots"), raw_handle=True)
        if hwnd is None:
            self.log("aero-plots window did not appear")
        else:
            self.heavy_handles.add(hwnd)
        self.ap_hwnd = hwnd
        return hwnd

    def rerun_all(self, n_rows: int, wait_hint: float | None):
        target = self.fs if self.fs is not None else self.main
        self.menu(target, self.cfg["menu"]["rerun_all"], self.cfg["keys"]["rerun_all"])
        mult = wait_hint or 1.0
        min_wait = (self.cfg["sim_min_wait_s"] + self.cfg["sim_per_row_s"] * n_rows) * mult
        self.log(f"rerun all: waiting >= {min_wait:.0f}s for {n_rows} rows")
        self.wait_idle(min_wait, self.cfg["sim_max_wait_s"])

    def open_view_data(self, row: int = 0) -> int | None:
        """Open the time-history window for grid row `row` of the flight-sim
        form and return its HWND. UIA is used only to locate the row's first
        cell *before* anything opens; the button cell is reached with the
        keyboard (End = last column, Space = press) and everything after that
        is Win32 only - the data window holds thousands of rows and any UIA
        call while it is open times out (0x80131505)."""
        from pywinauto import mouse

        target = self.fs if self.fs is not None else self.main.wrapper_object()
        before = {h for h, _, _ in self.enum_windows()}
        rect = None
        try:
            for item in target.descendants(control_type="DataItem"):
                if (item.window_text() or "").strip() == f"Motor(s) Loaded Row {row}":
                    rect = item.rectangle()
                    break
        except Exception as e:
            self.log(f"view data: grid walk failed: {e}")
        if rect is None:
            self.log(f"view data: row {row} not found in the grid")
            return None
        mouse.click(coords=(rect.left + 10, (rect.top + rect.bottom) // 2))
        time.sleep(0.5)
        send_keys("{END}")  # last column = the ViewData button cell
        time.sleep(0.3)
        send_keys("{SPACE}")
        self.wait_idle(self.cfg["long_delay_s"], self.cfg["sim_max_wait_s"])
        t0 = time.time()
        while time.time() - t0 < 30:
            new = [(h, t, c) for h, t, c in self.enum_windows() if h not in before and c != "SysShadow" and "tooltips" not in c.lower() and t.strip()]
            if new:
                hwnd = new[0][0]
                self.heavy_handles.add(hwnd)
                self.wait_responsive(hwnd, self.cfg["sim_max_wait_s"])
                self.log(f"view data window {new[0][1]!r} {hwnd:#x}")
                return hwnd
            time.sleep(0.5)
        self.log("view data window did not appear")
        self.screenshot("view-data-missing")
        return None

    def export_row1(self, csv_path: str, time_base_s: float, attempts: int = 3):
        """'View Data' for the first grid row, then File > Export > To CSV
        (keyboard only while the data window is open - see open_view_data).
        RASAero may ask for a time base before the save dialog; the dialog
        is answered with the keys in worker_config.json."""
        vd = self.open_view_data(0)
        if vd is None:
            raise RuntimeError("View Data window did not open")
        try:
            for attempt in range(attempts):
                if os.path.exists(csv_path):
                    os.remove(csv_path)
                self.win32_focus(vd)
                send_keys(self.cfg["keys"]["export"], pause=self.cfg["short_delay_s"])
                # a time-base prompt (if any) shows up before the file dialog
                t0 = time.time()
                dlg = None
                while time.time() - t0 < 30:
                    dlgs = [h for h, _, c in self.enum_windows() if c == "#32770"]
                    if dlgs:
                        dlg = dlgs[0]
                        break
                    others = [(h, t) for h, t, c in self.enum_windows() if h != vd and t.strip() and "time" in t.lower()]
                    if others:
                        self.screenshot("time-base-dialog")
                        downs = self.cfg["time_base_downs"].get(str(time_base_s), 0)
                        if downs:
                            send_keys("{DOWN %d}" % downs, pause=0.2)
                        send_keys(self.cfg["keys"]["time_base_confirm"], pause=self.cfg["short_delay_s"])
                        time.sleep(self.cfg["long_delay_s"])
                    time.sleep(0.5)
                if dlg is None:
                    self.log("no save dialog appeared for the history export")
                    self.screenshot("export-nodialog")
                    send_keys("{ESC}{ESC}")
                    continue
                self.wait_responsive(dlg, 60)
                time.sleep(self.cfg["long_delay_s"] * 2)
                send_keys("%n")
                time.sleep(0.5)
                send_keys("^a")
                send_keys(escape_keys(csv_path), with_spaces=True, pause=0.02)
                time.sleep(0.5)
                send_keys("{ENTER}")
                time.sleep(self.cfg["long_delay_s"])
                if wait_for_file(csv_path, timeout=120):
                    self.log(f"exported {csv_path}")
                    return
                self.screenshot(f"export-missing{attempt + 1}")
                self.log(f"history export attempt {attempt + 1}: no file; retrying")
                for h in [h for h, _, c in self.enum_windows() if c == "#32770"]:
                    self.win32_close(h)
                time.sleep(self.cfg["long_delay_s"])
            raise RuntimeError(f"export did not produce {csv_path}")
        finally:
            self.close_hwnd(vd)
            time.sleep(self.cfg["short_delay_s"])

    def save_document(self, path: str):
        """Ctrl+S; RASAero often answers with a Save As dialog even for a
        file it opened - point it at `path` and confirm an overwrite."""
        self.main.set_focus()
        send_keys("^s")
        time.sleep(self.cfg["long_delay_s"])
        w, _ = self.find_dialog_button(["Save", "&Save"])
        if w is not None:
            self.log("Save As dialog appeared; entering path")
            self.type_path_into_file_dialog(path)
            self.click_dialog_button(self.cfg["save_prompt_yes_titles"], timeout=2.0)  # overwrite? -> Yes
        time.sleep(self.cfg["short_delay_s"])

    def close_flight_sim_and_save(self, result_path: str):
        """Close the Flight Simulation window (answer Yes to keep the results),
        then save the document so MaxAltitude etc. land in result_path."""
        before = os.path.getmtime(result_path)
        if self.fs is not None:
            self.win32_close(self.fs.handle)
        else:
            self.log("no flight-sim window handle; cannot close it safely")
        self.click_dialog_button(self.cfg["save_prompt_yes_titles"], timeout=4.0, fallback_keys="{ENTER}")
        time.sleep(self.cfg["short_delay_s"])
        self.save_document(result_path)
        t0 = time.time()
        while time.time() - t0 < 20:
            if os.path.getmtime(result_path) != before:
                self.log("result file saved")
                return True
            time.sleep(0.5)
        self.screenshot("save-not-detected")
        self.log("WARNING: result file mtime did not change after save")
        return False


def wait_for_file(path: str, timeout: float, quiet: float = 1.5) -> bool:
    t0 = time.time()
    while time.time() - t0 < timeout:
        if os.path.exists(path) and os.path.getsize(path) > 0 and time.time() - os.path.getmtime(path) > quiet:
            return True
        time.sleep(0.5)
    return False


def rows_with_results(cdx1_path: str) -> tuple[int, int]:
    root = ET.parse(cdx1_path).getroot()
    sims = root.findall("SimulationList/Simulation")
    ok = sum(1 for s in sims if float((s.findtext("MaxAltitude") or "0").strip() or 0) > 0)
    return ok, len(sims)


# ---- job processing ---------------------------------------------------------

def inspect_job(job_dir: Path, spec: dict, cfg: dict, repo: Path, log: Log):
    """Photograph and dump every window/menu so the GUI can be mapped remotely."""
    ras = RASAero(cfg, log, debug_dir=job_dir)
    tree = job_dir / "ui_tree.txt"
    try:
        ras.start()
        ras.screenshot("main")
        ras.dump_tree(tree)
        if spec.get("motor_file"):
            try:
                ras.select_motor_file(str(repo / spec["motor_file"].replace("/", os.sep)))
                ras.screenshot("after-motor-file")
            except Exception as e:
                log(f"select motor file failed: {e}")
                ras.screenshot("motor-file-failed")
                send_keys("{ESC}")
        cdx1 = job_dir / spec["cdx1"] if spec.get("cdx1") else None
        if cdx1 and cdx1.exists():
            ras.open_cdx1(str(cdx1))
            ras.screenshot("file-open")
        # every top-level menu of the main window
        for name in [m.window_text() for m in ras.main.descendants(control_type="MenuItem")][:8]:
            try:
                item = ras.find_menu_item("^" + re.escape(name) + "$")
                item.click_input()
                time.sleep(cfg["short_delay_s"])
                ras.screenshot("main-menu-" + re.sub(r"\W", "", name))
                ras.dump_tree(tree)
                send_keys("{ESC}")
                time.sleep(0.3)
            except Exception as e:
                log(f"menu {name}: {e}")
        # Options -> Mach-Alt dialog (altitude used for the aero tables)
        try:
            ras.menu(ras.main, "Options->Mach-Alt", None)
            time.sleep(cfg["long_delay_s"])
            ras.screenshot("mach-alt-dialog")
            ras.dump_tree(tree)
            if not ras.click_dialog_button(["Cancel"], timeout=5, fallback_keys="{ESC}"):
                log("Mach-Alt: no Cancel button found")
            time.sleep(0.5)
        except Exception as e:
            log(f"Mach-Alt dialog: {e}")
            ras.click_dialog_button(["Cancel", "Done"], timeout=3, fallback_keys="{ESC}")
        # Aero Plots form: Win32 + keyboard + mouse + screenshots only. Any UIA
        # activity while this form is open (even dumping another window's
        # tree) has crashed RASAero, so nothing here touches UIA.
        try:
            hwnd = ras.open_aero_plots()
            ras.screenshot("aero-plots")
            if hwnd is not None:
                from pywinauto import mouse

                left, top, right, bottom = ras.win32_rect(hwnd)
                log(f"aero plots hwnd {hwnd:#x} rect {(left, top, right, bottom)}")
                ras.win32_focus(hwnd)
                send_keys("%f")
                time.sleep(cfg["long_delay_s"])
                ras.screenshot("ap-menu-File")
                send_keys("{RIGHT}")  # open the Export submenu
                time.sleep(cfg["long_delay_s"])
                ras.screenshot("ap-menu-File-Export")
                send_keys("{ESC}{ESC}{ESC}")
                time.sleep(0.5)
                send_keys("%o")
                time.sleep(cfg["long_delay_s"])
                ras.screenshot("ap-menu-Options")
                send_keys("{ESC}{ESC}")
                time.sleep(0.5)
                # configuration radio buttons and the plot-range combo, by
                # position relative to the form (layout is fixed)
                ap_layout = cfg.get("aero_plots_layout", {})
                for name, (dx, dy) in ap_layout.items():
                    mouse.click(coords=(left + dx, top + dy))
                    time.sleep(cfg["long_delay_s"] * 2)
                    ras.wait_responsive(hwnd, cfg["sim_max_wait_s"])
                    ras.screenshot("ap-click-" + name)
                    send_keys("{ESC}")
                    time.sleep(0.5)
                ras.close_hwnd(hwnd)
                ras.screenshot("after-aero-plots-close")
        except Exception as e:
            log(f"aero plots inspection failed: {e}")
            ras.screenshot("aero-plots-failed")
        # flight simulation window and its menus
        try:
            ras.open_flight_sim()
            ras.screenshot("flight-sim")
            ras.dump_tree(tree)
            fs = ras.fs
            names = [m.window_text() for m in (fs.descendants(control_type="MenuItem") if fs is not None else [])][:8]
            log(f"flight sim menus: {names}")
            for name in names:
                try:
                    item = ras.find_menu_item("^" + re.escape(name) + "$")
                    item.click_input()
                    time.sleep(cfg["short_delay_s"])
                    ras.screenshot("fs-menu-" + re.sub(r"\W", "", name))
                    ras.dump_tree(tree)
                    send_keys("{ESC}")
                    time.sleep(0.3)
                except Exception as e:
                    log(f"fs menu {name}: {e}")
            if spec.get("try_view_data"):
                ras.rerun_all(1, None)
                ras.screenshot("after-rerun")
                # an error box (e.g. motor not found) would block everything below
                w, btn = ras.find_dialog_button(["OK"])
                if btn is not None:
                    log(f"RASAero message after rerun: {ras.dialog_text()}")
                    btn.click_input()
                    time.sleep(cfg["short_delay_s"])
                ras.dump_tree(tree)
                vd = ras.open_view_data(0)
                ras.screenshot("after-view-data")
                if vd is not None:
                    ras.win32_focus(vd)
                    send_keys("%f")
                    time.sleep(cfg["long_delay_s"])
                    ras.screenshot("vd-menu-File")
                    send_keys("{RIGHT}")
                    time.sleep(cfg["long_delay_s"])
                    ras.screenshot("vd-menu-File-sub")
                    send_keys("{ESC}{ESC}{ESC}")
                    time.sleep(0.5)
                    ras.close_hwnd(vd)
                    ras.screenshot("after-view-data-close")
        except Exception as e:
            log(f"flight sim inspection failed: {e}")
            ras.screenshot("flight-sim-failed")
        log("inspection complete")
    finally:
        ras.stop()


LOCAL_JOBS = Path(os.environ.get("RPA_LOCAL_JOBS", r"C:\rpa_jobs"))


def stage_job_locally(d: Path, spec: dict, repo: Path, jlog) -> tuple[Path, dict]:
    """Copy the job's inputs (and the motor file) to a local folder so RASAero
    and the file dialogs never touch the flaky WebDAV share mid-job. Jobs
    that arrived through the guest agent are already local and complete."""
    if spec.get("transport") == "agent":
        return d, dict(spec)
    local = LOCAL_JOBS / d.name
    if local.exists():
        shutil.rmtree(local, ignore_errors=True)
    local.mkdir(parents=True, exist_ok=True)
    for name in (spec.get("cdx1"), "job.json"):
        if name:
            retry_io(lambda: shutil.copyfile(d / name, local / name), f"copy {name}")
    lspec = dict(spec)
    if spec.get("motor_file"):
        src = repo / spec["motor_file"].replace("/", os.sep)
        (local / "motors").mkdir(exist_ok=True)
        retry_io(lambda: shutil.copyfile(src, local / "motors" / src.name), "copy motor file")
        lspec["motor_file"] = "motors/" + src.name
    return local, lspec


def sync_job_back(local: Path, d: Path, jlog, spec: dict | None = None):
    """Hand the results back. Share transport: copy every file to the share
    (done.json last, so the Mac side never sees a finished job with missing
    outputs). Agent transport: zip everything into done.zip, which the Mac
    pulls through the guest agent."""
    if (spec or {}).get("transport") == "agent" or local == d:
        import zipfile

        tmp = local / "done.zip.part"
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for p in sorted(local.iterdir()):
                if p.is_file() and p.name not in ("done.zip", "done.zip.part", "claimed"):
                    zf.write(p, p.name)
        tmp.replace(local / "done.zip")  # atomic: the Mac only ever sees a complete zip
        return
    files = sorted(p for p in local.iterdir() if p.is_file() and p.name != "done.json")
    for p in files:
        try:
            retry_io(lambda: shutil.copyfile(p, d / p.name), f"copy back {p.name}", attempts=60)
        except OSError as e:
            jlog(f"could not copy {p.name} to the share: {e}")
    done = local / "done.json"
    if done.exists():
        retry_io(lambda: shutil.copyfile(done, d / "done.json"), "copy back done.json", attempts=120)


def run_job_with_watchdog(d: Path, spec: dict, cfg: dict, repo: Path, jlog: Log, t0: float, timeout_s: float):
    """Run the job in a thread, on a local copy of the job folder. A UIA/COM
    call into a busy RASAero can block indefinitely; if the job overruns,
    kill RASAero (which makes the blocked call fail), record the error and
    move on instead of hanging the worker."""
    import threading

    outcome: dict = {}
    try:
        local, lspec = stage_job_locally(d, spec, repo, jlog)
    except OSError as e:
        jlog(f"could not stage job locally: {e}")
        write_done(d, "error", f"share unavailable while staging: {e}", t0)
        return
    jlog.path, jlog.mirror = local / "worker.log", (None if local == d else d / "worker.log")
    d, spec, repo = local, lspec, local  # the job now runs entirely from the local copy
    share_dir = Path(str(jlog.mirror)).parent

    def target():
        try:
            try:  # COM must be initialised in every thread that uses UIA
                import pythoncom

                pythoncom.CoInitialize()
            except Exception as e:
                jlog(f"CoInitialize: {e}")
            process_job(d, spec, cfg, repo, jlog)
            outcome["ok"] = True
        except Exception as e:
            outcome["err"] = e

    th = threading.Thread(target=target, daemon=True)
    th.start()
    th.join(timeout_s)
    if th.is_alive():
        jlog(f"WATCHDOG: job exceeded {timeout_s:.0f}s - killing RASAero")
        RASAero.kill_all()
        th.join(120)
        end_session()
        write_done(d, "error", f"timeout after {timeout_s:.0f}s (RASAero killed by watchdog)", t0)
        sync_job_back(local, share_dir, jlog, spec)
        if th.is_alive():
            jlog("WATCHDOG: job thread still stuck after kill - restarting worker process")
            sys.stdout.flush()
            os._exit(RELOAD_EXIT_CODE)
        return
    if "err" in outcome:
        e = outcome["err"]
        jlog("FAILED: " + "".join(traceback.format_exception(e)).strip())
        write_done(d, "error", f"{type(e).__name__}: {e}", t0)
    else:
        write_done(d, "ok", "", t0)
        jlog("done")
    sync_job_back(local, share_dir, jlog, spec)


# ---- one RASAero session across jobs -------------------------------------
# Starting RASAero and re-selecting the motor file cost ~40 s per job; the
# session is kept between jobs of the same kind and restarted when the app
# died, the kind changes (aero plots vs flight sims), a job failed, or after
# restart_every_jobs jobs (WinForms leaks).
_session: dict = {"ras": None, "kind": None, "jobs": 0, "motor_hash": None}


def get_session(cfg: dict, log: Log, kind: str, debug_dir: Path) -> "RASAero":
    s = _session
    ras = s["ras"]
    if ras is not None:
        try:
            alive = ras.app is not None and ras.app.is_process_running() and bool(ras.rasaero_windows())
        except Exception:
            alive = False
        limit = int(cfg.get("restart_every_jobs", 25))
        why = None if alive and s["kind"] == kind and s["jobs"] < limit else ("RASAero is gone" if not alive else "job kind changed" if s["kind"] != kind else f"{limit} jobs done")
        if why:
            log(f"restarting RASAero ({why})")
            ras.log = log
            ras.stop()
            ras = None
    if ras is None:
        ras = RASAero(cfg, log, debug_dir=debug_dir)
        ras.start()
        s.update(ras=ras, kind=kind, jobs=0, motor_hash=None)
    else:
        log(f"reusing the running RASAero session (job {s['jobs'] + 1} of this session)")
    ras.log, ras.debug_dir, ras._shots = log, debug_dir, 0
    return ras


def end_session(log: Log | None = None):
    ras = _session["ras"]
    if ras is not None:
        if log is not None:
            ras.log = log
        ras.stop()
    _session.update(ras=None, kind=None, jobs=0, motor_hash=None)


def aero_export_job(job_dir: Path, spec: dict, cfg: dict, repo: Path, log: Log):
    """Export one Aero Plots table (CD etc. vs Mach) as CSV.
    spec: config 'stack' | 'sustainer', plot_range 'Mach 5', export_csv,
    optional mach_alt [[mach, alt_ft], ...] entered through Options -> Mach-Alt
    (saved back into result.CDX1 so the Mac side learns the XML schema)."""
    ras = get_session(cfg, log, "aero", job_dir)
    inp = job_dir / spec["cdx1"]
    result = job_dir / spec["result_cdx1"]
    shutil.copyfile(inp, result)
    csv_path = str(job_dir / spec["export_csv"])
    try:
        ras.open_cdx1(str(result))
        if spec.get("mach_alt"):
            ras.enter_mach_alt(spec["mach_alt"])
            ras.save_document(str(result))  # so the Mac side sees the <MachAlt> schema
        hwnd = ras.open_aero_plots()
        if hwnd is None:
            raise RuntimeError("Aero Plots form did not open")
        if spec.get("plot_range"):
            ras.ap_select_plot_range(hwnd, spec["plot_range"])
        radio = "radio_sustainer_booster" if spec.get("config", "stack") == "stack" else "radio_sustainer"
        ras.ap_click(hwnd, radio)
        ras.screenshot("aero-plots-configured")
        ras.ap_export_csv(hwnd, csv_path)
        ras.close_hwnd(hwnd)
        _session["jobs"] += 1
    except Exception:
        ras.screenshot("error")
        end_session(log)
        raise


def process_job(job_dir: Path, spec: dict, cfg: dict, repo: Path, log: Log):
    if spec["type"] == "inspect":
        end_session(log)
        return inspect_job(job_dir, spec, cfg, repo, log)
    if spec["type"] == "aero_export":
        return aero_export_job(job_dir, spec, cfg, repo, log)
    ras = get_session(cfg, log, "flight", job_dir)
    inp = job_dir / spec["cdx1"]
    result = job_dir / spec["result_cdx1"]
    shutil.copyfile(inp, result)
    motor_file = str(repo / spec["motor_file"].replace("/", os.sep))
    try:
        motor_hash = spec.get("motor_hash") or hashlib.md5(Path(motor_file).read_bytes()).hexdigest()
        if cfg["select_motor_file_each_job"] and motor_hash != _session["motor_hash"]:
            ras.select_motor_file(motor_file)  # RASAero remembers it; only redo it when the file changed
            _session["motor_hash"] = motor_hash
        ras.open_cdx1(str(result))
        ras.open_flight_sim()
        ras.rerun_all(int(spec.get("n_rows", 1)), spec.get("wait_hint_s"))
        if spec["type"] == "export":
            ras.export_row1(str(job_dir / spec["export_csv"]), float(spec.get("time_base_s", 0.01)))
        ras.close_flight_sim_and_save(str(result))
        ok, n = rows_with_results(str(result))
        log(f"{ok}/{n} rows have results")
        if ok == 0:
            ras.screenshot("no-results")
            raise RuntimeError("no row has a MaxAltitude - simulations did not run, or RASAero did not recognise the motor names")
        _session["jobs"] += 1
    except Exception:
        ras.screenshot("error")
        try:
            ras.dump_tree(job_dir / "ui_tree.txt")
        except Exception:
            pass
        end_session(log)
        raise


def write_done(job_dir: Path, status: str, message: str, t0: float):
    body = json.dumps({"status": status, "message": message, "elapsed_s": round(time.time() - t0, 1), "finished": time.strftime("%Y-%m-%dT%H:%M:%S")}, indent=2)
    retry_io(lambda: (job_dir / "done.json").write_text(body), f"write {job_dir.name}/done.json")


def pending_jobs(jobs_dir: Path):
    def scan():
        return [d for d in sorted(jobs_dir.iterdir()) if d.is_dir() and (d / "job.json").exists() and not (d / "done.json").exists() and not (d / "claimed").exists()]

    return retry_io(scan, "list jobs")


def release_abandoned_claims(jobs_dir: Path, log):
    """This is the only worker: a job that is claimed but not done when we
    start was abandoned by a previous worker process (crash / share
    outage). Un-claim it so it runs again."""
    try:
        for d in sorted(jobs_dir.iterdir()):
            if d.is_dir() and (d / "claimed").exists() and not (d / "done.json").exists() and (d / "job.json").exists():
                log(f"re-queueing abandoned job {d.name}")
                (d / "claimed").unlink()
    except OSError as e:
        log(f"could not scan for abandoned jobs: {e}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--jobs", default=r"Z:\jobs")
    ap.add_argument("--repo", default=r"Z:\\")
    ap.add_argument("--transport", choices=["share", "agent"], default="share", help="share: jobs arrive on the WebDAV share; agent: pushed by the Mac into --jobs on local disk")
    ap.add_argument("--config", default=None, help="worker_config.json (default: next to this script)")
    ap.add_argument("--once", action="store_true", help="process one job then exit")
    ap.add_argument("--poll", type=float, default=3.0)
    ap.add_argument("--inspect", metavar="OUTFILE", help="start RASAero, dump its UI tree to OUTFILE and exit")
    ap.add_argument("--inspect-cdx1", default=None, help="with --inspect: open this file and the Flight Simulation window first")
    args = ap.parse_args(argv)
    cfg = load_worker_config(Path(args.config) if args.config else None)
    jobs_dir, repo = Path(args.jobs), Path(args.repo)
    log = Log(None)

    if args.inspect:
        ras = RASAero(cfg, log, debug_dir=Path(args.inspect).parent)
        ras.start()
        try:
            if args.inspect_cdx1:
                ras.open_cdx1(args.inspect_cdx1)
                ras.open_flight_sim()
            ras.screenshot("inspect")
            ras.dump_tree(Path(args.inspect))
            log(f"UI tree written to {args.inspect}")
        finally:
            ras.stop()
        return

    log(f"worker v{WORKER_VERSION} watching {jobs_dir} ({args.transport} transport, repo {repo}); RASAero at {cfg['rasaero_exe']}; python {sys.version.split()[0]} pid {os.getpid()}")
    script = Path(__file__).resolve()

    def script_digest():
        # content hash, not mtime: the WebDAV share caches stat() results
        return hashlib.md5(script.read_bytes()).hexdigest()

    script_hash = script_digest()
    last_check = time.time()
    release_abandoned_claims(jobs_dir, log)
    while True:
        # Re-exec when this file changes on the shared drive, so fixes made on
        # the Mac side take effect without anyone touching the VM.
        try:
            reload_flag = script.with_name("RELOAD")  # written by run_worker.py after it copied new files
            if reload_flag.exists() or (time.time() - last_check > 10 and (last_check := time.time()) and script_digest() != script_hash):
                log("worker script changed - restarting")
                sys.stdout.flush()
                os._exit(RELOAD_EXIT_CODE)  # run_worker.py restarts us
        except OSError:
            pass  # share hiccup; check again next round
        did = False
        for d in pending_jobs(jobs_dir):
            did = True
            try:
                spec = json.loads(retry_io(lambda: (d / "job.json").read_text(), "read job.json"))
                retry_io(lambda: (d / "claimed").write_text(time.strftime("%Y-%m-%dT%H:%M:%S")), "claim")
            except OSError as e:
                log(f"{d.name}: {e}; will retry")
                time.sleep(args.poll)
                continue
            jlog = Log(None, mirror=d / "worker.log")
            jlog(f"job {d.name}: {spec['type']} ({spec.get('n_rows')} rows); worker v{WORKER_VERSION}")
            t0 = time.time()
            run_job_with_watchdog(d, spec, cfg, repo, jlog, t0, float(cfg.get("job_timeout_s", 1200)))
            if args.once:
                return
        if not did:
            time.sleep(args.poll)


if __name__ == "__main__":
    main()
