//! Разделяемое состояние приложения (по одному экземпляру на процесс, `app.manage`).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use vortex_core::disk::DiskNode;
use vortex_core::netdiff::ConnDiffState;

use crate::events::{AudioInfoPayload, DiskStatsPayload, FeatureFlags, NetSnapshotPayload, SysInfoPayload};
use crate::providers::audio::CaptureHandle;
use crate::providers::network::ProcCache;

#[derive(Default)]
pub struct AudioState {
    pub info: Mutex<AudioInfoPayload>,
    pub handle: Mutex<Option<CaptureHandle>>,
    pub started_at: Mutex<Option<Instant>>,
}

pub struct NetState {
    pub diff: Mutex<ConnDiffState>,
    pub latest: Mutex<NetSnapshotPayload>,
    pub running: AtomicBool,
    pub poll_ms: AtomicU64,
    pub polls: AtomicU64,
}

impl Default for NetState {
    fn default() -> Self {
        Self {
            diff: Mutex::new(ConnDiffState::new()),
            latest: Mutex::new(NetSnapshotPayload::default()),
            running: AtomicBool::new(false),
            poll_ms: AtomicU64::new(2000),
            polls: AtomicU64::new(0),
        }
    }
}

#[derive(Default)]
pub struct DiskState {
    /// Флаг отмены текущего скана (пересоздаётся на каждый скан).
    pub cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// Плоское дерево последнего завершённого скана (`Arc`, чтобы команды брали снимок без блокировки на всё время обработки).
    pub tree: Mutex<Option<Arc<Vec<DiskNode>>>>,
    pub stats: Mutex<DiskStatsPayload>,
    /// Корни, которые пользователь сканировал: только внутри них разрешено удаление в корзину.
    pub roots: Mutex<Vec<PathBuf>>,
    pub scanning: AtomicBool,
    pub generation: AtomicU64,
}

pub struct AppState {
    pub audio: AudioState,
    pub net: NetState,
    pub disk: DiskState,
    pub sys: SysInfoPayload,
    pub procs: Mutex<ProcCache>,
}

impl AppState {
    pub fn new() -> Self {
        let elevated = crate::providers::winapi::is_elevated();
        let sys = SysInfoPayload {
            os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
            elevated,
            cores: std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4),
            total_ram: crate::providers::winapi::total_ram_bytes(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            features: FeatureFlags {
                // ETW и MFT требуют повышения прав — включаются на этапах 3 и 4.
                etw: false,
                mft: elevated && cfg!(windows),
                geodb: false,
                loopback: cfg!(windows),
            },
        };
        Self {
            audio: AudioState::default(),
            net: NetState::default(),
            disk: DiskState::default(),
            sys,
            procs: Mutex::new(ProcCache::new()),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
