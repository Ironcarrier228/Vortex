//! Ошибки бэкенда. Tauri умеет сериализовать `Result<T, String>` в reject промиса,
//! поэтому наружу отдаём человекочитаемые строки, а не внутренние типы.

/// Универсальный результат команды: `Err(строка)` попадёт в `catch` на фронтенде.
pub type Result<T> = std::result::Result<T, String>;

/// Превратить любое `Display`-исключение в сообщение для UI.
pub fn msg<E: std::fmt::Display>(context: &str, err: E) -> String {
    format!("{context}: {err}")
}
