//! Команды аудиовизуализатора.
//!
//! Жизненный цикл захвата:
//! * `audio_start` — поднять поток WASAPI loopback (идемпотентно);
//! * `audio_set_active` — «пауза» визуализации: поток жив, анализ выключен (0 % CPU на FFT);
//! * `audio_stop` — полностью освободить устройство;
//! * `audio_status` — текущее состояние (устройство, частота, причина отказа).

use tauri::{AppHandle, Manager, State};

use crate::error::Result;
use crate::events::{AudioInfoPayload, EV_AUDIO_FRAME, EV_AUDIO_INFO};
use crate::providers::audio::{AudioEvent, CaptureConfig};
use crate::state::AppState;

#[tauri::command]
pub fn audio_start(app: AppHandle, state: State<'_, AppState>) -> Result<AudioInfoPayload> {
    // Уже запущен — просто снимаем паузу.
    let already_running = {
        let guard = state.audio.handle.lock().unwrap();
        match guard.as_ref() {
            Some(handle) => {
                handle.set_active(true);
                true
            }
            None => false,
        }
    };
    if already_running {
        return Ok(state.audio.info.lock().unwrap().clone());
    }

    let app_thread = app.clone();
    let sink = move |event: AudioEvent| {
        let state = app_thread.state::<AppState>();
        match event {
            AudioEvent::Info {
                device,
                sample_rate,
                channels,
            } => {
                let payload = AudioInfoPayload {
                    available: true,
                    device: Some(device),
                    sample_rate: Some(sample_rate),
                    channels: Some(channels),
                    reason: None,
                };
                *state.audio.info.lock().unwrap() = payload.clone();
                crate::events::emit(&app_thread, EV_AUDIO_INFO, payload);
            }
            AudioEvent::Frame(frame) => {
                crate::events::emit(&app_thread, EV_AUDIO_FRAME, frame);
            }
            AudioEvent::Failed(reason) => {
                let payload = AudioInfoPayload {
                    available: false,
                    reason: Some(reason.clone()),
                    ..Default::default()
                };
                *state.audio.info.lock().unwrap() = payload.clone();
                crate::events::emit(&app_thread, EV_AUDIO_INFO, payload);
                // Освобождаем слот, чтобы пользователь мог перезапустить захват кнопкой.
                let mut guard = state.audio.handle.lock().unwrap();
                *guard = None;
                drop(guard);
                crate::events::toast(&app_thread, "error", reason);
            }
        }
    };

    let handle = crate::providers::audio::spawn(CaptureConfig::default(), sink)?;
    {
        let mut guard = state.audio.handle.lock().unwrap();
        *guard = Some(handle);
    }
    Ok(state.audio.info.lock().unwrap().clone())
}

#[tauri::command]
pub fn audio_set_active(state: State<'_, AppState>, active: bool) -> Result<()> {
    let guard = state.audio.handle.lock().unwrap();
    if let Some(handle) = guard.as_ref() {
        handle.set_active(active);
    }
    Ok(())
}

#[tauri::command]
pub fn audio_stop(app: AppHandle, state: State<'_, AppState>) -> Result<AudioInfoPayload> {
    let handle = state.audio.handle.lock().unwrap().take();
    if let Some(handle) = handle {
        handle.stop();
    }
    let payload = AudioInfoPayload {
        available: false,
        reason: Some("Захват остановлен".to_string()),
        ..Default::default()
    };
    *state.audio.info.lock().unwrap() = payload.clone();
    crate::events::toast(&app, "info", "Захват системного звука остановлен");
    Ok(payload)
}

#[tauri::command]
pub fn audio_status(state: State<'_, AppState>) -> Result<AudioInfoPayload> {
    Ok(state.audio.info.lock().unwrap().clone())
}
