//! Rocket Profile Analysis shell: starts the bundled Python service
//! (`resources/rpa-service/rpa-service --port 0 --announce`), reads the port it
//! prints, points the window at it, and stops it on exit. In development the
//! window loads Vite (devUrl), which proxies /api to a service you run yourself.
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct ServiceState {
    child: Mutex<Option<Child>>,
    port: Mutex<Option<u16>>,
}

fn service_binary(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let name = if cfg!(windows) { "rpa-service.exe" } else { "rpa-service" };
    let res = app.path().resource_dir().ok()?;
    for cand in [res.join("rpa-service").join(name), res.join("resources").join("rpa-service").join(name)] {
        if cand.exists() {
            return Some(cand);
        }
    }
    None
}

/// Start the service and wait (up to 60 s) for `RPA_SERVICE_PORT=<n>` on its stdout.
fn start_service(app: &tauri::AppHandle) -> Result<(Child, u16), String> {
    let bin = service_binary(app).ok_or("bundled rpa-service not found (resources/rpa-service)")?;
    let mut cmd = Command::new(&bin);
    cmd.args(["service", "--port", "0"]).stdout(Stdio::piped()).stderr(Stdio::inherit()).env("PYTHONUTF8", "1").env("RPA_PARENT_PID", std::process::id().to_string()).env("RPA_APP_DIR", bin.parent().and_then(|p| p.parent()).unwrap_or(&bin));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("cannot start {}: {e}", bin.display()))?;
    let stdout = child.stdout.take().ok_or("no stdout from the service")?;
    let mut reader = BufReader::new(stdout);
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("the service exited before announcing its port".into());
        }
        if let Some(rest) = line.trim().strip_prefix("RPA_SERVICE_PORT=") {
            let port: u16 = rest.trim().parse().map_err(|_| format!("bad port line: {line}"))?;
            // keep draining stdout so the child never blocks on a full pipe
            std::thread::spawn(move || {
                let mut l = String::new();
                while let Ok(n) = reader.read_line(&mut l) {
                    if n == 0 {
                        break;
                    }
                    l.clear();
                }
            });
            return Ok((child, port));
        }
        if Instant::now() > deadline {
            return Err("timed out waiting for the service".into());
        }
    }
}

#[tauri::command]
fn service_port(state: tauri::State<'_, ServiceState>) -> Option<u16> {
    *state.port.lock().unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ServiceState { child: Mutex::new(None), port: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![service_port])
        .setup(|app| {
            let handle = app.handle().clone();
            let dev = cfg!(dev);
            let url = if dev {
                // `npm run tauri dev`: Vite serves the UI and proxies the API to `rpa gui --port 8799`
                WebviewUrl::External("http://localhost:1420/".parse().unwrap())
            } else {
                match start_service(&handle) {
                    Ok((child, port)) => {
                        let st = handle.state::<ServiceState>();
                        *st.child.lock().unwrap() = Some(child);
                        *st.port.lock().unwrap() = Some(port);
                        WebviewUrl::External(format!("http://127.0.0.1:{port}/").parse().unwrap())
                    }
                    Err(e) => {
                        eprintln!("service: {e}");
                        WebviewUrl::App("error.html".into())
                    }
                }
            };
            WebviewWindowBuilder::new(app, "main", url)
                .title("Rocket Profile Analysis")
                .inner_size(1440.0, 920.0)
                .min_inner_size(960.0, 640.0)
                // the page handles file drops itself (HTML5 drag-and-drop uploads)
                .disable_drag_drop_handler()
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(mut child) = window.app_handle().state::<ServiceState>().child.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
