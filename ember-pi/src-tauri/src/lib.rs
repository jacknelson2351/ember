mod commands;

use tauri::{
    tray::{MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Manager,
};

struct TrayHandle {
    _tray: TrayIcon,
}

fn snap_to_top_center(window: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let scale = monitor.scale_factor();
        let phys = monitor.size();
        let screen_w = phys.width as f64 / scale;
        let top_margin: f64 = 18.0;
        let win_w = window.outer_size()
            .map(|s| s.width as f64 / scale)
            .unwrap_or(780.0);
        let x = ((screen_w - win_w) / 2.0).max(0.0);
        let _ = window.set_position(tauri::LogicalPosition::new(x, top_margin));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::PiState::new())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            if let Some(window) = app.get_webview_window("main") {
                snap_to_top_center(&window);
                let _ = window.show();
                let _ = window.set_focus();
            }

            let icon = tauri::image::Image::from_bytes(
                include_bytes!("../icons/32x32.png"),
            )
            .expect("icon load failed");

            let tray = TrayIconBuilder::new()
                .icon(icon)
                .tooltip("Coalfire Ember")
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                snap_to_top_center(&win);
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            app.manage(TrayHandle { _tray: tray });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::docker_run,
            commands::runtime_health,
            commands::ensure_runtime,
            commands::container_status,
            commands::container_start,
            commands::container_stop,
            commands::container_logs,
            commands::container_exec,
            commands::list_dir,
            commands::read_file,
            commands::write_file,
            commands::write_file_bytes,
            commands::copy_file,
            commands::delete_file,
            commands::shell_exec,
            commands::quit_app,
            commands::container_write_file,
            commands::pi_start,
            commands::pi_send,
            commands::pi_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
