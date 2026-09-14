# RASAero II worker (runs inside the Windows VM)

The Mac-side pipeline never touches the RASAero GUI. It writes *jobs* into the
shared `jobs/` folder (`Z:\jobs` in the VM) and waits; this worker picks them
up, drives RASAero II with pywinauto, and writes the results back.

## One-time setup in the VM

```
python -m pip install pywinauto pillow
```

RASAero II 1.0.2.0 is expected at `C:\Program Files (x86)\RASAero II\RASAero II.exe`
(change `rasaero_exe` in `worker_config.json` otherwise).

## How jobs reach the VM

`worker.transport` in `config.yaml`:

* **agent** (default whenever UTM's `utmctl` is found): no shared folder at
  all. The Mac pushes `job.json`, `input.CDX1` and the motor file into
  `C:\rpa\jobs\<name>` through UTM's guest agent, the worker runs entirely
  from local disk, zips the results into `done.zip`, and the Mac pulls that
  back (`rpa/vmagent.py`, `rpa/jobs.py`). The worker files themselves live in
  `C:\rpa\worker` (pushed by the Start button and by every `rpa` command
  that talks to the VM); the launcher restarts the worker when they change.
  Heartbeat and console log are pulled back for the GUI.
* **share**: the original protocol over the `Z:` WebDAV share (`Z:\jobs`),
  kept as a fallback. The share drops out and caches file contents, which is
  why the worker copies each job locally and retries every share access.

The worker keeps **one RASAero session** across jobs of the same kind
(flight simulations vs. aero-plot exports) and only re-selects the motor
file when its hash changes; it restarts RASAero after a failure or every
`restart_every_jobs` jobs (`worker_config.json`, default 25).

## Run

The easy way: press **Start VM worker** in the GUI (`python -m rpa gui`,
worker card on the Overview or the note on any VM step). From the Mac it
boots the UTM VM if needed (`utmctl start`), pushes `vm_task.ps1` into the
guest through UTM's guest agent (`utmctl file push` / `utmctl exec`), which
registers a Windows scheduled task **RPAWorker** bound to the logged-on user
(so the worker runs on the desktop, where pywinauto can drive RASAero — the
guest agent itself runs as SYSTEM in session 0 and cannot), starts it, and
waits for the worker's heartbeat (`worker/heartbeat.json`, written every
15 s by `run_worker.py`). The task also fires at every Windows logon, so after
the first time the worker comes up by itself; **Stop worker** ends it. Config:
the `vm:` section of `config.yaml` (VM name, drive letter, task name). A user
must be logged on to Windows (enable auto-login for a hands-off VM).

By hand, inside the VM:

```
python Z:\worker\run_worker.py
```

(`run_worker.py` starts `rasaero_worker.py --jobs Z:\jobs --repo Z:\` as a
child, restarts it whenever the script changes on the share or it dies, and
mirrors its console output into `worker\console.log` so the Mac side can read
it. Running `rasaero_worker.py` directly still works but then a reload just
exits.)

```
```

Leave it running. On the Mac, `python -m rpa run` submits jobs and continues
automatically as each `done.json` appears.

## First-time bring-up (do this once)

The key sequences below were taken from the pyrasaero project (RASAero II
1.0.2.0) and the SOP's menu names; they have **not yet** been exercised on this
VM. Bring-up procedure:

1. `python -m rpa motors` on the Mac (creates `output/motors/all_motors.eng`).
2. In the VM: `python Z:\worker\rasaero_worker.py --inspect Z:\output\rasaero_ui.txt --inspect-cdx1 "Z:\input\RASAero (.CDX1)\RAS_v1.3.CDX1"`
   This starts RASAero, opens the file and the Flight Simulation window, and
   dumps every control name/menu it can see into `output/rasaero_ui.txt` plus a
   screenshot. Use it to correct `worker_config.json` (menu paths, button
   titles, number of `{RIGHT}` presses to reach *View Data*).
3. Run one characterization job: on the Mac `python -m rpa characterize --limit 1`,
   in the VM `python Z:\worker\rasaero_worker.py --jobs Z:\jobs --repo Z:\ --once`.
   Every job folder gets `worker.log`, and on failure `shotNN-*.png` screenshots
   and `ui_tree.txt`.

Things to confirm on the first job (the Mac side checks most of them and
fails loudly if they are wrong):

* **Motor names.** RASAero must list our motors as `27801O4192-01  (LiorsRocketOptimizer)`
  etc. (`rasaero.engine_name_format` in `config.yaml`). If every row comes back
  with `MaxAltitude = 0`, RASAero did not match the names — open the Flight
  Simulation dialog by hand, look at the motor drop-down, and fix the format.
* **Select Motor File** wants a single multi-motor `.eng` (we give it
  `output/motors/all_motors.eng`). If your RASAero build wants a *folder*,
  point it at `output/motors` by hand once (RASAero remembers it) and set
  `select_motor_file_each_job` to `false`.
* **Delay convention.** The characterization run checks that separation and
  ignition happen at `burnout + delay`; a mismatch is reported as
  `staging events do not match ...`.
* **Saving.** After *Rerun All* the worker closes the Flight Simulation
  window (answering *Yes*), presses Ctrl+S in the main window and verifies that
  `result.CDX1` changed on disk. If RASAero shows a *Save As* dialog instead,
  the worker fills in the path.

## Manual fallback

`python -m rpa run --worker-mode manual` prints, for each job, exactly what to
click in RASAero (open `input.CDX1`, Rerun All, optionally export row 1 to
`export.csv`, Save As `result.CDX1`) and continues as soon as the files appear.
