//! Минимальные Win32-вызовы: повышение прав, путь к .exe процесса, объём RAM.
//!
//! Осознанно без крейта `windows`: используются четыре функции, а прямой FFI
//! избавляет от необходимости угадывать набор фич и версию крейта.

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const TOKEN_QUERY: u32 = 0x0008;
const TOKEN_ELEVATION_CLASS: u32 = 20;

#[repr(C)]
struct TokenElevation {
    token_is_elevated: u32,
}

#[repr(C)]
struct MemoryStatusEx {
    length: u32,
    memory_load: u32,
    total_phys: u64,
    avail_phys: u64,
    total_page_file: u64,
    avail_page_file: u64,
    total_virtual: u64,
    avail_virtual: u64,
    avail_extended_virtual: u64,
}

// Явная линковка: kernel32.lib не гарантирован в стандартном наборе линковщика,
// а без `#[link]` символы могут не разрешиться на этапе сборки.
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> *mut core::ffi::c_void;
    fn OpenProcess(
        desired_access: u32,
        inherit_handle: i32,
        process_id: u32,
    ) -> *mut core::ffi::c_void;
    fn CloseHandle(object: *mut core::ffi::c_void) -> i32;
    fn QueryFullProcessImageNameW(
        process: *mut core::ffi::c_void,
        flags: u32,
        exe_name: *mut u16,
        size: *mut u32,
    ) -> i32;
    fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
}

#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(
        process: *mut core::ffi::c_void,
        desired_access: u32,
        token: *mut *mut core::ffi::c_void,
    ) -> i32;
    fn GetTokenInformation(
        token: *mut core::ffi::c_void,
        class: u32,
        info: *mut core::ffi::c_void,
        info_len: u32,
        return_len: *mut u32,
    ) -> i32;
}

/// Запущен ли процесс с правами администратора (UAC elevation).
///
/// Проверяем корректно — через токен процесса, а не через членство в группе
/// «Администраторы» (иначе на админской учётке получим ложное «да» при обычном запуске).
pub fn is_elevated() -> bool {
    unsafe {
        let mut token: *mut core::ffi::c_void = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut info = TokenElevation { token_is_elevated: 0 };
        let mut returned: u32 = 0;
        let ok = GetTokenInformation(
            token,
            TOKEN_ELEVATION_CLASS,
            &mut info as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<TokenElevation>() as u32,
            &mut returned,
        );
        CloseHandle(token);
        ok != 0 && info.token_is_elevated != 0
    }
}

/// Полный путь к исполняемому файлу процесса. `None` — если процесс защищён/недоступен.
pub fn process_path(pid: u32) -> Option<String> {
    if pid == 0 {
        return Some("System Idle Process".to_string());
    }
    if pid == 4 {
        return Some("System".to_string());
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buffer = vec![0u16; 1024];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if ok == 0 || size == 0 {
            return None;
        }
        buffer.truncate(size as usize);
        let os: OsString = OsString::from_wide(&buffer);
        let text = os.to_string_lossy().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }
}

/// Полный объём физической памяти в байтах (0, если вызов не удался).
pub fn total_ram_bytes() -> u64 {
    unsafe {
        let mut status = MemoryStatusEx {
            length: std::mem::size_of::<MemoryStatusEx>() as u32,
            memory_load: 0,
            total_phys: 0,
            avail_phys: 0,
            total_page_file: 0,
            avail_page_file: 0,
            total_virtual: 0,
            avail_virtual: 0,
            avail_extended_virtual: 0,
        };
        if GlobalMemoryStatusEx(&mut status) == 0 {
            0
        } else {
            status.total_phys
        }
    }
}
