//! VORTEX — Windows-приложение для 3D-визуализации данных.
//!
//! Схема работы:
//! ```text
//! providers/*  ──(колбэки)──►  commands/*  ──(события Tauri)──►  three.js во фронтенде
//!    ▲                             ▲
//!    │ Win32: WASAPI / iphlpapi /  │ invoke: audio_start, net_start, disk_scan, …
//!    │ jwalk / shell32             │
//! ```
//! Провайдеры ничего не знают о Tauri, команды — о графике. Фронтенд общается только
//! через `invoke` (запрос данных) и `listen` (потоки данных).

mod commands;
mod error;
pub mod events; // публичный модуль: пейлоады — контракт между Rust и TypeScript
mod providers;
mod state;

use tauri::Manager;

pub use error::Result;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(state::AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::system::sys_info,
            commands::audio::audio_start,
            commands::audio::audio_set_active,
            commands::audio::audio_stop,
            commands::audio::audio_status,
            commands::net::net_start,
            commands::net::net_stop,
            commands::net::net_snapshot,
            commands::disk::disk_scan,
            commands::disk::disk_cancel,
            commands::disk::disk_children,
            commands::disk::disk_stats,
            commands::disk::disk_delete_to_trash,
            commands::window::open_output_window,
            commands::window::close_output_window,
            commands::window::toggle_main_fullscreen,
        ])
        // ВНИМАНИЕ: `on_window_event` есть только у `Builder` и у `Window`,
        // но не у `App` — поэтому глобальный обработчик вешается здесь, а не в `setup`.
        .on_window_event(|window, event| {
            if window.label() != commands::window::OUTPUT_LABEL {
                return;
            }
            // Окно вывода закрыли (Esc/alt+F4/кнопка) — сообщаем главному окну,
            // чтобы HUD снял отметку «второй экран активен».
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let app = window.app_handle().clone();
                events::emit(
                    &app,
                    events::EV_OUTPUT_WINDOW,
                    events::OutputWindowPayload {
                        open: false,
                        monitor: None,
                        label: commands::window::OUTPUT_LABEL.to_string(),
                    },
                );
            }
        })
        .setup(|app| {
            // Информация о системе нужна HUD сразу, до первого invoke.
            let info = app.state::<state::AppState>().sys.clone();
            events::emit(app.handle(), events::EV_SYS_INFO, info);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Не удалось запустить VORTEX");
}
