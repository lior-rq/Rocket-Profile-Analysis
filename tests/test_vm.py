"""VM control against a fake utmctl (a shell script): the push -> exec -> pull
protocol with nonces, and the start/stop orchestration."""

import json
import os
import stat
import time

from rpa.gui.vm import VMControl

FAKE = r'''#!/bin/sh
# fake utmctl: status | start | file push/pull | exec (answers vm_task.ps1 calls)
D="$FAKE_DIR"
case "$1" in
  status) cat "$D/status" 2>/dev/null || echo stopped ;;
  start) echo started > "$D/status" ;;
  file)
    if [ "$2" = push ]; then cat > "$D/pushed"; else cat "$D/result" 2>/dev/null; fi ;;
  exec)
    all="$*"
    nonce=$(printf '%s' "$all" | sed -n 's/.*-Nonce \([a-z0-9]*\).*/\1/p')
    action=$(printf '%s' "$all" | sed -n 's/.*rpa_vm_task\.ps1 \([a-z]*\) .*/\1/p')
    echo "$all" >> "$D/exec.log"
    workers='[]'
    [ -f "$D/running" ] && workers='[{"pid":7}]'
    if [ "$action" = start ]; then touch "$D/running"; fi
    if [ "$action" = stop ]; then rm -f "$D/running"; killed='[7]'; else killed='[]'; fi
    printf '{"action":"%s","nonce":"%s","ok":true,"user":"VM\\\\u1","task":"Ready","workers":%s,"killed":%s,"message":"task started","python":"py"}' "$action" "$nonce" "$workers" "$killed" | base64 > "$D/result" ;;
esac
'''


def make_vm(tmp_path, **cfg):
    d = tmp_path / "fake"
    d.mkdir()
    exe = d / "utmctl"
    exe.write_text(FAKE)
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    os.environ["FAKE_DIR"] = str(d)
    (tmp_path / "worker").mkdir()
    (tmp_path / "worker" / "vm_task.ps1").write_text("param($Action)")
    vm = VMControl({"utmctl": str(exe), "name": "TestVM", "poll_s": 0.05, "heartbeat_wait_s": 0.3, "boot_timeout_s": 5, **cfg}, tmp_path, log=lambda m: None)
    return vm, d


def test_run_action_round_trip(tmp_path):
    vm, d = make_vm(tmp_path)
    assert vm.available and vm.vm_status(0) == "stopped"
    res = vm.run_action("status", timeout=3)
    assert res["ok"] and res["action"] == "status" and res["user"] == "VM\\u1"
    assert (d / "pushed").read_text() == "param($Action)"  # the script was copied into the guest
    assert "-TaskName RPAWorker" in (d / "exec.log").read_text()


def test_start_boots_vm_registers_and_waits_for_heartbeat(tmp_path):
    vm, d = make_vm(tmp_path, task_name="RPA Worker")  # spaces are stripped: the guest agent mangles quotes
    assert vm.cfg["task_name"] == "RPAWorker"
    msgs = []
    vm.log = msgs.append
    # heartbeat appears shortly after the task is started
    hb = tmp_path / "worker" / "heartbeat.json"
    assert vm.start_worker_async()
    for _ in range(200):
        if (d / "running").exists() and not hb.exists():
            hb.write_text(json.dumps({"epoch": time.time(), "status": "running", "launcher_pid": 1, "worker_pid": 2, "host": "VMHOST"}))
        if not vm.op["running"]:
            break
        time.sleep(0.05)
    assert vm.op["ok"], vm.op
    assert "worker started" in vm.op["message"] and "VMHOST" in vm.op["message"]
    assert (d / "status").read_text().strip() == "started"  # the VM was booted first
    assert any("starting it" in m for m in msgs)
    # a second start reports the running worker instead of starting another
    assert vm.start_worker_async()
    for _ in range(200):
        if not vm.op["running"]:
            break
        time.sleep(0.05)
    assert vm.op["ok"] and "already running" in vm.op["message"]
    # stop
    assert vm.stop_worker_async()
    for _ in range(200):
        if not vm.op["running"]:
            break
        time.sleep(0.05)
    assert vm.op["ok"] and "1 process" in vm.op["message"] and not (d / "running").exists()


def test_missing_utmctl(tmp_path):
    vm = VMControl({"utmctl": str(tmp_path / "nope")}, tmp_path)
    assert not vm.available and vm.snapshot()["status"] is None
