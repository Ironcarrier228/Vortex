//! Окно вывода на второй монитор.
//!
//! Требование: «отдельное безрамочное окно для вывода на второй монитор и полноэкранный режим».
//! Поэтому окно создаётся без декораций, всегда сверху и сразу в полноэкранном режиме на
//! выбранном мониторе. Фронтенд в этом окне по метке `output` рисует только визуализацию
//! без HUD.

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::Result;
use crate::events::EV_OUTPUT_WINDOW;

pub const OUTPUT_LABEL: &str = "output";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputWindowPayload {
    pub open: bool,
    pub monitor: Option<usize>,
    pub label: String,
}

#[tauri::command]
pub fn open_output_window(app: AppHandle, monitor: Option<usize>) -> Result<OutputWindowPayload> {
    if let Some(existing) = app.get_webview_window(OUTPUT_LABEL) {
        let _ = existing.set_fullscreen(true);
        let _ = existing.set_focus();
        let payload = OutputWindowPayload {
            open: true,
            monitor,
            label: OUTPUT_LABEL.to_string(),
        };
        crate::events::emit(&app, EV_OUTPUT_WINDOW, payload.clone());
        return Ok(payload);
    }

    // Выбираем монитор: по умолчанию — второй, если он есть.
    let monitors = app.available_monitors().unwrap_or_default();
    let index = match monitor {
        Some(value) if value < monitors.len() => value,
        _ if monitors.len() > 1 => 1,
        _ => 0,
    };
    let target = monitors.get(index).or_else(|| monitors.first()).cloned();

    let mut builder = WebviewWindowBuilder::new(
        &app,
        OUTPUT_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("VORTEX — вывод")
    .decorations(false)
    .always_on_top(true)
    .fullscreen(true)
    .resizable(true);

    if let Some(monitor) = target.as_ref() {
        let position = monitor.position();
        let size = monitor.size();
        builder = builder
            .position(position.x as f64, position.y as f64)
            .inner_size(size.width as f64, size.height as f64);
    }

    let window = builder
        .build()
        .map_err(|e| format!("Не удалось создать окно вывода: {e}"))?;
    let _ = window.set_fullscreen(true);

    let payload = OutputWindowPayload {
        open: true,
        monitor: Some(index),
        label: OUTPUT_LABEL.to_string(),
    };
    crate::events::emit(&app, EV_OUTPUT_WINDOW, payload.clone());
    Ok(payload)
}

#[tauri::command]
pub fn close_output_window(app: AppHandle) -> Result<OutputWindowPayload> {
    if let Some(existing) = app.get_webview_window(OUTPUT_LABEL) {
        let _ = existing.close();
    }
    let payload = OutputWindowPayload {
        open: false,
        monitor: None,
        label: OUTPUT_LABEL.to_string(),
    };
    crate::events::emit(&app, EV_OUTPUT_WINDOW, payload.clone());
    Ok(payload)
}

/// Переключить полноэкранный режим главного окна (используется хоткеем F).
#[tauri::command]
pub fn toggle_main_fullscreen(app: AppHandle, fullscreen: bool) -> Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_fullscreen(fullscreen)
            .map_err(|e| format!("Полноэкранный режим: {e}"))?;
    }
    Ok(())
}
