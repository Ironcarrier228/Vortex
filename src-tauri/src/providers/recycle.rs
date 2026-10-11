//! Удаление в корзину через `SHFileOperationW` с флагом `FOF_ALLOWUNDO`.
//!
//! Почему так, а не `std::fs::remove_dir_all`: требование проекта — **только корзина**,
//! без безвозвратного удаления. Прямой вызов оболочки также гарантирует, что файл
//! попадёт в «Проводник → Корзина» с возможностью восстановления.
//!
//! Все проверки безопасности сосредоточены здесь и в команде `disk_delete_to_trash`.

use std::path::Path;

const FO_DELETE: u32 = 0x0003;
const FOF_SILENT: u16 = 0x0004;
const FOF_NOCONFIRMATION: u16 = 0x0010;
const FOF_ALLOWUNDO: u16 = 0x0040;
const FOF_NOERRORUI: u16 = 0x0400;

#[repr(C)]
struct ShFileOpStructW {
    hwnd: *mut core::ffi::c_void,
    w_func: u32,
    /// Двойной нуль-терминированный список путей.
    p_from: *const u16,
    p_to: *const u16,
    f_flags: u16,
    f_any_operations_aborted: i32,
    h_name_mappings: *mut core::ffi::c_void,
    lpsz_progress_title: *const u16,
}

#[link(name = "shell32")]
unsafe extern "system" {
    fn SHFileOperationW(file_op: *mut ShFileOpStructW) -> i32;
}

/// Проверки, которые обязаны пройти до любого удаления.
pub fn validate(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Путь должен быть абсолютным".to_string());
    }
    let text = path.to_string_lossy();
    if text.contains('\0') {
        return Err("Путь содержит недопустимый символ".to_string());
    }
    let trimmed = text.trim_end_matches(['\\', '/']);
    // "C:"  → длина 2; "C:\" → после обрезки 2. Запрещаем корни диска и UNC-корни.
    if trimmed.len() <= 2 || trimmed == "\\\\" {
        return Err("Нельзя удалять корень диска".to_string());
    }
    Ok(())
}

/// Переместить файл/каталог в корзину. Возвращает `Err`, если оболочка сообщила об ошибке.
pub fn move_to_recycle_bin(path: &Path) -> Result<(), String> {
    validate(path)?;

    let text = path.to_string_lossy().to_string();
    // SHFileOperation не понимает префикс расширенного пути.
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text).to_string();

    let mut from: Vec<u16> = text.encode_utf16().collect();
    from.push(0);
    from.push(0);

    let mut op = ShFileOpStructW {
        hwnd: std::ptr::null_mut(),
        w_func: FO_DELETE,
        p_from: from.as_ptr(),
        p_to: std::ptr::null(),
        f_flags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
        f_any_operations_aborted: 0,
        h_name_mappings: std::ptr::null_mut(),
        lpsz_progress_title: std::ptr::null(),
    };

    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 {
        return Err(format!(
            "Оболочка Windows не смогла переместить объект в корзину (код {code})"
        ));
    }
    if op.f_any_operations_aborted != 0 {
        return Err("Операция удаления была прервана".to_string());
    }
    Ok(())
}
