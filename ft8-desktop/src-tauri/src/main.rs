// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod decoder;
mod serial;
mod waterfall;

use audio::AudioState;
use decoder::DecoderState;
use serial::{SerialState, GpsSerialState};

fn main() {
    // Panic hook for crash diagnostics
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = format!("PANIC: {}", info);
        if let Ok(exe) = std::env::current_exe() {
            let crash_log = exe.with_file_name("ft8-desktop-crash.log");
            let _ = std::fs::write(&crash_log, &msg);
        }
        default_panic(info);
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SerialState::new())
        .manage(GpsSerialState::new())
        .manage(AudioState::new())
        .manage(DecoderState::new())
        .invoke_handler(tauri::generate_handler![
            // Serial port (CI-V, write-only)
            serial::serial_list_ports,
            serial::serial_open,
            serial::serial_write,
            serial::serial_close,
            // GPS serial port (NMEA, read-only)
            serial::serial_gps_open,
            serial::serial_gps_readline,
            serial::serial_gps_close,
            // Audio capture
            audio::audio_list_devices,
            audio::audio_list_output_devices,
            audio::audio_start,
            audio::audio_stop,
            audio::audio_get_peak,
            audio::audio_buffer_ready,
            audio::audio_get_snapshot,
            audio::audio_set_gain,
            audio::audio_play_start,
            audio::audio_play_stop,
            audio::audio_play_done,
            // Decode
            decoder::decode_wideband,
            decoder::decode_subtract,
            decoder::decode_sniper,
            decoder::encode_ft8,
            // Waterfall
            waterfall::waterfall_compute,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
