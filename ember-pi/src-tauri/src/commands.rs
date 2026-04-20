use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs,
    io::{BufWriter, Write},
    net::{IpAddr, Ipv6Addr, ToSocketAddrs},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(test)]
use std::time::SystemTime;

const DEFAULT_IMAGE_TAG: &str = "coalfire-ember-runtime:latest";
const DEFAULT_MODEL_CONFIG: &str = r#"{
  "provider": "lmstudio",
  "endpoint": "http://localhost:1234/v1",
  "model": ""
}
"#;
const DEFAULT_AGENT_CONFIG: &str = r#"{
  "systemPrompt": "Your name is Ember. You are a security-focused AI assistant running inside a dockerized Kali Linux environment. You have access to standard security tooling and the shared workspace mounted at /workspace. You are allowed to create and modify files under /workspace, and anything you generate that the user should be able to inspect should be saved there with a clear path. Always explain what you are doing before executing commands.",
  "skills": [],
  "tools": []
}
"#;
const PI_CONFIG_PATH: &str = "/home/ember/.pi/agent/models.json";
const PI_CODING_AGENT_VERSION: &str = "0.65.2";
const KALI_BASE_IMAGE_AMD64: &str =
    "kalilinux/kali-rolling@sha256:428d23cea861aafc1ca719b22ae8088bd5f8160d44157f6d4710e7bf90053";
const KALI_BASE_IMAGE_ARM64: &str =
    "kalilinux/kali-rolling@sha256:fbceeeee0146200e173ef8d49498a50305071e5cd16b592e5cef44cd2bd0ca8b";
const RUNTIME_HEALTH_CACHE_TTL: Duration = Duration::from_secs(30);
const KEYCHAIN_SERVICE_NAME: &str = "com.coalfire.ember-pi.api-key";
const MAX_FETCH_BODY_BYTES: usize = 1_048_576;
const APPROVED_LOOPBACK_MODEL_PORTS: &[u16] = &[1234, 11434];

// ── Pi session state ─────────────────────────────────────────────────────────

pub struct PiState(pub Mutex<Option<BufWriter<std::process::ChildStdin>>>);

impl PiState {
    pub fn new() -> Self {
        PiState(Mutex::new(None))
    }
}

pub struct ContainerState(pub Mutex<Option<String>>);

impl ContainerState {
    pub fn new() -> Self {
        ContainerState(Mutex::new(None))
    }
}

pub struct RuntimeHealthCache(Mutex<Option<CachedRuntimeHealth>>);

impl RuntimeHealthCache {
    pub fn new() -> Self {
        RuntimeHealthCache(Mutex::new(None))
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
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

struct CachedRuntimeHealth {
    container_name: String,
    health: RuntimeHealth,
    checked_at: Instant,
}

enum DockerAvailability {
    Ready,
    Missing(String),
    DaemonOffline(String),
    Error(String),
}

// ── Docker / runtime bootstrap ──────────────────────────────────────────────

#[tauri::command]
pub async fn runtime_health(
    app: tauri::AppHandle,
    container_name: String,
    cache: tauri::State<'_, RuntimeHealthCache>,
) -> Result<RuntimeHealth, String> {
    if let Some(health) = cached_runtime_health(&cache, &container_name) {
        return Ok(health);
    }

    let paths = ensure_runtime_dirs(&app)?;
    let health = inspect_runtime(&paths, container_name.clone());
    store_runtime_health(&cache, container_name, &health);
    Ok(health)
}

#[tauri::command]
pub async fn ensure_runtime(
    app: tauri::AppHandle,
    container_name: String,
    container_state: tauri::State<'_, ContainerState>,
    cache: tauri::State<'_, RuntimeHealthCache>,
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
        let kali_base_image = kali_base_image_for_host()?;
        let build_arg_base = format!("KALI_BASE_IMAGE={kali_base_image}");
        let build_arg_pi = format!("PI_CODING_AGENT_VERSION={PI_CODING_AGENT_VERSION}");
        let output = docker_cmd()
            .current_dir(&docker_dir)
            .args([
                "build",
                "--build-arg",
                &build_arg_base,
                "--build-arg",
                &build_arg_pi,
                "-t",
                DEFAULT_IMAGE_TAG,
                ".",
            ])
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
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
    }

    if let Ok(mut guard) = container_state.0.lock() {
        *guard = Some(container_name.clone());
    }

    let health = inspect_runtime(&paths, container_name.clone());
    store_runtime_health(&cache, container_name, &health);
    Ok(health)
}

#[tauri::command]
pub async fn container_status(
    app: tauri::AppHandle,
    container_name: String,
    cache: tauri::State<'_, RuntimeHealthCache>,
) -> Result<String, String> {
    Ok(runtime_health(app, container_name, cache)
        .await?
        .container_status)
}

#[tauri::command]
pub async fn container_start(
    app: tauri::AppHandle,
    container_name: String,
    container_state: tauri::State<'_, ContainerState>,
    cache: tauri::State<'_, RuntimeHealthCache>,
) -> Result<RuntimeHealth, String> {
    ensure_runtime(app, container_name, container_state, cache).await
}

#[tauri::command]
pub async fn container_stop(
    container_name: String,
    container_state: tauri::State<'_, ContainerState>,
    cache: tauri::State<'_, RuntimeHealthCache>,
) -> Result<(), String> {
    if let Ok(mut guard) = container_state.0.lock() {
        *guard = None;
    }
    clear_runtime_health_cache(&cache);

    let out = docker_cmd()
        .args(["stop", &container_name])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[tauri::command]
pub async fn container_logs(container_name: String, tail: u32) -> Result<String, String> {
    let tail_s = tail.to_string();
    let out = docker_cmd()
        .args(["logs", "--tail", &tail_s, &container_name])
        .output()
        .map_err(|e| e.to_string())?;
    let mut output = String::from_utf8_lossy(&out.stdout).to_string();
    output.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(output)
}

// ── File system ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_dir(app: tauri::AppHandle, path: String) -> Result<Vec<FileInfo>, String> {
    let dir_path = resolve_runtime_path(&app, &path, RuntimePathAccess::ReadExisting)?;
    let meta = fs::metadata(&dir_path).map_err(|e| e.to_string())?;
    if !meta.is_dir() {
        return Err("path is not a directory".to_string());
    }

    let mut files: Vec<FileInfo> = fs::read_dir(&dir_path)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
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
pub async fn read_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let file_path = resolve_runtime_path(&app, &path, RuntimePathAccess::ReadExisting)?;
    let meta = fs::metadata(&file_path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("path is not a file".to_string());
    }
    fs::read_to_string(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_file(
    app: tauri::AppHandle,
    path: String,
    content: String,
) -> Result<(), String> {
    let file_path = resolve_runtime_path(&app, &path, RuntimePathAccess::WriteMaybeMissing)?;
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        relax_dir_permissions(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&file_path, content).map_err(|e| e.to_string())?;
    relax_file_permissions(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_file_bytes(
    app: tauri::AppHandle,
    path: String,
    data_base64: String,
) -> Result<(), String> {
    let bytes = BASE64_STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("invalid base64 payload: {e}"))?;
    let file_path = resolve_runtime_path(&app, &path, RuntimePathAccess::WriteMaybeMissing)?;
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        relax_dir_permissions(parent).map_err(|e| e.to_string())?;
    }
    let mut file = fs::File::create(&file_path).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    relax_file_permissions(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let target = resolve_runtime_path(&app, &path, RuntimePathAccess::ReadExisting)?;
    let meta = fs::metadata(&target).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&target).map_err(|e| e.to_string())
    }
}

// ── App / outbound helpers ──────────────────────────────────────────────────

#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub async fn test_endpoint(url: String, api_key: Option<String>) -> Result<u16, String> {
    let url = validate_model_discovery_url(&url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = client.get(url);
    if let Some(key) = api_key.filter(|key| !key.trim().is_empty()) {
        request = request.header("Authorization", format!("Bearer {key}"));
    }

    let response = request.send().await.map_err(|e| e.to_string())?;
    Ok(response.status().as_u16())
}

#[tauri::command]
pub async fn fetch_json(url: String, api_key: Option<String>) -> Result<String, String> {
    let url = validate_model_discovery_url(&url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = client.get(url);
    if let Some(key) = api_key.filter(|key| !key.trim().is_empty()) {
        request = request.header("Authorization", format!("Bearer {key}"));
    }

    let response = request.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_FETCH_BODY_BYTES {
        return Err("response body exceeded the 1 MiB limit".to_string());
    }

    String::from_utf8(bytes.to_vec()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_provider_api_key(provider: String) -> Result<Option<String>, String> {
    keychain_get(&provider)
}

#[tauri::command]
pub fn set_provider_api_key(provider: String, api_key: String) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return keychain_delete(&provider);
    }
    keychain_set(&provider, api_key.trim())
}

// ── Container file bootstrap ────────────────────────────────────────────────

#[tauri::command]
pub async fn container_write_file(
    container_name: String,
    path: String,
    content: String,
) -> Result<(), String> {
    validate_container_write_path(&path)?;
    let encoded = BASE64_STANDARD.encode(content.as_bytes());

    let mut child = docker_cmd()
        .args([
            "exec",
            "-i",
            &container_name,
            "sh",
            "-c",
            r#"mkdir -p "$(dirname "$1")" && base64 -d > "$1""#,
            "sh",
            &path,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or("docker exec stdin unavailable")?;
        stdin
            .write_all(encoded.as_bytes())
            .map_err(|e| format!("failed to stream file content: {e}"))?;
    }

    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

// ── Pi agent commands ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn pi_start(
    app: tauri::AppHandle,
    container_name: String,
    env_vars: Vec<(String, String)>,
    extra_args: Vec<String>,
    state: tauri::State<'_, PiState>,
) -> Result<(), String> {
    let mut docker_args: Vec<String> = vec!["exec".into()];
    for (key, value) in &env_vars {
        docker_args.push("-e".into());
        docker_args.push(format!("{key}={value}"));
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

    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        *guard = Some(BufWriter::new(stdin));
    }

    let app_out = app.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stdout).lines() {
            match line {
                Ok(line) if !line.trim().is_empty() => {
                    let _ = app_out.emit("pi:event", &line);
                }
                Err(_) => break,
                _ => {}
            }
        }
        let _ = app_out.emit("pi:ended", "");
    });

    let app_err = app.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stderr).lines() {
            if let Ok(line) = line {
                if !line.trim().is_empty() {
                    let _ = app_err.emit("pi:stderr", &line);
                }
            }
        }
    });

    std::thread::spawn(move || {
        let _ = child.wait();
    });

    Ok(())
}

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

#[tauri::command]
pub fn pi_stop(state: tauri::State<'_, PiState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
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

    relax_dir_permissions(&shared).map_err(|e| e.to_string())?;
    relax_dir_permissions(&config).map_err(|e| e.to_string())?;
    relax_dir_permissions(&memory).map_err(|e| e.to_string())?;

    seed_file(config.join("model.json"), DEFAULT_MODEL_CONFIG)?;
    seed_file(config.join("agent.json"), DEFAULT_AGENT_CONFIG)?;
    seed_file(memory.join("notes.json"), "[]\n")?;
    seed_file(memory.join("session.json"), "[]\n")?;

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

fn kali_base_image_for_host() -> Result<&'static str, String> {
    match std::env::consts::ARCH {
        "x86_64" => Ok(KALI_BASE_IMAGE_AMD64),
        "aarch64" | "arm64" => Ok(KALI_BASE_IMAGE_ARM64),
        other => Err(format!(
            "unsupported host architecture for pinned Kali image: {other}"
        )),
    }
}

fn relax_dir_permissions(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

fn relax_file_permissions(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o644))?;
    }
    Ok(())
}

fn seed_file(path: PathBuf, contents: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    fs::write(&path, contents).map_err(|e| e.to_string())?;
    relax_file_permissions(&path).map_err(|e| e.to_string())
}

#[derive(Clone, Copy)]
enum RuntimePathAccess {
    ReadExisting,
    WriteMaybeMissing,
}

fn resolve_runtime_path(
    app: &tauri::AppHandle,
    requested: &str,
    access: RuntimePathAccess,
) -> Result<PathBuf, String> {
    let paths = ensure_runtime_dirs(app)?;
    let allowed_roots = vec![
        canonicalize_existing_path(&paths.shared)?,
        canonicalize_existing_path(&paths.config)?,
        canonicalize_existing_path(&paths.memory)?,
    ];

    let requested_path = PathBuf::from(requested);
    let resolved = match access {
        RuntimePathAccess::ReadExisting => canonicalize_existing_path(&requested_path)?,
        RuntimePathAccess::WriteMaybeMissing => resolve_path_for_write(&requested_path)?,
    };

    if allowed_roots.iter().any(|root| resolved.starts_with(root)) {
        Ok(resolved)
    } else {
        Err("path is outside the app runtime directories".to_string())
    }
}

fn canonicalize_existing_path(path: &Path) -> Result<PathBuf, String> {
    validate_requested_path(path)?;
    path.canonicalize()
        .map_err(|e| format!("failed to resolve path {}: {e}", path.display()))
}

fn resolve_path_for_write(path: &Path) -> Result<PathBuf, String> {
    validate_requested_path(path)?;
    if path.exists() {
        return canonicalize_existing_path(path);
    }

    let mut current = path;
    let mut suffix: Vec<OsString> = Vec::new();
    while !current.exists() {
        let file_name = current
            .file_name()
            .ok_or("path must include an existing runtime root".to_string())?;
        suffix.push(file_name.to_os_string());
        current = current
            .parent()
            .ok_or("path must include an existing runtime root".to_string())?;
    }

    let mut resolved = canonicalize_existing_path(current)?;
    for component in suffix.iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn validate_requested_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("absolute paths are required".to_string());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("parent-directory traversal is not allowed".to_string());
    }
    Ok(())
}

fn validate_container_write_path(path: &str) -> Result<(), String> {
    let path = Path::new(path);
    let pi_config_dir = Path::new(PI_CONFIG_PATH)
        .parent()
        .ok_or("invalid Pi config path".to_string())?;
    if !path.is_absolute() {
        return Err("container writes require an absolute path".to_string());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("container write path cannot contain parent traversal".to_string());
    }
    if path.starts_with("/workspace") || path.starts_with(pi_config_dir) {
        Ok(())
    } else {
        Err("container writes are limited to /workspace and /home/ember/.pi/agent".to_string())
    }
}

fn validate_model_discovery_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;

    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("only http(s) URLs are allowed".to_string()),
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("embedded URL credentials are not allowed".to_string());
    }

    let path = parsed.path().trim_end_matches('/');
    if !is_model_discovery_path(path) {
        return Err("only model discovery endpoints are allowed".to_string());
    }

    let host = parsed
        .host_str()
        .ok_or("URL host is required".to_string())?
        .to_ascii_lowercase();
    let port = parsed
        .port_or_known_default()
        .ok_or("URL port is required".to_string())?;

    if is_explicit_local_model_host(&host) {
        if APPROVED_LOOPBACK_MODEL_PORTS.contains(&port) {
            return Ok(parsed);
        }
        return Err("loopback access is limited to approved local model ports".to_string());
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return Err(
                "private, loopback, metadata, and link-local addresses are blocked".to_string(),
            );
        }
        return Ok(parsed);
    }

    let resolved: Vec<IpAddr> = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("failed to resolve host {host}: {e}"))?
        .map(|addr| addr.ip())
        .collect();
    if resolved.is_empty() {
        return Err(format!("failed to resolve host {host}"));
    }
    if resolved.iter().any(|ip| is_blocked_ip(*ip)) {
        return Err(
            "private, loopback, metadata, and link-local addresses are blocked".to_string(),
        );
    }

    Ok(parsed)
}

fn is_model_discovery_path(path: &str) -> bool {
    matches!(path, "/models" | "/v1/models" | "/v1beta/models")
}

fn is_explicit_local_model_host(host: &str) -> bool {
    matches!(
        host,
        "localhost" | "127.0.0.1" | "::1" | "host.docker.internal"
    )
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_multicast()
                || ip.is_unspecified()
                || ip.is_documentation()
                || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
                || (ip.octets()[0] == 198 && matches!(ip.octets()[1], 18 | 19))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4() {
                return is_blocked_ip(IpAddr::V4(v4));
            }

            ip.is_loopback()
                || ip.is_multicast()
                || ip.is_unspecified()
                || is_ipv6_unique_local(ip)
                || is_ipv6_link_local(ip)
        }
    }
}

fn is_ipv6_unique_local(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

fn is_ipv6_link_local(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

fn cached_runtime_health(
    cache: &tauri::State<'_, RuntimeHealthCache>,
    container_name: &str,
) -> Option<RuntimeHealth> {
    let guard = cache.0.lock().ok()?;
    let cached = guard.as_ref()?;
    if cached.container_name == container_name
        && cached.checked_at.elapsed() < RUNTIME_HEALTH_CACHE_TTL
    {
        Some(cached.health.clone())
    } else {
        None
    }
}

fn store_runtime_health(
    cache: &tauri::State<'_, RuntimeHealthCache>,
    container_name: String,
    health: &RuntimeHealth,
) {
    if let Ok(mut guard) = cache.0.lock() {
        *guard = Some(CachedRuntimeHealth {
            container_name,
            health: health.clone(),
            checked_at: Instant::now(),
        });
    }
}

fn clear_runtime_health_cache(cache: &tauri::State<'_, RuntimeHealthCache>) {
    if let Ok(mut guard) = cache.0.lock() {
        *guard = None;
    }
}

fn validate_provider(provider: &str) -> Result<(), String> {
    match provider {
        "anthropic" | "custom" | "google" | "lmstudio" | "ollama" | "openai" => Ok(()),
        _ => Err("unsupported provider id".to_string()),
    }
}

#[cfg(target_os = "macos")]
fn keychain_get(provider: &str) -> Result<Option<String>, String> {
    validate_provider(provider)?;
    let output = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-a",
            provider,
            "-s",
            KEYCHAIN_SERVICE_NAME,
            "-w",
        ])
        .output()
        .map_err(|e| format!("failed to read macOS Keychain: {e}"))?;
    if output.status.success() {
        return Ok(Some(
            String::from_utf8_lossy(&output.stdout)
                .trim_end_matches('\n')
                .to_string(),
        ));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
    if stderr.contains("could not be found") {
        Ok(None)
    } else {
        Err(stderr.trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn keychain_get(provider: &str) -> Result<Option<String>, String> {
    validate_provider(provider)?;
    Ok(None)
}

#[cfg(target_os = "macos")]
fn keychain_set(provider: &str, api_key: &str) -> Result<(), String> {
    validate_provider(provider)?;
    let output = Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-a",
            provider,
            "-s",
            KEYCHAIN_SERVICE_NAME,
            "-w",
            api_key,
            "-U",
        ])
        .output()
        .map_err(|e| format!("failed to write macOS Keychain: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn keychain_set(provider: &str, _api_key: &str) -> Result<(), String> {
    validate_provider(provider)?;
    Err("secure API-key storage is only supported on macOS builds".to_string())
}

#[cfg(target_os = "macos")]
fn keychain_delete(provider: &str) -> Result<(), String> {
    validate_provider(provider)?;
    let output = Command::new("/usr/bin/security")
        .args([
            "delete-generic-password",
            "-a",
            provider,
            "-s",
            KEYCHAIN_SERVICE_NAME,
        ])
        .output()
        .map_err(|e| format!("failed to delete macOS Keychain item: {e}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
    if stderr.contains("could not be found") {
        Ok(())
    } else {
        Err(stderr.trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn keychain_delete(provider: &str) -> Result<(), String> {
    validate_provider(provider)?;
    Ok(())
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

    let image_exists =
        matches!(availability, DockerAvailability::Ready) && image_exists(DEFAULT_IMAGE_TAG);
    let container_exists =
        matches!(availability, DockerAvailability::Ready) && container_exists(&container_name);
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
                "Docker is ready. Runtime image exists and the container can be created."
                    .to_string()
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

fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub fn docker_cmd() -> Command {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("ember-{label}-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn resolve_path_for_write_allows_nested_paths_inside_existing_root() {
        let root = unique_temp_dir("write-path");
        fs::create_dir_all(&root).unwrap();
        let canonical_root = root.canonicalize().unwrap();

        let resolved = resolve_path_for_write(&root.join("nested/report.txt")).unwrap();
        assert_eq!(resolved, canonical_root.join("nested/report.txt"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolve_path_for_write_rejects_parent_traversal() {
        let root = unique_temp_dir("parent-traversal");
        fs::create_dir_all(&root).unwrap();

        let candidate = root.join("..").join("escape.txt");
        assert!(resolve_path_for_write(&candidate).is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validate_model_discovery_url_blocks_non_model_paths() {
        assert!(validate_model_discovery_url("http://127.0.0.1:1234/health").is_err());
    }

    #[test]
    fn validate_model_discovery_url_blocks_metadata_addresses() {
        assert!(validate_model_discovery_url("http://169.254.169.254/models").is_err());
    }

    #[test]
    fn validate_model_discovery_url_blocks_unapproved_loopback_ports() {
        assert!(validate_model_discovery_url("http://127.0.0.1:9999/models").is_err());
    }

    #[test]
    fn validate_model_discovery_url_allows_approved_loopback_model_ports() {
        assert!(validate_model_discovery_url("http://127.0.0.1:1234/models").is_ok());
        assert!(validate_model_discovery_url("http://localhost:11434/v1/models").is_ok());
    }
}
