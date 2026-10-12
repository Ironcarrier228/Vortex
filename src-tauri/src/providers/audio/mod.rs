//! Провайдер системного звука.
//!
//! * Windows → WASAPI loopback (захват того, что играет на устройстве вывода);
//! * другие ОС → внятная ошибка (в браузере для отладки графики есть WebAudio-фолбэк).
//!
//! Провайдер не знает про Tauri: события отдаются колбэком `sink`, а команды
//! (`commands/audio.rs`) превращают их в события приложения.

pub mod sample_source;

#[cfg(windows)]
mod wasapi;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::events::AudioFramePayload;

/// Настройки захвата.
#[derive(Clone, Debug)]
pub struct CaptureConfig {
    /// Размер FFT (степень двойки; 2048 ≈ 23 мс при 50 % перекрытии).
    pub fft_size: usize,
    /// Количество полос спектра для фронтенда.
    pub bands: usize,
    /// Период отправки кадров на фронтенд, мс (16 → ~60 кадров в секунду).
    pub emit_every_ms: u32,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            fft_size: vortex_core::audio::DEFAULT_FFT_SIZE,
            bands: vortex_core::audio::DEFAULT_BANDS,
            emit_every_ms: 16,
        }
    }
}

/// События аудио-потока.
pub enum AudioEvent {
    /// Устройство открыто: сообщаем формат (нужен HUD для диагностики).
    Info {
        device: String,
        sample_rate: u32,
        channels: u16,
    },
    /// Кадр спектра (~60 Гц).
    Frame(AudioFramePayload),
    /// Фатальная ошибка захвата: поток завершается, UI показывает причину.
    Failed(String),
}

/// Управление живым захватом.
pub struct CaptureHandle {
    stop: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
}

impl CaptureHandle {
    /// Пауза визуализации: поток продолжает «осушать» буфер WASAPI,
    /// но не считает FFT и не отправляет кадры (нулевая нагрузка на CPU от анализа).
    pub fn set_active(&self, on: bool) {
        self.active.store(on, Ordering::Relaxed);
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        // Уронили хэндл — поток обязан умереть, иначе получим «висящий» захват.
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Запустить фоновый захват. Колбэк вызывается из аудиопотока (не блокировать!).
pub fn spawn(
    cfg: CaptureConfig,
    sink: impl Fn(AudioEvent) + Send + 'static,
) -> Result<CaptureHandle, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let active = Arc::new(AtomicBool::new(true));

    #[cfg(windows)]
    {
        let stop_thread = stop.clone();
        let active_thread = active.clone();
        std::thread::Builder::new()
            .name("vortex-audio".to_string())
            .stack_size(512 * 1024)
            .spawn(move || {
                if let Err(err) = wasapi::run(&cfg, &sink, &stop_thread, &active_thread) {
                    sink(AudioEvent::Failed(err));
                }
            })
            .map_err(|e| format!("Не удалось создать поток аудиозахвата: {e}"))?;
        return Ok(CaptureHandle { stop, active });
    }

    #[cfg(not(windows))]
    {
        let _ = (cfg, sink);
        Err("Захват системного звука реализован для Windows (WASAPI loopback)".to_string())
    }
}
