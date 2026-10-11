//! Команды анализатора диска.
//!
//! Безопасность удаления (три независимых барьера):
//! 1. путь абсолютный и существует;
//! 2. путь лежит **внутри** одного из ранее просканированных корней и не равен ему;
//! 3. удаление выполняет оболочка Windows с флагом `FOF_ALLOWUNDO` → только в корзину.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::error::Result;
use crate::events::{DiskNodePayload, DiskStatsPayload, EV_DISK_STATS};
use crate::providers::disk::ScanOptions;
use crate::state::AppState;

/// Корень сканирования по умолчанию — системный диск.
fn default_root() -> PathBuf {
    #[cfg(windows)]
    {
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        PathBuf::from(format!("{drive}\\"))
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("/")
    }
}

/// Привести пришедшую из UI строку к каноническому виду для поиска в дереве.
fn query_path(text: &str) -> PathBuf {
    let trimmed = text.trim().trim_end_matches(['\\', '/']);
    // "C:" без слэша — это корень диска, добавить разделитель обязательно.
    let is_drive_root = trimmed.len() == 2
        && trimmed.as_bytes()[1] == b':'
        && trimmed.as_bytes()[0].is_ascii_alphabetic();
    if is_drive_root {
        PathBuf::from(format!("{trimmed}\\"))
    } else {
        PathBuf::from(trimmed)
    }
}

pub fn find_node(tree: &[vortex_core::disk::DiskNode], query: &Path) -> Option<usize> {
    tree.iter().position(|node| node.path.as_path() == query)
}

#[tauri::command]
pub fn disk_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    root: Option<String>,
    threads: Option<usize>,
) -> Result<DiskStatsPayload> {
    let root_path = match root {
        Some(value) if !value.trim().is_empty() => query_path(&value),
        _ => default_root(),
    };
    if !root_path.is_dir() {
        return Err(format!("Каталог не найден: {}", root_path.display()));
    }

    // Останавливаем предыдущий скан (если он ещё идёт) — пара «клик по другому диску»
    // не должна оставлять два конкурирующих обхода.
    {
        let previous = state.disk.cancel.lock().unwrap().take();
        if let Some(flag) = previous {
            flag.store(true, Ordering::Relaxed);
        }
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *state.disk.cancel.lock().unwrap() = Some(cancel.clone());
    state.disk.generation.fetch_add(1, Ordering::SeqCst);

    let elevated = state.sys.elevated;
    let app_thread = app.clone();
    let scan_root = root_path.clone();
    let threads_value = threads.unwrap_or(0);

    std::thread::Builder::new()
        .name("vortex-disk".to_string())
        .spawn(move || {
            let state = app_thread.state::<AppState>();
            state.disk.scanning.store(true, Ordering::SeqCst);

            // Мгновенный отклик UI: сразу сообщаем «скан начался».
            let started = {
                let mut stats = state.disk.stats.lock().unwrap();
                *stats = DiskStatsPayload {
                    root: scan_root.to_string_lossy().to_string(),
                    scanning: true,
                    elevated,
                    mft_available: elevated && cfg!(windows),
                    ..Default::default()
                };
                stats.clone()
            };
            crate::events::emit(&app_thread, EV_DISK_STATS, started);

            let options = ScanOptions {
                threads: threads_value,
                ..ScanOptions::new(scan_root.clone())
            };

            let emit_stats = |payload: DiskStatsPayload| {
                let mut payload = payload;
                payload.elevated = elevated;
                payload.mft_available = elevated && cfg!(windows);
                *state.disk.stats.lock().unwrap() = payload.clone();
                crate::events::emit(&app_thread, EV_DISK_STATS, payload);
            };

            let outcome = crate::providers::disk::scan(&options, &cancel, &emit_stats);

            *state.disk.tree.lock().unwrap() = Some(Arc::new(outcome.tree));
            {
                let mut roots = state.disk.roots.lock().unwrap();
                if !roots.contains(&scan_root) {
                    roots.push(scan_root.clone());
                }
            }
            state.disk.scanning.store(false, Ordering::SeqCst);
        })
        .map_err(|e| format!("Не удалось запустить поток сканирования: {e}"))?;

    Ok(state.disk.stats.lock().unwrap().clone())
}

#[tauri::command]
pub fn disk_cancel(state: State<'_, AppState>) -> Result<()> {
    let flag = state.disk.cancel.lock().unwrap().take();
    if let Some(flag) = flag {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Дочерние элементы каталога — основа для «города» на фронтенде.
#[tauri::command]
pub fn disk_children(state: State<'_, AppState>, path: String) -> Result<Vec<DiskNodePayload>> {
    let tree = state
        .disk
        .tree
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Дерево ещё не построено: запустите сканирование".to_string())?;

    let query = query_path(&path);
    let parent_id = find_node(&tree, &query)
        .ok_or_else(|| format!("Узел не найден в текущем дереве: {}", query.display()))?;

    let mut children: Vec<DiskNodePayload> = tree
        .iter()
        .filter(|node| node.parent == parent_id && node.id != parent_id)
        .map(DiskNodePayload::from)
        .collect();

    children.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.name.cmp(&b.name)));
    // Защита от «папки с миллионом файлов»: сцена и так не покажет больше.
    children.truncate(4000);
    Ok(children)
}

#[tauri::command]
pub fn disk_stats(state: State<'_, AppState>) -> Result<DiskStatsPayload> {
    Ok(state.disk.stats.lock().unwrap().clone())
}

/// Удаление в корзину с обязательным подтверждением на стороне UI.
#[tauri::command]
pub fn disk_delete_to_trash(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<()> {
    let target = query_path(&path);
    if !target.exists() {
        return Err(format!("Объект уже не существует: {}", target.display()));
    }

    let roots = state.disk.roots.lock().unwrap().clone();
    let inside = roots
        .iter()
        .any(|root| target != *root && target.starts_with(root));
    if !inside {
        return Err(
            "Удалять можно только объекты внутри просканированного каталога".to_string(),
        );
    }

    crate::providers::recycle::move_to_recycle_bin(&target)?;
    crate::events::toast(
        &app,
        "info",
        format!("Перемещено в корзину: {}", target.display()),
    );

    // Размеры в дереве устарели: пересобираем его в фоне, чтобы визуализация снова была честной.
    if let Some(root) = roots.into_iter().find(|root| target.starts_with(root)) {
        let _ = disk_scan(
            app,
            state,
            Some(root.to_string_lossy().to_string()),
            None,
        );
    }
    Ok(())
}
