import json
import shutil
import threading
import time
from pathlib import Path

from rpa.jobs import RERUN_SAVE, JobClient

ROOT = Path(__file__).resolve().parents[1]


def test_manual_mode_waits_for_result_file(tmp_path):
    repo = tmp_path
    (repo / "output/motors").mkdir(parents=True)
    motor = repo / "output/motors/all_motors.eng"
    motor.write_text(";")
    msgs = []
    jc = JobClient(repo / "jobs", repo, mode="manual", poll_s=0.2, timeout_s=10, log=msgs.append)
    job = jc.create("test", RERUN_SAVE, motor_file=motor, motor_dir=motor.parent, n_rows=2)
    job.input_cdx1.write_text("<x/>")
    jc.submit(job)
    assert job.dir.name == "0001-test"
    spec = json.loads((job.dir / "job.json").read_text())
    assert spec["motor_file"] == "output/motors/all_motors.eng" and spec["n_rows"] == 2
    assert any("MANUAL STEP" in m for m in msgs)

    def pretend_user():
        time.sleep(0.5)
        shutil.copy(job.input_cdx1, job.result_cdx1)

    threading.Thread(target=pretend_user).start()
    t0 = time.time()
    status = jc.wait(job)
    assert status["status"] == "ok" and time.time() - t0 < 8


def test_auto_mode_reads_done_json(tmp_path):
    repo = tmp_path
    motor = repo / "m.eng"
    motor.write_text(";")
    jc = JobClient(repo / "jobs", repo, mode="auto", poll_s=0.1, timeout_s=5, log=lambda *_: None)
    job = jc.create("x", RERUN_SAVE, motor_file=motor, motor_dir=repo, n_rows=1)
    jc.submit(job)
    job.done_file.write_text(json.dumps({"status": "error", "message": "boom"}))
    try:
        jc.wait(job)
        raise AssertionError("should raise")
    except RuntimeError as e:
        assert "boom" in str(e)


class FakeAgent:
    """In-memory guest: push/pull by path, mkdir no-op."""

    vm = "Fake"
    available = True

    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.dirs: list[str] = []

    def mkdir(self, *dirs):
        self.dirs += dirs

    def push(self, data, guest_path, attempts=3):
        self.files[guest_path] = data.read_bytes() if hasattr(data, "read_bytes") else data

    def pull(self, guest_path, timeout=60.0):
        return self.files.get(guest_path)

    def pull_text(self, guest_path):
        b = self.pull(guest_path)
        return None if b is None else b.decode()


def test_agent_transport_round_trip(tmp_path):
    import io
    import json
    import zipfile

    from rpa.jobs import RERUN_SAVE, JobClient

    motors = tmp_path / "output" / "motors"
    motors.mkdir(parents=True)
    (motors / "all_motors.eng").write_text("; motors\n")
    agent = FakeAgent()
    jc = JobClient(tmp_path / "jobs", tmp_path, poll_s=0.01, timeout_s=5, log=lambda *_: None, transport="agent", agent=agent, guest_root=r"C:\rpa")
    job = jc.create("t1", RERUN_SAVE, motor_file=motors / "all_motors.eng", motor_dir=motors, n_rows=2)
    job.input_cdx1.write_text("<x/>")
    jc.submit(job)
    gd = jc.guest_dir(job)
    assert gd == r"C:\rpa\jobs\0001-t1"
    assert set(agent.files) == {gd + r"\input.CDX1", gd + r"\motors\all_motors.eng", gd + r"\job.json"}
    spec = json.loads(agent.files[gd + r"\job.json"])
    assert spec["transport"] == "agent" and spec["motor_file"] == "motors/all_motors.eng" and spec["motor_hash"]
    # the worker answers with done.zip
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("result.CDX1", "<result/>")
        zf.writestr("worker.log", "did it")
        zf.writestr("done.json", json.dumps({"status": "ok", "message": "", "elapsed_s": 1.0}))
    agent.files[gd + r"\done.zip"] = buf.getvalue()
    status = jc.wait(job)
    assert status["status"] == "ok"
    assert job.result_cdx1.read_text() == "<result/>" and (job.dir / "worker.log").read_text() == "did it" and job.done_file.exists()
    # a failure is raised with the worker's message
    job2 = jc.create("t2", RERUN_SAVE, motor_file=motors / "all_motors.eng", motor_dir=motors, n_rows=1)
    job2.input_cdx1.write_text("<x/>")
    jc.submit(job2)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("done.json", json.dumps({"status": "error", "message": "boom"}))
    agent.files[jc.guest_dir(job2) + r"\done.zip"] = buf.getvalue()
    import pytest

    with pytest.raises(RuntimeError, match="boom"):
        jc.wait(job2)
