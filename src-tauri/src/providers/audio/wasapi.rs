//! Захват системного звука через WASAPI loopback (Windows).
//!
//! Ключевые моменты, проверенные по исходникам `wasapi` 0.26 и документации MSDN:
//! * loopback открывается на **устройстве вывода** (`Direction::Render`) с направлением
//!   захвата (`Direction::Capture`) — библиотека сама добавляет `AUDCLNT_STREAMFLAGS_LOOPBACK`;
//! * в shared-режиме буфер надо читать в миксовом формате устройства → берём `get_mixformat()`
//!   и конвертируем сами (см. `sample_source`);
//! * буфер с флагом `silent` содержит мусор — его обязательно заменяем нулями;
//! * поток обязан постоянно «осушать» буфер, поэтому пауза визуализации не останавливает
//!   чтение, а лишь отключает анализ.

use std::sync::atomic::{AtomicBool, Ordering};

use wasapi::{
    initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat,
};

use vortex_core::audio::Analyser;

use super::sample_source::{MonoMixer, SampleKind};
use super::{AudioEvent, CaptureConfig};
use crate::events::AudioFramePayload;

/// Какой формат сэмплов нам отдаёт устройство.
fn sample_kind(format: &WaveFormat) -> SampleKind {
    let bits = format.get_bitspersample();
    let valid = format.get_validbitspersample();
    match format.get_subformat() {
        Ok(SampleType::Float) => SampleKind::F32,
        Ok(SampleType::Int) => match bits {
            16 => SampleKind::I16,
            24 => SampleKind::I24In32,
            32 if valid == 24 => SampleKind::I24In32,
            32 => SampleKind::I32,
            _ => SampleKind::I16,
        },
        // Неизвестный subformat: чаще всего это уже f32 в WAVE_FORMAT_EXTENSIBLE.
        Err(_) => SampleKind::F32,
    }
}

/// Основной цикл захвата. Возвращает `Ok(())` при штатной остановке или `Err` с причиной.
pub fn run(
    cfg: &CaptureConfig,
    sink: &(dyn Fn(AudioEvent) + Send),
    stop: &AtomicBool,
    active: &AtomicBool,
) -> Result<(), String> {
    initialize_mta()
        .ok()
        .map_err(|e| format!("COM/MTA: {e}"))?;

    let enumerator = DeviceEnumerator::new().map_err(|e| format!("DeviceEnumerator: {e}"))?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| format!("нет устройства вывода по умолчанию: {e}"))?;
    let device_name = device
        .get_friendlyname()
        .unwrap_or_else(|_| "Устройство вывода по умолчанию".to_string());

    let mut client = device
        .get_iaudioclient()
        .map_err(|e| format!("IAudioClient: {e}"))?;

    // Для loopback берём точный микс-формат: он гарантированно поддерживается движком.
    let mix = client
        .get_mixformat()
        .map_err(|e| format!("get_mixformat: {e}"))?;
    let channels = mix.get_nchannels() as usize;
    let rate = mix.get_samplespersec();
    let block_align = mix.get_blockalign() as usize;
    let kind = sample_kind(&mix);

    let (_default_period, min_period) = client
        .get_device_period()
        .map_err(|e| format!("get_device_period: {e}"))?;

    let mode = StreamMode::EventsShared {
        autoconvert: false,
        buffer_duration_hns: min_period.max(200_000), // не меньше 20 мс
    };
    client
        .initialize_client(&mix, &Direction::Render, &mode)
        .map_err(|e| format!("initialize_client (loopback): {e}"))?;

    let event = client
        .set_get_eventhandle()
        .map_err(|e| format!("set_get_eventhandle: {e}"))?;
    let capture = client
        .get_audiocaptureclient()
        .map_err(|e| format!("get_audiocaptureclient: {e}"))?;

    client
        .start_stream()
        .map_err(|e| format!("start_stream: {e}"))?;

    sink(AudioEvent::Info {
        device: device_name,
        sample_rate: rate,
        channels: channels as u16,
    });

    // Кадры на фронтенд: ~60 Гц (16 мс) — ровно под целевой FPS рендера.
    let emit_every = ((rate as f64 * cfg.emit_every_ms as f64 / 1000.0).round() as usize).max(1);

    let mut analyser = Analyser::new(cfg.fft_size, cfg.bands);
    let mixer = MonoMixer::new(channels, kind);
    let mut raw: Vec<u8> = Vec::with_capacity(block_align * 4096);
    let mut mono: Vec<f32> = Vec::with_capacity(16_384);

    // Метка нужна, чтобы ошибка чтения выходила из ОБОИХ циклов: у внутреннего
    // цикла, который просто «осушает» буфер, значение break имеет тип `()`.
    let result = 'capture: loop {
        if stop.load(Ordering::Relaxed) {
            break Ok(());
        }
        // Таймаут — это нормальный путь: он даёт возможность проверить флаг остановки.
        if event.wait_for_event(500).is_err() {
            continue;
        }

        loop {
            match capture.get_next_packet_size() {
                Ok(Some(frames)) if frames > 0 => {
                    let need = frames as usize * block_align;
                    if raw.len() < need {
                        raw.resize(need, 0);
                    }
                    match capture.read_from_device(&mut raw[..need]) {
                        Ok((read_frames, info)) => {
                            if read_frames == 0 {
                                continue;
                            }
                            mono.clear();
                            if info.flags.silent {
                                // Тишина: данные буфера недостоверны, подставляем нули.
                                mono.resize(read_frames as usize, 0.0);
                            } else {
                                mixer.to_mono_into(
                                    &raw[..read_frames as usize * block_align],
                                    &mut mono,
                                );
                            }
                        }
                        Err(err) => break 'capture Err(format!("read_from_device: {err}")),
                    }
                }
                Ok(_) => break,
                Err(err) => break 'capture Err(format!("get_next_packet_size: {err}")),
            }

            // Пауза: продолжаем вычитывать буфер (иначе движок встанет), но не анализируем.
            if !active.load(Ordering::Relaxed) {
                continue;
            }

            if let Some(features) = analyser.push_mono(&mono, rate, emit_every) {
                sink(AudioEvent::Frame(AudioFramePayload {
                    level: features.rms_dbfs,
                    peak: features.peak_dbfs,
                    bands: features.bands_dbfs,
                }));
            }
        }
    };

    let _ = client.stop_stream();
    result
}
