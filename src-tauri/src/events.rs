//! Пейлоады событий и имена каналов — единственный контракт между Rust и TypeScript.
//!
//! Имена событий: Tauri разрешает только `[A-Za-z0-9/:-_]`, поэтому схема `vortex://...`.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const EV_AUDIO_FRAME: &str = "vortex://audio/frame";
pub const EV_AUDIO_INFO: &str = "vortex://audio/info";
pub const EV_NET_SNAPSHOT: &str = "vortex://net/snapshot";
pub const EV_DISK_STATS: &str = "vortex://disk/stats";
pub const EV_OUTPUT_WINDOW: &str = "vortex://window/output";
pub const EV_TOAST: &str = "vortex://toast";
/// Отправляется один раз при старте бэкенда — HUD получает данные о системе без запроса.
pub const EV_SYS_INFO: &str = "vortex://sys/info";

/* ─────────────────────────────── Аудио ─────────────────────────────── */

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFramePayload {
    /// СКЗ кадра, дБFS.
    pub level: f32,
    /// Пик кадра, дБFS.
    pub peak: f32,
    /// Спектр по 64 полосам, дБ.
    pub bands: Vec<f32>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfoPayload {
    pub available: bool,
    pub device: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    /// Причина недоступности (нет устройства, занято, не Windows).
    pub reason: Option<String>,
}

/* ─────────────────────────────── Сеть ─────────────────────────────── */

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointPayload {
    pub ip: String,
    pub port: u16,
    pub host: Option<String>,
    pub country: Option<String>,
    pub city: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub asn: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetConnectionPayload {
    /// Стабильный идентификатор (совпадает с ключом diff'а) — фронтенд использует его для импульсов.
    pub id: String,
    /// "tcp" | "udp"
    pub protocol: String,
    pub pid: u32,
    pub process: String,
    pub exe_path: Option<String>,
    pub local: EndpointPayload,
    pub remote: EndpointPayload,
    /// TCP-состояние строкой ("ESTABLISHED", "LISTEN", …).
    pub state: String,
    pub bytes_sent: Option<u64>,
    pub bytes_recv: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetSnapshotPayload {
    pub connections: Vec<NetConnectionPayload>,
    /// Процесс запущен с правами администратора.
    pub elevated: bool,
    /// ETW-провайдер трафика активен (нужен админ).
    pub etw_active: bool,
    /// ID соединений, появившихся с прошлого снимка.
    pub added: Vec<String>,
    /// ID соединений, закрывшихся с прошлого снимка.
    pub removed: Vec<String>,
}

/* ─────────────────────────────── Диск ─────────────────────────────── */

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskStatsPayload {
    pub root: String,
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub elapsed_ms: u64,
    pub done: bool,
    pub scanning: bool,
    pub cancelled: bool,
    pub elevated: bool,
    /// Доступен ли мгновенный скан через MFT (нужен админ; включается на этапе 4).
    pub mft_available: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskNodePayload {
    pub id: u64,
    pub parent: u64,
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub files: u32,
    pub ext: String,
    /// Крупная категория для окраски: video/audio/image/code/archive/docs/system/junk/other.
    pub category: String,
    pub modified: Option<u64>,
}

impl From<&vortex_core::disk::DiskNode> for DiskNodePayload {
    fn from(n: &vortex_core::disk::DiskNode) -> Self {
        Self {
            id: n.id as u64,
            parent: n.parent as u64,
            path: n.path.to_string_lossy().to_string(),
            name: n.name.clone(),
            is_dir: n.is_dir,
            size: n.size,
            files: n.files,
            ext: n.ext.clone(),
            category: if n.is_dir {
                "dir".to_string()
            } else {
                vortex_core::disk::categorize(&n.ext).to_string()
            },
            modified: n.modified,
        }
    }
}

/* ─────────────────────────────── Система ─────────────────────────────── */

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureFlags {
    pub etw: bool,
    pub mft: bool,
    pub geodb: bool,
    pub loopback: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysInfoPayload {
    pub os: String,
    pub elevated: bool,
    pub cores: usize,
    pub total_ram: u64,
    pub app_version: String,
    pub features: FeatureFlags,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToastPayload {
    /// "info" | "warn" | "error"
    pub kind: String,
    pub message: String,
}

/* ─────────────────────────────── Хелперы ─────────────────────────────── */

/// Отправить событие во все окна (main + output).
pub fn emit<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Err(err) = app.emit(event, payload) {
        eprintln!("[vortex] не удалось отправить {event}: {err}");
    }
}

/// Показать тост в HUD.
pub fn toast(app: &AppHandle, kind: &str, message: impl Into<String>) {
    emit(
        app,
        EV_TOAST,
        ToastPayload {
            kind: kind.to_string(),
            message: message.into(),
        },
    );
}
