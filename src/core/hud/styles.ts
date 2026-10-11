/** Стили HUD. Отделены от глобальных, чтобы сцены могли расширять разметку панелей. */

export const HUD_CSS = /* css */ `
.hud-top {
  position: absolute;
  top: 14px;
  left: 14px;
  right: 14px;
  display: flex;
  align-items: center;
  gap: 14px;
  pointer-events: none;
}

.hud-brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 9px 14px;
  pointer-events: auto;
}

.hud-brand-name {
  font-family: var(--font-mono);
  font-size: 15px;
  letter-spacing: 0.34em;
  color: var(--text);
  text-shadow: 0 0 18px rgba(34, 211, 238, 0.55);
}

.hud-brand-sub {
  font-size: 10.5px;
  color: var(--text-faint);
  letter-spacing: 0.08em;
}

.hud-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 4px;
  pointer-events: auto;
}

.hud-chip {
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--stroke);
  background: rgba(10, 16, 28, 0.55);
  color: var(--text-faint);
  font-size: 10.5px;
  letter-spacing: 0.06em;
}

.hud-chip.on {
  color: var(--cyan);
  border-color: rgba(34, 211, 238, 0.45);
}

.hud-chip.warn {
  color: var(--amber);
  border-color: rgba(251, 191, 36, 0.4);
}

.hud-tabs {
  display: flex;
  gap: 6px;
  padding: 6px;
  pointer-events: auto;
}

.hud-tab {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 7px 14px 7px 12px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  cursor: pointer;
  text-align: left;
  transition: background 0.18s, color 0.18s, border-color 0.18s;
}

.hud-tab:hover { background: rgba(30, 44, 68, 0.5); color: var(--text); }

.hud-tab.active {
  background: linear-gradient(180deg, rgba(34,211,238,0.16), rgba(167,139,250,0.12));
  border-color: rgba(34, 211, 238, 0.4);
  color: var(--text);
  box-shadow: inset 0 0 22px rgba(34, 211, 238, 0.12);
}

.hud-tab-name { font-size: 13px; font-weight: 600; letter-spacing: 0.02em; }
.hud-tab-key { font-family: var(--font-mono); font-size: 10px; color: var(--text-faint); }

.hud-spacer { flex: 1; }

.hud-actions { display: flex; gap: 6px; padding: 6px; pointer-events: auto; }

.hud-side {
  position: absolute;
  top: 84px;
  right: 14px;
  width: 292px;
  max-height: calc(100% - 150px);
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: auto;
}

.hud-panel-inner { padding: 12px 14px; }

.hud-panel-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.hud-panel-title strong { font-size: 12.5px; letter-spacing: 0.04em; color: var(--text); }

.hud-stat-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px 12px;
}

.hud-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.hud-stat-value { font-size: 13px; color: var(--text); }
.hud-stat-value.bad { color: var(--red); }
.hud-stat-value.good { color: var(--green); }

.hud-spark {
  width: 100%;
  height: 40px;
  margin-top: 10px;
  border-radius: 8px;
  background: rgba(8, 14, 26, 0.6);
  border: 1px solid rgba(120, 200, 255, 0.1);
}

.hud-group { display: flex; flex-direction: column; gap: 10px; }
.hud-field { display: flex; flex-direction: column; gap: 5px; }
.hud-field-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hud-field-value { font-family: var(--font-mono); font-size: 11px; color: var(--cyan); }

.hud-divider { height: 1px; background: rgba(120, 200, 255, 0.12); margin: 4px 0; }

.hud-bottom {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 14px;
  pointer-events: auto;
  font-size: 11.5px;
  color: var(--text-dim);
}

.hud-bottom .sep { color: var(--text-faint); opacity: 0.5; }

/* Сценарная панель (низ-слева) */
.hud-scene-panel {
  position: absolute;
  left: 14px;
  bottom: 62px;
  width: 330px;
  max-height: calc(100% - 220px);
  pointer-events: auto;
  display: flex;
  flex-direction: column;
}

.hud-modes { display: flex; flex-wrap: wrap; gap: 6px; }

/* Тултип */
.hud-tooltip {
  position: absolute;
  z-index: 20;
  min-width: 190px;
  max-width: 340px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--panel-strong);
  border: 1px solid var(--stroke-strong);
  box-shadow: var(--shadow);
  backdrop-filter: blur(14px);
  opacity: 0;
  transform: translate(-50%, -120%) scale(0.96);
  transition: opacity 0.14s ease, transform 0.14s ease;
  pointer-events: none;
}

.hud-tooltip.visible { opacity: 1; transform: translate(-50%, -128%) scale(1); }

.hud-tooltip-title {
  font-size: 12.5px;
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 6px;
}

.hud-tooltip-row {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  font-size: 11.5px;
  padding: 2px 0;
}

.hud-tooltip-row .k { color: var(--text-faint); }
.hud-tooltip-row .v { color: var(--text); font-family: var(--font-mono); text-align: right; }

/* Тосты */
.hud-toasts {
  position: absolute;
  right: 14px;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
}

.hud-toast {
  padding: 9px 13px;
  border-radius: 10px;
  background: var(--panel-strong);
  border: 1px solid var(--stroke);
  border-left-width: 3px;
  box-shadow: var(--shadow);
  font-size: 12px;
  max-width: 380px;
  animation: hud-toast-in 0.24s ease;
}

.hud-toast.info { border-left-color: var(--cyan); }
.hud-toast.warn { border-left-color: var(--amber); }
.hud-toast.error { border-left-color: var(--red); }
.hud-toast.fade { opacity: 0; transition: opacity 0.4s ease; }

@keyframes hud-toast-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}

/* Модальное подтверждение */
.hud-modal-backdrop {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  background: rgba(2, 5, 12, 0.55);
  backdrop-filter: blur(6px);
  pointer-events: auto;
}

.hud-modal {
  width: 420px;
  padding: 20px 22px 18px;
  border-radius: 16px;
  animation: hud-toast-in 0.2s ease;
}

.hud-modal h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
.hud-modal p { margin: 0 0 16px; color: var(--text-dim); font-size: 12.5px; line-height: 1.5; word-break: break-word; }
.hud-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.hud-modal .path { font-family: var(--font-mono); color: var(--text); font-size: 11.5px; }

.hud-btn.primary {
  color: #04121a;
  background: linear-gradient(180deg, #7ee7fb, var(--cyan));
  border-color: transparent;
  font-weight: 600;
}

.hud-btn.danger-solid {
  color: #2a0410;
  background: linear-gradient(180deg, #fda4af, var(--red));
  border-color: transparent;
  font-weight: 600;
}

/* Слайдер-строки в настройках */
.hud-settings .hud-field + .hud-field { margin-top: 10px; }
.hud-settings label.hud-field-head { cursor: pointer; }
`;
