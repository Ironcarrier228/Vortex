//! Системная информация для HUD: ОС, права, ядра, память, доступные расширенные функции.

use tauri::State;

use crate::error::Result;
use crate::events::SysInfoPayload;
use crate::state::AppState;

#[tauri::command]
pub fn sys_info(state: State<'_, AppState>) -> Result<SysInfoPayload> {
    Ok(state.sys.clone())
}
