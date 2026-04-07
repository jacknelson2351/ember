use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::Mutex,
};
use tauri::{Emitter, Manager};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

// ── Pi session state ─────────────────────────────────────────────────────────

pub struct PiState(pub Mutex<Option<BufWriter<std::process::ChildStdin>>>);

impl PiState {
    pub fn new() -> Self {
        PiState(Mutex::new(None))
    }
}

const DEFAULT_IMAGE_TAG: &str = "coalfire-ember-runtime:latest";
const DEFAULT_MODEL_CONFIG: &str = r#"{
  "provider": "lmstudio",
  "endpoint": "http://localhost:1234/v1",
  "model": "",
  "apiKey": ""
}
"#;
const DEFAULT_AGENT_CONFIG: &str = r#"{
  "systemPrompt": "Your name is Ember. You are a security-focused AI assistant running inside a dockerized Kali Linux environment. You have access to standard security tooling and the shared workspace mounted at /workspace. You are allowed to create and modify files under /workspace, and anything you generate that the user should be able to inspect should be saved there with a clear path. Always explain what you are doing before executing commands.",
  "skills": [],
  "tools": []
}
"#;

#[derive(Serialize, Deserialize, Debug)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified: u64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealth {
    pub docker_status: String,
    pub container_status: String,
    pub container_exists: bool,
    pub image_exists: bool,
    pub image_tag: String,
    pub container_name: String,
    pub shared_path: String,
    pub config_path: String,
    pub memory_path: String,
    pub message: String,
}

struct RuntimePaths {
    shared: PathBuf,
    config: PathBuf,
    memory: PathBuf,
}

enum DockerAvailability {
    Ready,
    Missing(String),
    DaemonOffline(String),
    Error(String),
}

// ── Docker / runtime bootstrap ──────────────────────────────────────────────

#[tauri::command]
pub async fn docker_run(args: Vec<String>) -> Result<CommandResult, String> {
    let output = docker_cmd()
        .args(&args)
        .output()
        .map_err(|e| format!("docker not found: {e}"))?;
    Ok(command_result(output))
}

#[tauri::command]
pub async fn runtime_health(
    app: tauri::AppHandle,
    container_name: String,
) -> Result<RuntimeHealth, String> {
    let paths = ensure_runtime_dirs(&app)?;
    Ok(inspect_runtime(&paths, container_name))
}

#[tauri::command]
pub async fn ensure_runtime(
    app: tauri::AppHandle,
    container_name: String,
) -> Result<RuntimeHealth, String> {
    let paths = ensure_runtime_dirs(&app)?;
    let docker_dir = docker_context_dir(&app)?;

    match docker_availability() {
        DockerAvailability::Ready => {}
        DockerAvailability::Missing(message)
        | DockerAvailability::DaemonOffline(message)
        | DockerAvailability::Error(message) => return Err(message),
    }

    if !image_exists(DEFAULT_IMAGE_TAG) {
        let output = docker_cmd()
            .current_dir(&docker_dir)
            .args(["build", "-t", DEFAULT_IMAGE_TAG, "."])
            .output()
            .map_err(|e| format!("failed to build runtime image: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "docker build failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }

    if !container_exists(&container_name) {
        let shared_mount = format!("{}:/workspace", display_path(&paths.shared));
        let config_mount = format!("{}:/config", display_path(&paths.config));
        let memory_mount = format!("{}:/memory", display_path(&paths.memory));

        let output = docker_cmd()
            .args([
                "run",
                "-d",
                "--name",
                &container_name,
                "-v",
                &shared_mount,
                "-v",
                &config_mount,
                "-v",
                &memory_mount,
                "-e",
                "TERM=xterm-256color",
                DEFAULT_IMAGE_TAG,
            ])
            .output()
            .map_err(|e| format!("failed to create runtime container: {e}"))?;

        if !output.status.success() {
            return Err(format!(
                "docker run failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    } else if container_status_raw(&container_name) != "running" {
        let output = docker_cmd()
            .args(["start", &container_name])
            .output()
            .map_err(|e| format!("failed to start runtime container: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
    }

    Ok(inspect_runtime(&paths, container_name))
}

#[tauri::command]
pub async fn container_status(
    app: tauri::AppHandle,
    container_name: String,
) -> Result<String, String> {
    let paths = ensure_runtime_dirs(&app)?;
    Ok(inspect_runtime(&paths, container_name).container_status)
}

#[tauri::command]
pub async fn container_start(
    app: tauri::AppHandle,
    container_name: String,
) -> Result<RuntimeHealth, String> {
    ensure_runtime(app, container_name).await
}

#[tauri::command]
pub async fn container_stop(container_name: String) -> Result<(), String> {
    let out = docker_cmd()
        .args(["stop", &container_name])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

#[tauri::command]
pub async fn container_logs(container_name: String, tail: u32) -> Result<String, String> {
    let tail_s = tail.to_string();
    let out = docker_cmd()
        .args(["logs", "--tail", &tail_s, &container_name])
        .output()
        .map_err(|e| e.to_string())?;
    let mut s = String::from_utf8_lossy(&out.stdout).to_string();
    s.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(s)
}

#[tauri::command]
pub async fn container_exec(
    container_name: String,
    cmd: String,
    args: Vec<String>,
) -> Result<CommandResult, String> {
    let mut docker_args = vec!["exec".to_string(), container_name, cmd];
    docker_args.extend(args);
    let out = docker_cmd()
        .args(&docker_args)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(command_result(out))
}

// ── File system ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<FileInfo>, String> {
    let dir = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut files: Vec<FileInfo> = dir
        .flatten()
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            Some(FileInfo {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                size: meta.len(),
                is_dir: meta.is_dir(),
                modified,
            })
        })
        .collect();
    files.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(files)
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if let Some(parent) = path_buf.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            relax_dir_permissions(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::write(&path_buf, content).map_err(|e| e.to_string())?;
    relax_file_permissions(&path_buf).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn copy_file(src: String, dest: String) -> Result<(), String> {
    // Ensure destination parent directory exists
    if let Some(parent) = PathBuf::from(&dest).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            relax_dir_permissions(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::copy(&src, &dest).map_err(|e| format!("{src} → {dest}: {e}"))?;
    relax_file_permissions(Path::new(&dest)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_file_bytes(path: String, data_base64: String) -> Result<(), String> {
    use std::io::Write as _;
    let bytes = base64_decode(&data_base64)?;
    let path_buf = PathBuf::from(&path);
    if let Some(parent) = path_buf.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            relax_dir_permissions(parent).map_err(|e| e.to_string())?;
        }
    }
    let mut file = fs::File::create(&path_buf).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())
        ?;
    relax_file_permissions(&path_buf).map_err(|e| e.to_string())
}

/// Write a text file inside a running container via `docker exec`.
/// Content is base64-encoded to survive shell quoting intact.
#[tauri::command]
pub async fn container_write_file(
    container_name: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let encoded = base64_encode(content.as_bytes());
    // printf is more portable than echo for binary content
    let script = format!(
        "mkdir -p \"$(dirname '{path}')\" && printf '%s' '{encoded}' | base64 -d > '{path}'"
    );
    let out = docker_cmd()
        .args(&["exec", &container_name, "sh", "-c", &script])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

fn base64_encode(input: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut i = 0;
    while i < input.len() {
        let b0 = input[i] as u32;
        let b1 = if i + 1 < input.len() { input[i + 1] as u32 } else { 0 };
        let b2 = if i + 2 < input.len() { input[i + 2] as u32 } else { 0 };
        out.push(CHARS[(b0 >> 2) as usize] as char);
        out.push(CHARS[((b0 & 3) << 4 | b1 >> 4) as usize] as char);
        out.push(if i + 1 < input.len() { CHARS[((b1 & 0xf) << 2 | b2 >> 6) as usize] as char } else { '=' });
        out.push(if i + 2 < input.len() { CHARS[(b2 & 0x3f) as usize] as char } else { '=' });
        i += 3;
    }
    out
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let input = input.trim();
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut table = [0u8; 256];
    for (i, &c) in alphabet.iter().enumerate() {
        table[c as usize] = i as u8;
    }
    let clean: Vec<u8> = input.bytes().filter(|&b| b != b'=').collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for b in clean {
        buf = (buf << 6) | (table[b as usize] as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&path).map_err(|e| e.to_string())
    }
}

// ── Shell ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn shell_exec(program: String, args: Vec<String>) -> Result<CommandResult, String> {
    let out = Command::new(&program)
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run {program}: {e}"))?;
    Ok(command_result(out))
}

#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn ensure_runtime_dirs(app: &tauri::AppHandle) -> Result<RuntimePaths, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;

    fs::create_dir_all(&root).map_err(|e| format!("failed to create app data dir: {e}"))?;

    let shared = root.join("shared");
    let config = root.join("config");
    let memory = root.join("memory");

    fs::create_dir_all(&shared).map_err(|e| e.to_string())?;
    fs::create_dir_all(&config).map_err(|e| e.to_string())?;
    fs::create_dir_all(&memory).map_err(|e| e.to_string())?;

    seed_file(config.join("model.json"), DEFAULT_MODEL_CONFIG)?;
    seed_file(config.join("agent.json"), DEFAULT_AGENT_CONFIG)?;
    seed_file(memory.join("notes.json"), "[]\n")?;
    seed_file(memory.join("session.json"), "[]\n")?;
    relax_shared_tree(&shared).map_err(|e| format!("failed to prepare shared workspace permissions: {e}"))?;

    Ok(RuntimePaths {
        shared,
        config,
        memory,
    })
}

fn docker_context_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let repo_candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("docker");
    if repo_candidate.exists() {
        return Ok(repo_candidate);
    }

    let resource_candidate = app
        .path()
        .resource_dir()
        .map_err(|e| format!("failed to resolve resource dir: {e}"))?
        .join("docker");

    if resource_candidate.exists() {
        return Ok(resource_candidate);
    }

    Err("Docker build context not found in resources.".to_string())
}

fn relax_shared_tree(root: &Path) -> std::io::Result<()> {
    relax_dir_permissions(root)?;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let meta = entry.metadata()?;
        if meta.is_dir() {
            relax_shared_tree(&path)?;
        } else if meta.is_file() {
            relax_file_permissions(&path)?;
        }
    }
    Ok(())
}

fn relax_dir_permissions(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o777))?;
    }
    Ok(())
}

fn relax_file_permissions(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o666))?;
    }
    Ok(())
}

fn seed_file(path: PathBuf, contents: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    fs::write(path, contents).map_err(|e| e.to_string())
}

fn docker_availability() -> DockerAvailability {
    match docker_cmd().arg("info").output() {
        Ok(output) if output.status.success() => DockerAvailability::Ready,
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
            if stderr.contains("cannot connect to the docker daemon")
                || stderr.contains("is the docker daemon running")
            {
                DockerAvailability::DaemonOffline(
                    "Docker is installed but the daemon is not running.".to_string(),
                )
            } else {
                DockerAvailability::Error(
                    String::from_utf8_lossy(&output.stderr).trim().to_string(),
                )
            }
        }
        Err(error) => {
            if error.kind() == std::io::ErrorKind::NotFound {
                DockerAvailability::Missing("Docker CLI was not found on this machine.".to_string())
            } else {
                DockerAvailability::Error(format!("Failed to run docker: {error}"))
            }
        }
    }
}

fn inspect_runtime(paths: &RuntimePaths, container_name: String) -> RuntimeHealth {
    let availability = docker_availability();
    let docker_status = match &availability {
        DockerAvailability::Ready => "ready",
        DockerAvailability::Missing(_) => "missing",
        DockerAvailability::DaemonOffline(_) => "daemon_offline",
        DockerAvailability::Error(_) => "error",
    }
    .to_string();

    let image_exists = matches!(availability, DockerAvailability::Ready) && image_exists(DEFAULT_IMAGE_TAG);
    let container_exists = matches!(availability, DockerAvailability::Ready) && container_exists(&container_name);
    let container_status = if container_exists {
        map_container_status(container_status_raw(&container_name))
    } else {
        "stopped".to_string()
    };

    let message = match availability {
        DockerAvailability::Ready => {
            if container_status == "running" {
                "Docker runtime ready.".to_string()
            } else if container_exists {
                "Docker is ready. Runtime container is created but not running.".to_string()
            } else if image_exists {
                "Docker is ready. Runtime image exists and the container can be created.".to_string()
            } else {
                "Docker is ready. The runtime image still needs to be built.".to_string()
            }
        }
        DockerAvailability::Missing(message)
        | DockerAvailability::DaemonOffline(message)
        | DockerAvailability::Error(message) => message,
    };

    RuntimeHealth {
        docker_status,
        container_status,
        container_exists,
        image_exists,
        image_tag: DEFAULT_IMAGE_TAG.to_string(),
        container_name,
        shared_path: display_path(&paths.shared),
        config_path: display_path(&paths.config),
        memory_path: display_path(&paths.memory),
        message,
    }
}

fn image_exists(image_tag: &str) -> bool {
    docker_cmd()
        .args(["image", "inspect", image_tag])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn container_exists(container_name: &str) -> bool {
    docker_cmd()
        .args(["container", "inspect", container_name])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn container_status_raw(container_name: &str) -> String {
    docker_cmd()
        .args(["inspect", "--format", "{{.State.Status}}", container_name])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_else(|_| "stopped".to_string())
}

fn map_container_status(raw: String) -> String {
    match raw.as_str() {
        "running" => "running".to_string(),
        "restarting" | "created" => "starting".to_string(),
        "removing" | "paused" | "exited" | "dead" => "stopped".to_string(),
        _ => "stopped".to_string(),
    }
}

fn display_path(path: &PathBuf) -> String {
    path.to_string_lossy().to_string()
}

// Returns a docker Command with an extended PATH so Docker Desktop and
// Homebrew installations are reachable from Tauri's restricted environment.
fn docker_cmd() -> Command {
    let mut cmd = Command::new("docker");
    let current_path = std::env::var("PATH").unwrap_or_default();
    let mut full_path = [
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/opt/homebrew/bin",
        "/Applications/Docker.app/Contents/Resources/bin",
    ]
    .join(":");
    if !current_path.is_empty() {
        full_path.push(':');
        full_path.push_str(&current_path);
    }
    cmd.env("PATH", full_path);
    cmd
}

// ── Pi agent commands ────────────────────────────────────────────────────────

/// Spawn `docker exec -i <container> pi --mode rpc [extra_args]` with the
/// given environment variables, then stream every stdout line back to the
/// frontend as a `pi:event` Tauri event.
#[tauri::command]
pub async fn pi_start(
    app: tauri::AppHandle,
    container_name: String,
    env_vars: Vec<(String, String)>,
    extra_args: Vec<String>,
    state: tauri::State<'_, PiState>,
) -> Result<(), String> {
    // Build: docker exec [-e K=V …] -i <container> pi --mode rpc [extra_args]
    let mut docker_args: Vec<String> = vec!["exec".into()];
    for (k, v) in &env_vars {
        docker_args.push("-e".into());
        docker_args.push(format!("{k}={v}"));
    }
    docker_args.push("-w".into());
    docker_args.push("/workspace".into());
    docker_args.push("-i".into());
    docker_args.push(container_name);
    docker_args.push("pi".into());
    docker_args.push("--mode".into());
    docker_args.push("rpc".into());
    docker_args.extend(extra_args);

    let mut child = docker_cmd()
        .args(&docker_args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start pi: {e}"))?;

    let stdin = child.stdin.take().ok_or("pi: no stdin handle")?;
    let stdout = child.stdout.take().ok_or("pi: no stdout handle")?;
    let stderr = child.stderr.take().ok_or("pi: no stderr handle")?;

    // Store stdin for later pi_send calls
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        *guard = Some(BufWriter::new(stdin));
    }

    // Stream stdout lines → frontend events
    let app_out = app.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stdout).lines() {
            match line {
                Ok(l) if !l.trim().is_empty() => {
                    let _ = app_out.emit("pi:event", &l);
                }
                Err(_) => break,
                _ => {}
            }
        }
        let _ = app_out.emit("pi:ended", "");
    });

    // Stream stderr lines → frontend events (prefixed so UI can distinguish)
    let app_err = app.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stderr).lines() {
            if let Ok(l) = line {
                if !l.trim().is_empty() {
                    let _ = app_err.emit("pi:stderr", &l);
                }
            }
        }
    });

    // Reap child when it exits so we don't accumulate zombie processes
    std::thread::spawn(move || { let _ = child.wait(); });

    Ok(())
}

/// Write a JSONL command to pi's stdin.
#[tauri::command]
pub fn pi_send(line: String, state: tauri::State<'_, PiState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(stdin) = guard.as_mut() {
        writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("No active pi session — start one first".to_string())
    }
}

/// Close pi's stdin which signals it to exit cleanly.
#[tauri::command]
pub fn pi_stop(state: tauri::State<'_, PiState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None; // drop BufWriter → closes ChildStdin → pi receives EOF
    Ok(())
}

fn command_result(output: Output) -> CommandResult {
    CommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        success: output.status.success(),
    }
}
