//! Команды карты сети.
//!
//! Опрос идёт в отдельном потоке: `GetExtendedTcpTable` быстрый, но его нельзя вызывать
//! из главного потока — иначе UI (в т.ч. рендер) начнёт подтормаживать на больших таблицах.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use crate::error::Result;
use crate::events::{NetSnapshotPayload, EV_NET_SNAPSHOT};
use crate::state::AppState;

#[tauri::command]
pub fn net_start(
    app: AppHandle,
    state: State<'_, AppState>,
    poll_ms: Option<u64>,
) -> Result<NetSnapshotPayload> {
    let poll = poll_ms.unwrap_or(2000).clamp(500, 30_000);
    state.net.poll_ms.store(poll, Ordering::SeqCst);

    if state.net.running.swap(true, Ordering::SeqCst) {
        return Ok(state.net.latest.lock().unwrap().clone());
    }

    let app_thread = app.clone();
    std::thread::Builder::new()
        .name("vortex-net".to_string())
        .spawn(move || loop {
            let state = app_thread.state::<AppState>();
            if !state.net.running.load(Ordering::SeqCst) {
                break;
            }

            let snapshot = {
                let mut diff = state.net.diff.lock().unwrap();
                let mut cache = state.procs.lock().unwrap();
                crate::providers::network::snapshot(&mut cache, &mut diff, state.sys.elevated)
            };

            *state.net.latest.lock().unwrap() = snapshot.clone();
            state.net.polls.fetch_add(1, Ordering::Relaxed);
            crate::events::emit(&app_thread, EV_NET_SNAPSHOT, snapshot);

            let sleep_ms = state.net.poll_ms.load(Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(sleep_ms));
        })
        .map_err(|e| format!("Не удалось запустить поток опроса сети: {e}"))?;

    Ok(NetSnapshotPayload::default())
}

#[tauri::command]
pub fn net_stop(state: State<'_, AppState>) -> Result<()> {
    state.net.running.store(false, Ordering::SeqCst);
    Ok(())
}

/// Последний снимок (используется сценой при повторной активации, чтобы не ждать опроса).
#[tauri::command]
pub fn net_snapshot(state: State<'_, AppState>) -> Result<NetSnapshotPayload> {
    Ok(state.net.latest.lock().unwrap().clone())
}
