//! Провайдеры данных: аудио (WASAPI loopback), сеть (IP Helper), диск (jwalk).
//!
//! Каждый провайдер ничего не знает о Tauri: он отдаёт данные/события через колбэки,
//! а команды (`src/commands/*`) упаковывают их в события. Так провайдеры тестируются
//! отдельно и легко заменяются (например, ETW-провайдером трафика вместо IP Helper).

pub mod audio;
pub mod disk;
pub mod network;

/// Обёртки над Win32 через прямой FFI (`extern "system"`), без крейта `windows`:
/// нужен минимум функций, зато нет риска рассинхрона фич/версий.
#[cfg(windows)]
pub mod recycle;
#[cfg(windows)]
pub mod winapi;

/// Заглушки для не-Windows: приложение целится в Windows, но проект должен
/// собираться (и проходить cargo check) на любой ОС — удобно для CI и разработки.
#[cfg(not(windows))]
pub mod winapi {
    pub fn is_elevated() -> bool {
        false
    }
    pub fn process_path(_pid: u32) -> Option<String> {
        None
    }
    pub fn total_ram_bytes() -> u64 {
        0
    }
}

#[cfg(not(windows))]
pub mod recycle {
    use std::path::Path;
    pub fn move_to_recycle_bin(_path: &Path) -> Result<(), String> {
        Err("Удаление в корзину доступно только на Windows".to_string())
    }
}
