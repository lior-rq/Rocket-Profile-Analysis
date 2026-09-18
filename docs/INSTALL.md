# Install

Rocket Profile Analysis ships as one download per platform from the
[Releases page](https://github.com/lior-rq/Rocket-Profile-Analysis/releases/latest):

| Platform | File | Notes |
|---|---|---|
| macOS (Apple silicon) | `Rocket.Profile.Analysis_<version>_aarch64.dmg` | drag to Applications |
| Windows 10/11 (x64) | `Rocket.Profile.Analysis_<version>_x64-setup.exe` | per-user install, no admin needed |

The RASAero II flight engine and the Python service are inside the app.
The only thing you install yourself is **OpenRocket 24.12** (its own
installer bundles the Java runtime): `/Applications/OpenRocket.app` on
macOS, `C:\Program Files\OpenRocket` on Windows. The app finds it there;
a different location can be set on the Settings page.

## First launch

1. macOS: the app is not notarized. Gatekeeper says "cannot be opened" the
   first time; right-click the app, choose **Open**, then **Open** again. If it
   says "damaged", run once in Terminal:
   `xattr -cr "/Applications/Rocket Profile Analysis.app"`.
   Windows: SmartScreen shows "unrecognized app"; choose **More info** then
   **Run anyway**.
2. The app creates the project `Project` from the bundled template under
   `~/Library/Application Support/Rocket Profile Analysis/projects` (macOS) or
   `%LOCALAPPDATA%\Rocket Profile Analysis\projects` (Windows).
3. The Setup page shows what was found (OpenRocket, engine) and runs a
   self-test: one flight through the bundled engine and one OpenRocket
   mass query. Green on both means every stage works.
4. Inputs: drop your `.ork`, `.CDX1` and motor files on the page (or pick
   them), press **Check**, then follow the steps left to right. A template
   built on a machine with a project in place already has those files.

## Updates

The app checks the Releases page on start and offers the new version; the
download replaces the app in place.

## Where things are

| | macOS | Windows |
|---|---|---|
| projects | `~/Library/Application Support/Rocket Profile Analysis/projects` | `%LOCALAPPDATA%\Rocket Profile Analysis\projects` |
| service log | same folder, `service.log` | same folder, `service.log` |
| bundled engine | `Rocket Profile Analysis.app/Contents/Resources/rasaero` | `<install dir>\rasaero` |

Each project is a plain folder (`config.yaml`, `input/`, `output/`), so it
can be zipped and shared; the Settings page opens it in Finder / Explorer.

## Building it yourself

```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
python tools/rasaero_fetch.py            # RASAero II engine (needs dotnet + msitools)
build/build_service.sh                   # UI, PyInstaller service, host, template -> build/dist
cd app && TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/rpa.key)" npm run tauri build
                                         # DMG in app/src-tauri/target/release/bundle; the key signs
                                         # the updater archive (skip the variable for a local test build)
```

Windows: `build\build_service.ps1` then the same `npm run tauri build`
(NSIS installer). Prerequisites on both: Python 3.11+, Node 20+, Rust
(stable), .NET SDK 8.

## Releasing

1. Bump `version` in `pyproject.toml` and run `python build/sync_version.py`
   (writes `rpa/__init__.py`, `app/package.json`, `tauri.conf.json`).
2. The updater's private key must be the repository secret
   `TAURI_SIGNING_PRIVATE_KEY` (generated once with
   `npx tauri signer generate -w ~/.tauri/rpa.key`; the matching public key
   is already in `tauri.conf.json`).
3. Tag and push: `git tag v1.0.0 && git push --tags`. `release.yml` builds
   the DMG on macOS and the NSIS installer on Windows, uploads both plus
   `latest.json` to the GitHub release, and running apps offer the update.
