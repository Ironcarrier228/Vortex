//! Системная информация для HUD: ОС, права, ядра, память, доступные расширенные функции.

use tauri::State;

use crate::error::Result;
use crate::events::SysInfoPayload;
use crate::state::AppState;

#[tauri::command]
pub fn sys_info(state: State<'_, AppState>) -> Result<SysInfoPayload> {
    Ok(state.sys.clone())
}

/// Выход из приложения. Зовётся из сцены сети: растянутая до предела чёрная дыра
/// поглощает всё, и это последний шаг — закрыть окно. В браузере (dev-режим) команды
/// нет, поэтому фронтенд ловит ошибку и предлагает перезапуск сцены.
#[tauri::command]
pub fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
}
