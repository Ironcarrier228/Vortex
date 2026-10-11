//! Дисковый провайдер: быстрый параллельный обход через `jwalk`.
//!
//! Работает **без прав администратора**: недоступные каталоги (System Volume Information,
//! чужие профили) просто пропускаются, потому что ошибки чтения отбрасываются на этапе
//! `process_read_dir`. Инкрементальные события статистики позволяют сцене «растить» город
//! прямо во время скана.
//!
//! Этап 4 добавит сюда чтение MFT (`FSCTL_ENUM_USN_DATA`) для мгновенного скана с админом:
//! интерфейс уже подготовлен — `ScanSource` с двумя реализациями, обе отдают `DiskNode`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use jwalk::{Parallelism, WalkDir};

use crate::events::DiskStatsPayload;
use vortex_core::disk::{DiskNode, TreeBuilder};

/// Параметры скана.
#[derive(Clone, Debug)]
pub struct ScanOptions {
    pub root: PathBuf,
    /// Потоки jwalk (0 → по числу ядер, но не больше 8 — чтобы система оставалась отзывчивой).
    pub threads: usize,
    /// Предохранитель по числу узлов: защищает от «миллиона файлов» в памяти.
    pub max_nodes: usize,
    /// Как часто отправлять промежуточную статистику.
    pub emit_every_ms: u64,
}

impl ScanOptions {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            threads: 0,
            max_nodes: 2_000_000,
            emit_every_ms: 250,
        }
    }
}

/// Результат скана.
pub struct ScanOutcome {
    pub tree: Vec<DiskNode>,
    pub stats: DiskStatsPayload,
}

/// Обход дерева каталогов. Колбэк `on_stats` вызывается из потока скана,
/// поэтому он обязан быть дешёвым (там только сериализация и отправка события).
pub fn scan(
    options: &ScanOptions,
    cancel: &AtomicBool,
    on_stats: &(dyn Fn(DiskStatsPayload) + Send + Sync),
) -> ScanOutcome {
    let started = Instant::now();
    let mut builder = TreeBuilder::new(&options.root);

    let mut files: u64 = 0;
    let mut dirs: u64 = 0;
    let mut bytes: u64 = 0;
    let mut last_emit = Instant::now();
    let mut truncated = false;

    let threads = if options.threads == 0 {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(8)
    } else {
        options.threads.clamp(1, 32)
    };

    let snapshot = |files: u64, dirs: u64, bytes: u64, done: bool, cancelled: bool| DiskStatsPayload {
        root: options.root.to_string_lossy().to_string(),
        files,
        dirs,
        bytes,
        elapsed_ms: started.elapsed().as_millis() as u64,
        done,
        scanning: !done,
        cancelled,
        mft_available: false, // заполняется вызывающим кодом (зависит от прав)
        ..Default::default()
    };

    let walker = WalkDir::new(&options.root)
        .skip_hidden(false)
        .follow_links(false)
        .sort(false)
        .parallelism(Parallelism::RayonNewPool(threads))
        .process_read_dir(|_depth, _path, _state, children| {
            // Ошибки доступа = недоступный каталог: молча исключаем его из обхода.
            children.retain(|entry| entry.is_ok());
        });

    for entry in walker {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if entry.depth() == 0 {
            continue; // корень уже создан в TreeBuilder
        }

        let path = entry.path();
        let is_dir = entry.file_type().is_dir();
        let metadata = entry.metadata().ok();
        let size = if is_dir {
            0
        } else {
            metadata.as_ref().map(|m| m.len()).unwrap_or(0)
        };
        let modified = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);

        if builder.insert(&path, is_dir, size, modified).is_some() {
            if is_dir {
                dirs += 1;
            } else {
                files += 1;
                bytes += size;
            }
        }

        if builder.len() >= options.max_nodes {
            truncated = true;
            break;
        }

        if last_emit.elapsed() >= Duration::from_millis(options.emit_every_ms) {
            last_emit = Instant::now();
            on_stats(snapshot(files, dirs, bytes, false, false));
        }
    }

    let cancelled = cancel.load(Ordering::Relaxed);
    let tree = builder.finalize();

    let mut stats = snapshot(files, dirs, bytes, true, cancelled);
    if truncated {
        stats.error = Some(format!(
            "Достигнут лимит в {} объектов — показана часть дерева",
            options.max_nodes
        ));
    }

    // Корневой узел уже содержит итоговые суммы (после finalize).
    if let Some(root) = tree.first() {
        stats.bytes = root.size;
        stats.files = root.files as u64;
    }

    on_stats(stats.clone());
    ScanOutcome { tree, stats }
}
