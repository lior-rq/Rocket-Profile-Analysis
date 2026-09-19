"""FastAPI routes: the same paths and JSON the browser front end has always
used, plus setup / engine / project routes for the app shell. Serves the
built UI (rpa/service/ui or app/dist) or the old static pages."""

from __future__ import annotations

import json
import os
import queue
import socket
import threading
import time
from pathlib import Path

import anyio
import yaml
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response, StreamingResponse

from .. import platform as PL
from .core import Service, json_default

UI_DIRS = [Path(__file__).resolve().parent / "ui", PL.REPO / "app" / "dist"]


def J(obj, status: int = 200) -> Response:
    return Response(content=json.dumps(obj, default=json_default), status_code=status, media_type="application/json", headers={"Cache-Control": "no-store"})


def ui_dir() -> Path | None:
    for d in UI_DIRS:
        if (d / "index.html").exists():
            return d
    return None


NO_UI = "<!doctype html><title>Rocket Profile Analysis</title><body style='font:15px system-ui;padding:2em'><h2>Rocket Profile Analysis</h2><p>The UI is not built. Run <code>npm run build</code> in <code>app/</code> (or use the installed app).</p><p>The API is up: <a href='/api/state'>/api/state</a></body>"


def create_app(svc: Service) -> FastAPI:
    app = FastAPI(title="Rocket Profile Analysis", docs_url=None, redoc_url=None, openapi_url="/api/openapi.json")
    app.state.svc = svc

    @app.exception_handler(PermissionError)
    async def _forbidden(_r, e):
        return J({"error": f"forbidden: {e}"}, 403)

    @app.exception_handler(FileNotFoundError)
    async def _missing(_r, e):
        return J({"error": f"not found: {e}"}, 404)

    @app.exception_handler(KeyError)
    async def _key(_r, e):
        return J({"error": f"missing query parameter {e}"}, 400)

    @app.exception_handler(ValueError)
    async def _value(_r, e):
        return J({"error": str(e)}, 400)

    @app.exception_handler(Exception)
    async def _other(_r, e):
        import traceback

        traceback.print_exception(e)
        return J({"error": f"{type(e).__name__}: {e}"}, 500)

    # ---- pages ----------------------------------------------------------------
    @app.get("/")
    @app.get("/index.html")
    async def index():
        d = ui_dir()
        if d is None:
            return Response(NO_UI, media_type="text/html")
        return FileResponse(str(d / "index.html"), media_type="text/html", headers={"Cache-Control": "no-store"})

    @app.get("/assets/{rest:path}")
    async def assets(rest: str):
        d = ui_dir()
        if d is None:
            return J({"error": "not found"}, 404)
        p = (d / "assets" / rest).resolve()
        if (d / "assets").resolve() not in p.parents or not p.is_file():
            return J({"error": "not found"}, 404)
        return FileResponse(str(p), headers={"Cache-Control": "max-age=31536000, immutable"})

    # ---- api: reads -----------------------------------------------------------
    @app.get("/api/ping")
    async def ping():
        return J({"app": "rpa", "root": str(svc.root), "pid": __import__("os").getpid(), "running": svc.runner.current()["running"], "version": version()})

    @app.get("/api/version")
    async def api_version():
        return J({"version": version(), "platform": PL.summary()})

    @app.get("/api/state")
    async def state():
        return J(await anyio.to_thread.run_sync(svc.snapshot))

    @app.get("/api/engine")
    async def engine():
        return J(await anyio.to_thread.run_sync(svc.engine_info))

    @app.get("/api/setup")
    async def setup():
        return J(await anyio.to_thread.run_sync(svc.setup_info))

    @app.get("/api/config")
    async def config_get():
        return J(svc.config_payload())

    @app.get("/api/log")
    async def log(request: Request):
        after = int(request.query_params.get("after", "0"))
        return J({"lines": svc.runner.lines_after(after), "runner": svc.runner.current()})

    @app.get("/api/table/{name}")
    async def table(name: str, request: Request):
        lim = request.query_params.get("limit")
        return J(await anyio.to_thread.run_sync(svc.table, name, int(lim) if lim else None))

    @app.get("/api/history")
    async def history(request: Request):
        q = request.query_params
        return J(await anyio.to_thread.run_sync(svc.history, q["path"], int(q.get("max", "1500"))))

    @app.get("/api/motors")
    async def motors():
        return J(await anyio.to_thread.run_sync(svc.motors))

    @app.get("/api/samples")
    async def samples(request: Request):
        q = request.query_params
        return J(svc.samples(q.get("keys", q.get("key"))))

    @app.get("/api/shortlist")
    async def shortlist_get():
        return J(svc.shortlist())

    @app.get("/api/runs")
    async def runs():
        return J({"history": svc.runner.history, "runner": svc.runner.current()})

    @app.get("/api/archives")
    async def archives():
        return J(svc.archives())

    @app.get("/api/archive")
    async def archive_get(request: Request):
        return J(svc.archive_designs(request.query_params["name"]))

    @app.get("/api/disk")
    async def disk():
        return J(svc.disk_usage())

    @app.get("/api/design")
    async def design(request: Request):
        q = request.query_params
        return J(await anyio.to_thread.run_sync(svc.design.design, q["booster"], q.get("sustainer"), q.get("profile")))

    @app.get("/api/flight")
    async def flight(request: Request):
        q = request.query_params
        mass = float(q["mass"]) if q.get("mass") not in (None, "") else None
        return J(await anyio.to_thread.run_sync(svc.simulate, q["booster"], q["sustainer"], q.get("profile", ""), float(q["sep"]), float(q["ign"]), mass))

    @app.get("/api/report")
    async def report():
        p = svc.root / "output" / "report.md"
        return J({"text": p.read_text(encoding="utf-8") if p.exists() else "", "exists": p.exists()})

    @app.get("/api/text")
    async def text(request: Request):
        rel = request.query_params["path"]
        p = svc.resolve(rel)
        return J({"path": rel, "text": p.read_text(encoding="utf-8", errors="replace")[-200000:]})

    @app.get("/files/{rest:path}")
    async def files(rest: str):
        p = svc.resolve(rest)
        if not p.is_file():
            return J({"error": f"not found: {p.name}"}, 404)
        return FileResponse(str(p), headers={"Cache-Control": "no-store" if p.suffix in (".csv", ".json", ".md", ".log", ".txt") else "max-age=5"})

    @app.get("/download/eng")
    async def dl_eng(request: Request):
        q = request.query_params
        kind = q.get("kind", "booster")
        if kind not in ("booster", "sustainer"):
            return J({"error": "kind must be booster or sustainer"}, 400)
        name, data = svc.design.eng_download(kind, q["label"])
        return Response(content=data, media_type="text/plain; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})

    @app.get("/download/combo")
    async def dl_combo(request: Request):
        q = request.query_params
        name, data = svc.design.combo_download(q["booster"], q["sustainer"], q.get("profile"))
        return Response(content=data, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})

    @app.get("/download/bundle")
    async def dl_bundle(request: Request):
        which = request.query_params.get("which", "solved")
        if which not in ("solved", "shortlist"):
            return J({"error": "which must be solved or shortlist"}, 400)
        name, data = svc.design.bundle_download(which, svc.shortlist()["keys"] if which == "shortlist" else None)
        return Response(content=data, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})

    # ---- api: events ----------------------------------------------------------
    @app.get("/api/events")
    async def events(request: Request):
        q = svc.runner.subscribe()
        once = request.query_params.get("once") == "1"  # probe: the current state, then close

        def fmt(event, data):
            return f"event: {event}\ndata: {json.dumps(data, default=json_default)}\n\n"

        async def gen():
            try:
                yield fmt("state", svc.runner.current())
                while not once:
                    if await request.is_disconnected():
                        break
                    try:
                        event, data = await anyio.to_thread.run_sync(lambda: q.get(timeout=5))
                    except queue.Empty:
                        yield ": ping\n\n"
                        continue
                    yield fmt(event, data)
            finally:
                svc.runner.unsubscribe(q)

        return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no"})

    # ---- api: actions ---------------------------------------------------------
    async def body_of(request: Request) -> dict:
        raw = await request.body()
        return json.loads(raw.decode() or "{}") if raw else {}

    @app.post("/api/run")
    async def run(request: Request):
        b = await body_of(request)
        try:
            return J(svc.start_run(b.get("stage"), [str(a) for a in b.get("args", [])], b.get("label")))
        except RuntimeError as e:
            return J({"error": str(e)}, 409)

    @app.post("/api/cancel")
    async def cancel():
        return J({"cancelled": svc.runner.cancel()})

    @app.post("/api/archive")
    async def archive_post(request: Request):
        b = await body_of(request)
        snap = svc.snapshot_outputs(b.get("label"))
        return J(snap or {"error": "nothing to snapshot: no designs.csv"}, 200 if snap else 400)

    @app.post("/api/quit")
    async def quit_():
        svc.runner.note("gui: quitting - the server stops now; close this tab")
        threading.Thread(target=svc.shutdown, daemon=True).start()
        return J({"ok": True})

    @app.post("/api/motor_tree")
    async def motor_tree(request: Request):
        b = await body_of(request)
        return J(await anyio.to_thread.run_sync(svc.state.motor_tree, b.get("entries") or [], b.get("extra_folders") or []))

    @app.post("/api/upload")
    async def upload(request: Request):
        """Raw file body; ?kind=boosters|sustainers|models&name=<file or folder/file>."""
        q = request.query_params
        raw = await request.body()
        if len(raw) > 64 * 1024 * 1024:
            return J({"error": f"file too large ({len(raw) / 1048576:.0f} MB)"}, 400)
        return J(await anyio.to_thread.run_sync(svc.upload, q.get("kind", ""), q.get("name", ""), raw))

    @app.post("/api/browse")
    async def browse(request: Request):
        b = await body_of(request)
        return J(await anyio.to_thread.run_sync(svc.browse, str(b.get("kind", "file")), str(b.get("prompt", "Choose a file"))[:120].replace('"', "")))

    @app.post("/api/config")
    async def config_post(request: Request):
        b = await body_of(request)
        updates = b.get("set") or {}
        if not isinstance(updates, dict):
            return J({"error": "set must be an object"}, 400)
        try:
            return J(svc.update_config(updates))
        except (ValueError, yaml.YAMLError) as e:
            return J({"error": str(e)}, 400)

    @app.post("/api/reveal")
    async def reveal(request: Request):
        b = await body_of(request)
        svc.reveal(b.get("path", ""))
        return J({"ok": True})

    @app.post("/api/shortlist")
    async def shortlist_post(request: Request):
        return J(svc.set_shortlist(await body_of(request)))

    @app.post("/api/cleanup")
    async def cleanup(request: Request):
        b = await body_of(request)
        return J(svc.cleanup(str(b.get("what"))))

    @app.post("/api/store_path")
    async def store_path(request: Request):
        b = await body_of(request)
        return J({"path": svc.store_path(str(b.get("path", "")))})

    @app.post("/api/config_text")
    async def config_text(request: Request):
        b = await body_of(request)
        text = b.get("text")
        if not isinstance(text, str):
            return J({"error": "text must be a string"}, 400)
        try:
            yaml.safe_load(text)
        except yaml.YAMLError as e:
            return J({"error": f"not valid YAML: {e}"}, 400)
        (svc.root / "config.yaml").write_text(text, encoding="utf-8")
        svc._snapshot = None
        return J(svc.config_payload())

    @app.post("/api/setup/selftest")
    async def selftest():
        return J(await anyio.to_thread.run_sync(svc.selftest))

    @app.post("/api/project/new")
    async def project_new(request: Request):
        b = await body_of(request)
        return J(svc.new_project(str(b.get("name", "Project"))))

    # SPA fallback for the new UI's routes (never for /api, /files, /static)
    @app.get("/{rest:path}")
    async def spa(rest: str):
        if rest.startswith(("api/", "files/", "static/", "download/", "assets/")):
            return J({"error": "not found"}, 404)
        d = ui_dir()
        if d is None:
            return Response(NO_UI, media_type="text/html")
        return FileResponse(str(d / "index.html"), media_type="text/html", headers={"Cache-Control": "no-store"})

    return app


def version() -> str:
    from .. import __version__

    return __version__


def _parent_alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes

        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ok = ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(h)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return os.getppid() == pid


def _watch_parent(stop) -> None:
    """The desktop shell passes its pid; when it dies (crash, force quit) the
    service MUST NOT linger with its engine hosts. Polls every 2 s."""
    pid = os.environ.get("RPA_PARENT_PID")
    if not pid or not pid.isdigit():
        return

    def loop():
        while _parent_alive(int(pid)):
            time.sleep(2.0)
        stop()
        time.sleep(3.0)
        os._exit(0)

    threading.Thread(target=loop, name="parent-watch", daemon=True).start()


def serve(root: Path, port: int = 8765, open_browser: bool = True, quiet: bool = False, announce: bool = False):
    """Serve the app on 127.0.0.1. `port=0` picks a free port and, with
    `announce`, prints `RPA_SERVICE_PORT=<n>` for the shell. With a fixed port,
    a server already running for this project is reused (browser opened)."""
    import uvicorn

    from .launch import choose_port, notify, open_url, remove_lock, write_lock

    root = Path(root).resolve()
    reuse = port != 0
    if reuse:
        port, running = choose_port(port, root)
        if running is not None:
            url = f"http://127.0.0.1:{port}/"
            print(f"Rocket Profile Analysis: already running at {url} (pid {running.get('pid')}) - opening the browser", flush=True)
            notify("Rocket Profile Analysis", "The app is already running - opening it")
            if open_browser:
                open_url(url)
                time.sleep(2.0)
            return
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", port))
    sock.listen(128)
    port = sock.getsockname()[1]
    url = f"http://127.0.0.1:{port}/"
    svc = Service(root)
    app = create_app(svc)
    config = uvicorn.Config(app, log_level="warning", access_log=False, timeout_graceful_shutdown=2)
    server = uvicorn.Server(config)
    svc.on_quit = lambda: setattr(server, "should_exit", True)
    _watch_parent(svc.on_quit)
    if announce:
        print(f"RPA_SERVICE_PORT={port}", flush=True)
    elif not quiet:
        print(f"Rocket Profile Analysis: {url}  (Ctrl-C to stop, or Quit in the page header)", flush=True)
    if reuse:
        write_lock(root, port)
    if open_browser:
        threading.Timer(0.6, lambda: open_url(url)).start()
    try:
        server.run(sockets=[sock])
    except KeyboardInterrupt:
        pass
    finally:
        svc.runner.cancel()
        svc.close()
        if reuse:
            remove_lock(root)
