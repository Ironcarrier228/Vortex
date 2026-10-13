//! Преобразование интерлив-PCM любого миксового формата в моно f32.
//!
//! WASAPI loopback отдаёт звук в миксовом формате устройства (float32, 16/24/32 бита,
//! 2…8 каналов). Чтобы не зависеть от этого, конвертируем сами: усредняем каналы в моно.
//! Модуль намеренно не зависит от `wasapi` — покрыт юнит-тестами на любой ОС.

/// Формат хранения сэмпла.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SampleKind {
    /// IEEE float32 — самый частый случай для WASAPI shared mode.
    F32,
    /// Знаковый PCM 16 бит.
    I16,
    /// PCM 24 бита, упакованный в 32-битный контейнер (wBitsPerSample = 32, valid = 24).
    I24In32,
    /// Знаковый PCM 32 бита.
    I32,
}

impl SampleKind {
    pub fn bytes_per_sample(self) -> usize {
        match self {
            SampleKind::I16 => 2,
            SampleKind::F32 | SampleKind::I24In32 | SampleKind::I32 => 4,
        }
    }
}

/// Микшер в моно. Буфер переиспользуется между вызовами (никаких аллокаций в аудиопотоке).
pub struct MonoMixer {
    channels: usize,
    kind: SampleKind,
    bytes_per_sample: usize,
}

impl MonoMixer {
    pub fn new(channels: usize, kind: SampleKind) -> Self {
        Self {
            channels: channels.max(1),
            kind,
            bytes_per_sample: kind.bytes_per_sample(),
        }
    }

    /// Сконвертировать интерлив-буфер в моно f32 и дописать в `out`.
    pub fn to_mono_into(&self, bytes: &[u8], out: &mut Vec<f32>) {
        let bps = self.bytes_per_sample;
        let frames = bytes.len() / (bps * self.channels);
        out.reserve(frames);
        let inv_channels = 1.0 / self.channels as f32;

        for frame in 0..frames {
            let mut sum = 0.0f32;
            let base = frame * self.channels * bps;
            for channel in 0..self.channels {
                sum += read_sample(bytes, base + channel * bps, self.kind);
            }
            out.push(sum * inv_channels);
        }
    }
}

/// Чтение одного сэмпла; выход за границы буфера даёт 0.
fn read_sample(bytes: &[u8], offset: usize, kind: SampleKind) -> f32 {
    match kind {
        SampleKind::F32 => {
            if offset + 4 > bytes.len() {
                return 0.0;
            }
            let value = f32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ]);
            if value.is_finite() {
                value.clamp(-1.0, 1.0)
            } else {
                0.0
            }
        }
        SampleKind::I16 => {
            if offset + 2 > bytes.len() {
                return 0.0;
            }
            let raw = i16::from_le_bytes([bytes[offset], bytes[offset + 1]]);
            raw as f32 / 32_768.0
        }
        SampleKind::I24In32 | SampleKind::I32 => {
            if offset + 4 > bytes.len() {
                return 0.0;
            }
            let raw = i32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ]);
            if kind == SampleKind::I24In32 {
                // 24 значимых бита в старших разрядах 32-битного контейнера.
                (raw >> 8) as f32 / 8_388_608.0
            } else {
                raw as f32 / 2_147_483_648.0
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f32_bytes(values: &[f32]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    #[test]
    fn stereo_f32_is_averaged() {
        let mixer = MonoMixer::new(2, SampleKind::F32);
        let data = f32_bytes(&[1.0, 0.0, 0.5, 0.5, -1.0, 1.0]);
        let mut out = Vec::new();
        mixer.to_mono_into(&data, &mut out);
        assert_eq!(out, vec![0.5, 0.5, 0.0]);
    }

    #[test]
    fn mono_f32_passthrough() {
        let mixer = MonoMixer::new(1, SampleKind::F32);
        let data = f32_bytes(&[0.25, -0.25]);
        let mut out = Vec::new();
        mixer.to_mono_into(&data, &mut out);
        assert_eq!(out, vec![0.25, -0.25]);
    }

    #[test]
    fn int16_scaling() {
        let mixer = MonoMixer::new(1, SampleKind::I16);
        let data: Vec<u8> = [i16::MAX, i16::MIN, 0]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let mut out = Vec::new();
        mixer.to_mono_into(&data, &mut out);
        assert!((out[0] - 0.9999).abs() < 0.001);
        assert!((out[1] + 1.0).abs() < 0.001);
        assert_eq!(out[2], 0.0);
    }

    #[test]
    fn int24_in_32_uses_upper_bits() {
        let mixer = MonoMixer::new(1, SampleKind::I24In32);
        let half_scale: i32 = 0x40_00_00 << 8;
        let data = half_scale.to_le_bytes();
        let mut out = Vec::new();
        mixer.to_mono_into(&data, &mut out);
        assert!((out[0] - 0.5).abs() < 0.001, "получили {}", out[0]);
    }

    #[test]
    fn multichannel_and_partial_frames_are_safe() {
        let mixer = MonoMixer::new(4, SampleKind::F32);
        let data = f32_bytes(&[1.0, 1.0, 1.0, 1.0, 0.0]);
        let mut out = Vec::new();
        mixer.to_mono_into(&data, &mut out);
        assert_eq!(out, vec![1.0]); // неполный кадр отбрасывается, паники нет
    }
}
