// В релизе прячем консольное окно (иначе на Windows мелькает чёрный прямоугольник).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vortex_lib::run()
}
