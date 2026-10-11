//! FFT-анализ аудиопотока: из PCM получаем уровень, пик и набор лог-полос в дБ.
//!
//! Схема обработки:
//! ```text
//! PCM f32 mono ──► кольцевой буфер ──► окно Ханна (50% перекрытие)
//!                                   ──► rustfft (2048)
//!                                   ──► 64 геометрические полосы 30 Гц … 16 кГц
//!                                   ──► dB + сглаживание (атака/спад)
//!                                   ──► AudioFeatures { rms, peak, bands[] }
//! ```
//!
//! Почему 50 % перекрытие и сглаживание: визуализатору нужен «плавный, но отзывчивый»
//! спектр. Сырые кадры FFT на 23 Гц дают рваную картинку, поэтому атака быстрая,
//! а спад медленный — как в VU-метрах.

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::sync::Arc;

/// Размер FFT по умолчанию (при 48 кГц это ~23 мс анализа при 50 % перекрытии).
pub const DEFAULT_FFT_SIZE: usize = 2048;
/// Количество полос, которое ждёт фронтенд.
pub const DEFAULT_BANDS: usize = 64;

const SILENCE_DBFS: f32 = -120.0;
const BAND_LOW_HZ: f32 = 30.0;
const BAND_HIGH_HZ: f32 = 16_000.0;
/// Скорость сглаживания при росте полосы (атака).
const ATTACK: f32 = 0.45;
/// Скорость сглаживания при спаде (release).
const RELEASE: f32 = 0.12;

/// Готовые к отправке во фронтенд характеристики кадра.
#[derive(Clone, Debug, Default)]
pub struct AudioFeatures {
    /// СКЗ блока, дБFS (обычно -90…0).
    pub rms_dbfs: f32,
    /// Пик блока, дБFS.
    pub peak_dbfs: f32,
    /// Спектр по полосам, дБ (длина = `band_count`).
    pub bands_dbfs: Vec<f32>,
}

/// Скользящий оконный FFT-анализатор. Один экземпляр = один канал (моно).
pub struct Analyser {
    fft_size: usize,
    hop: usize,
    band_count: usize,
    window: Vec<f32>,
    window_sum: f32,
    fft: Arc<dyn Fft<f32>>,
    spectrum: Vec<Complex<f32>>,
    ring: Vec<f32>,
    ring_pos: usize,
    since_fft: usize,
    since_emit: usize,
    band_bins: Vec<(usize, usize)>,
    band_edges: Vec<f32>,
    sample_rate: u32,
    smoothed: Vec<f32>,
    sum_sq: f64,
    sample_count: u64,
    peak_abs: f32,
    has_pending: bool,
    last: AudioFeatures,
}

impl Analyser {
    /// `fft_size` округляется вверх до степени двойки, `band_count` зажимается в 8..=256.
    pub fn new(fft_size: usize, band_count: usize) -> Self {
        let fft_size = fft_size.max(256).next_power_of_two();
        let band_count = band_count.clamp(8, 256);

        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(fft_size);

        let window: Vec<f32> = (0..fft_size)
            .map(|i| {
                let x = i as f32 / (fft_size - 1) as f32;
                0.5 - 0.5 * (std::f32::consts::TAU * x).cos()
            })
            .collect();
        let window_sum: f32 = window.iter().sum::<f32>().max(1.0);

        Self {
            fft_size,
            hop: fft_size / 2,
            band_count,
            window,
            window_sum,
            fft,
            spectrum: vec![Complex::default(); fft_size],
            ring: vec![0.0; fft_size],
            ring_pos: 0,
            since_fft: 0,
            since_emit: 0,
            band_bins: Vec::new(),
            band_edges: Vec::new(),
            sample_rate: 0,
            smoothed: vec![SILENCE_DBFS; band_count],
            sum_sq: 0.0,
            sample_count: 0,
            peak_abs: 0.0,
            has_pending: false,
            last: AudioFeatures {
                rms_dbfs: SILENCE_DBFS,
                peak_dbfs: SILENCE_DBFS,
                bands_dbfs: vec![SILENCE_DBFS; band_count],
            },
        }
    }

    pub fn fft_size(&self) -> usize {
        self.fft_size
    }

    pub fn band_count(&self) -> usize {
        self.band_count
    }

    /// Частотные границы полос (длина = `band_count + 1`). Доступно после первого push.
    pub fn band_edges(&self) -> &[f32] {
        &self.band_edges
    }

    /// Пересчитывает границы полос, если сменилась частота дискретизации.
    fn update_bands(&mut self, sample_rate: u32) {
        let sample_rate = sample_rate.max(8_000);
        if self.sample_rate == sample_rate && !self.band_bins.is_empty() {
            return;
        }
        self.sample_rate = sample_rate;

        let nyquist = sample_rate as f32 * 0.5;
        let high = BAND_HIGH_HZ.min(nyquist * 0.98).max(BAND_LOW_HZ * 2.0);
        let ratio = (high / BAND_LOW_HZ).powf(1.0 / self.band_count as f32);

        self.band_edges = (0..=self.band_count)
            .map(|k| BAND_LOW_HZ * ratio.powi(k as i32))
            .collect();

        let bin_hz = sample_rate as f32 / self.fft_size as f32;
        let last_bin = self.fft_size / 2;
        self.band_bins = self
            .band_edges
            .windows(2)
            .map(|e| {
                let lo = ((e[0] / bin_hz).floor() as usize).clamp(1, last_bin - 1);
                let hi = ((e[1] / bin_hz).ceil() as usize).clamp(lo + 1, last_bin);
                (lo, hi)
            })
            .collect();
    }

    /// Протолкнуть моно-сэмплы. Возвращает фичи не чаще, чем раз в `emit_every_frames`
    /// семплов (типично: `sample_rate / 60`, чтобы получить ровно 60 кадров в секунду).
    pub fn push_mono(
        &mut self,
        frames: &[f32],
        sample_rate: u32,
        emit_every_frames: usize,
    ) -> Option<AudioFeatures> {
        if frames.is_empty() {
            return None;
        }
        self.update_bands(sample_rate);

        for &s in frames {
            let s = if s.is_finite() { s } else { 0.0 };
            self.ring[self.ring_pos] = s;
            self.ring_pos = (self.ring_pos + 1) % self.fft_size;
            self.sum_sq += (s as f64) * (s as f64);
            let a = s.abs();
            if a > self.peak_abs {
                self.peak_abs = a;
            }
        }
        self.sample_count += frames.len() as u64;
        self.since_fft += frames.len();
        self.since_emit += frames.len();

        if self.since_fft >= self.hop {
            self.since_fft = 0;
            self.compute_spectrum();
            self.has_pending = true;
        }

        if self.has_pending && self.since_emit >= emit_every_frames.max(1) {
            self.since_emit = 0;
            self.has_pending = false;
            self.finish_stats();
            return Some(self.last.clone());
        }
        None
    }

    fn compute_spectrum(&mut self) {
        // Собираем окно из кольцевого буфера в хронологическом порядке (от старых к новым).
        for i in 0..self.fft_size {
            let idx = (self.ring_pos + i) % self.fft_size;
            self.spectrum[i] = Complex::new(self.ring[idx] * self.window[i], 0.0);
        }
        self.fft.process(&mut self.spectrum);

        // Нормировка так, чтобы синусоида с амплитудой 1.0 давала ≈0 дБ.
        let norm = 2.0 / self.window_sum;

        for k in 0..self.band_count {
            let (lo, hi) = self.band_bins[k];
            let mut power = 0.0f32;
            let mut n = 0u32;
            for bin in lo..hi {
                let c = self.spectrum[bin];
                power += c.re * c.re + c.im * c.im;
                n += 1;
            }
            let mean = if n > 0 { power / n as f32 } else { 0.0 };
            let amplitude = mean.sqrt() * norm;
            let db = 20.0 * amplitude.max(1e-7).log10();
            self.last.bands_dbfs[k] = db.clamp(SILENCE_DBFS, 6.0);
        }

        // Асимметричное сглаживание: быстрый подъём, плавный спад.
        for k in 0..self.band_count {
            let target = self.last.bands_dbfs[k];
            let prev = self.smoothed[k];
            let coeff = if target > prev { ATTACK } else { RELEASE };
            let next = prev * (1.0 - coeff) + target * coeff;
            self.smoothed[k] = next;
            self.last.bands_dbfs[k] = next;
        }
    }

    fn finish_stats(&mut self) {
        if self.sample_count > 0 {
            let rms = (self.sum_sq / self.sample_count as f64).sqrt() as f32;
            self.last.rms_dbfs = (20.0 * rms.max(1e-7).log10()).clamp(SILENCE_DBFS, 6.0);
        } else {
            self.last.rms_dbfs = SILENCE_DBFS;
        }
        self.last.peak_dbfs = (20.0 * self.peak_abs.max(1e-7).log10()).clamp(SILENCE_DBFS, 6.0);
        self.sum_sq = 0.0;
        self.sample_count = 0;
        self.peak_abs = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, freq: f32, amplitude: f32, len: usize) -> Vec<f32> {
        (0..len)
            .map(|i| {
                amplitude * (std::f32::consts::TAU * freq * i as f32 / rate as f32).sin()
            })
            .collect()
    }

    #[test]
    fn silence_is_quiet() {
        let mut a = Analyser::new(DEFAULT_FFT_SIZE, DEFAULT_BANDS);
        let zeros = vec![0.0f32; 48_000];
        let f = a.push_mono(&zeros, 48_000, 1024).expect("должен быть кадр");
        assert!(f.rms_dbfs < -100.0, "rms={}", f.rms_dbfs);
        assert!(f.bands_dbfs.iter().all(|&db| db < -100.0));
    }

    #[test]
    fn sine_lands_in_expected_band() {
        let rate = 48_000;
        let mut a = Analyser::new(DEFAULT_FFT_SIZE, DEFAULT_BANDS);
        let tone = sine(rate, 1000.0, 1.0, rate as usize); // 1 секунда
        let mut last = None;
        for chunk in tone.chunks(480) {
            if let Some(f) = a.push_mono(chunk, rate, 480 * 60) {
                last = Some(f);
            }
        }
        let f = last.expect("кадры должны приходить");

        let edges = a.band_edges();
        let (best, _) = f
            .bands_dbfs
            .iter()
            .enumerate()
            .max_by(|x, y| x.1.partial_cmp(y.1).unwrap())
            .unwrap();

        assert!(
            edges[best] <= 1000.0 && 1000.0 <= edges[best + 1],
            "доминирующая полоса {} = {}…{} Гц не содержит 1000 Гц",
            best,
            edges[best],
            edges[best + 1]
        );
        assert!(
            f.bands_dbfs[best] > -12.0,
            "полная синусоида должна давать около 0 дБ, получили {}",
            f.bands_dbfs[best]
        );
        // Соседние полосы заметно тише.
        let far = f.bands_dbfs[0].max(f.bands_dbfs[DEFAULT_BANDS - 1]);
        assert!(far < -30.0, "дальняя полоса слишком громкая: {far}");
    }

    #[test]
    fn emit_rate_is_limited() {
        let rate = 48_000;
        let mut a = Analyser::new(DEFAULT_FFT_SIZE, DEFAULT_BANDS);
        let tone = sine(rate, 440.0, 0.5, rate as usize);
        let emit_every = rate as usize / 60; // ≈60 кадров/с
        let mut count = 0;
        for chunk in tone.chunks(480) {
            if a.push_mono(chunk, rate, emit_every).is_some() {
                count += 1;
            }
        }
        assert!(
            (45..=70).contains(&count),
            "ожидали ~60 кадров в секунду, получили {count}"
        );
    }

    #[test]
    fn release_is_slower_than_attack() {
        let rate = 48_000;
        let mut a = Analyser::new(DEFAULT_FFT_SIZE, 16);
        let tone = sine(rate, 2000.0, 1.0, 24_000);
        // Разгоняем анализатор.
        for chunk in tone.chunks(480) {
            a.push_mono(chunk, rate, 480);
        }
        let loud = a
            .push_mono(&tone[..480], rate, 480)
            .expect("кадр на громком сигнале");
        // Внезапная тишина: уровень должен падать, но не мгновенно.
        let quiet = a
            .push_mono(&vec![0.0; 480], rate, 480)
            .expect("кадр на тишине");
        let peak_of = |f: &AudioFeatures| -> f32 {
            f.bands_dbfs.iter().cloned().fold(f32::NEG_INFINITY, f32::max)
        };
        assert!(peak_of(&loud) > -20.0, "громкий кадр: {}", peak_of(&loud));
        assert!(
            peak_of(&quiet) > -80.0,
            "спад должен быть плавным, а не мгновенным: {}",
            peak_of(&quiet)
        );
    }

    #[test]
    fn db_to_unit_is_clamped_and_monotonic() {
        assert_eq!(crate::db_to_unit(-500.0), 0.0);
        assert_eq!(crate::db_to_unit(0.0), 1.0);
        assert!(crate::db_to_unit(-30.0) < crate::db_to_unit(-10.0));
    }
}
