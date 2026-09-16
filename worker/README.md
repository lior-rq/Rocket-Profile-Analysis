# RASAero II worker (runs inside the Windows VM)

The Mac side never touches the RASAero GUI. It writes jobs into `jobs/` and
waits; this worker picks them up, drives RASAero II with pywinauto and writes
the results back.

## Setup in the VM

```
python -m pip install pywinauto pillow
```

RASAero II 1.0.2.0 is expected at `C:\Program Files (x86)\RASAero II\RASAero II.exe`
(`rasaero_exe` in `worker_config.json` otherwise).

## Transport

`worker.transport` in `config.yaml`:

* **agent** (default when `utmctl` is found): no shared folder. The Mac
  pushes `job.json`, `input.CDX1` and the motor file into `C:\rpa\jobs\<name>`
  through UTM's guest agent; the worker runs from local disk, zips the
  results into `done.zip`, and the Mac pulls it back (`rpa/vmagent.py`,
  `rpa/jobs.py`). The worker files live in `C:\rpa\worker`, pushed by the
  Start button and by every `rpa` command that talks to the VM; the launcher
  restarts the worker when they change.
* **share**: the `Z:` WebDAV share (`Z:\jobs`). The share drops out and
  caches file contents, so the worker copies each job locally and retries
  every share access.

The worker keeps one RASAero session per job kind (flight sims vs. aero-plot
exports), re-selects the motor file only when its hash changes, and restarts
RASAero after a failure or every `restart_every_jobs` jobs (default 25).

## Run

Press **Start VM worker** in the GUI. It boots the VM if needed
(`utmctl start`), pushes `vm_task.ps1` into the guest, registers a scheduled
task **RPAWorker** bound to the logged-on user (the guest agent runs as SYSTEM
in session 0 and cannot drive a desktop app), starts it and waits for the
heartbeat (`worker/heartbeat.json`, every 15 s). The task also fires at
logon. **Stop worker** ends it. Settings: the `vm:` section of `config.yaml`.
A user must be logged on to Windows.

By hand, inside the VM:

```
python Z:\worker\run_worker.py
```

`run_worker.py` runs `rasaero_worker.py --jobs Z:\jobs --repo Z:\` as a
child, restarts it when the script changes or dies, and mirrors its console
to `worker\console.log`.

## First bring-up

The key sequences were taken from the pyrasaero project (RASAero II 1.0.2.0)
and RASAero's menu names. To check them on a new VM:

1. `python -m rpa motors` on the Mac (writes `output/motors/all_motors.eng`).
2. In the VM: `python Z:\worker\rasaero_worker.py --inspect Z:\output\rasaero_ui.txt --inspect-cdx1 "<path to your .CDX1>"`
   starts RASAero, opens the file and the Flight Simulation window, and dumps
   every control and menu it sees plus a screenshot. Use it to correct
   `worker_config.json` (menu paths, button titles, `{RIGHT}` presses to
   reach *View Data*).
3. One job: `python -m rpa characterize --limit 1` on the Mac,
   `python Z:\worker\rasaero_worker.py --jobs Z:\jobs --repo Z:\ --once` in
   the VM. Each job folder gets `worker.log`; on failure also `shotNN-*.png`
   and `ui_tree.txt`.

Things the first job confirms (the Mac side fails loudly if they are wrong):

* **Motor names.** RASAero must list the motors as
  `rasaero.engine_name_format` renders them (`{designation}  ({manufacturer})`).
  If every row returns `MaxAltitude = 0`, the names did not match; check the
  motor drop-down in the Flight Simulation dialog and fix the format.
* **Select Motor File** takes one multi-motor `.eng`
  (`output/motors/all_motors.eng`). If your build wants a folder, point it at
  `output/motors` once by hand and set `select_motor_file_each_job` to false.
* **Delay convention.** The characterization run checks that separation and
  ignition happen at `burnout + delay`.
* **Saving.** After *Rerun All* the worker closes the Flight Simulation
  window (answering *Yes*), presses Ctrl+S and verifies `result.CDX1`
  changed on disk. A *Save As* dialog is filled in if it appears.

## Manual fallback

`python -m rpa run --worker-mode manual` prints what to click for each job
(open `input.CDX1`, Rerun All, export row 1 to `export.csv`, Save As
`result.CDX1`) and continues as soon as the files appear.
