use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::sync::Mutex;
use std::time::Duration;

/// Shared serial port state managed by Tauri
pub struct SerialState {
    port: Mutex<Option<Box<dyn serialport::SerialPort>>>,
}

impl SerialState {
    pub fn new() -> Self {
        Self {
            port: Mutex::new(None),
        }
    }
}

/// GPS serial port — separate from CI-V to preserve write-only CAT design.
pub struct GpsSerialState {
    port: Mutex<Option<Box<dyn serialport::SerialPort>>>,
    buf:  Mutex<Vec<u8>>,
}

impl GpsSerialState {
    pub fn new() -> Self {
        Self {
            port: Mutex::new(None),
            buf:  Mutex::new(Vec::new()),
        }
    }
}

/// Serial port info returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInfo {
    pub name: String,
    pub vid: u16,
    pub pid: u16,
}

/// List available serial ports
#[tauri::command]
pub fn serial_list_ports() -> Vec<PortInfo> {
    match serialport::available_ports() {
        Ok(ports) => ports
            .into_iter()
            .map(|p| {
                let (vid, pid) = match &p.port_type {
                    serialport::SerialPortType::UsbPort(usb) => {
                        (usb.vid, usb.pid)
                    }
                    _ => (0, 0),
                };
                PortInfo {
                    name: p.port_name,
                    vid,
                    pid,
                }
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Open a serial port
#[tauri::command]
pub fn serial_open(
    state: tauri::State<'_, SerialState>,
    port_name: String,
    baud_rate: u32,
    stop_bits: Option<u8>,
) -> Result<(), String> {
    let mut guard = state.port.lock().map_err(|e| e.to_string())?;

    // Close existing port if any
    if guard.is_some() {
        *guard = None;
    }

    let sb = match stop_bits.unwrap_or(1) {
        2 => serialport::StopBits::Two,
        _ => serialport::StopBits::One,
    };

    let port = serialport::new(&port_name, baud_rate)
        .stop_bits(sb)
        .parity(serialport::Parity::None)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| format!("Failed to open {}: {}", port_name, e))?;

    log::info!("Serial port opened: {} @ {} baud, stop_bits={:?}", port_name, baud_rate, sb);
    *guard = Some(port);
    Ok(())
}

/// Write bytes to the serial port
#[tauri::command]
pub fn serial_write(
    state: tauri::State<'_, SerialState>,
    data: Vec<u8>,
) -> Result<usize, String> {
    let mut guard = state.port.lock().map_err(|e| e.to_string())?;
    let port = guard.as_mut().ok_or("Serial port not open")?;
    let n = port.write(&data).map_err(|e| format!("Write failed: {}", e))?;
    port.flush().map_err(|e| format!("Flush failed: {}", e))?;
    Ok(n)
}

/// Close the serial port
#[tauri::command]
pub fn serial_close(state: tauri::State<'_, SerialState>) -> Result<(), String> {
    let mut guard = state.port.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        *guard = None;
        log::info!("Serial port closed");
    }
    Ok(())
}

// ── GPS serial port (read-only, separate from CI-V) ────────────────────────

/// Open a GPS NMEA serial port (IC-705 USB-B, typically 9600 baud).
#[tauri::command]
pub fn serial_gps_open(
    state: tauri::State<'_, GpsSerialState>,
    port_name: String,
    baud_rate: Option<u32>,
) -> Result<(), String> {
    let mut guard = state.port.lock().map_err(|e| e.to_string())?;
    *guard = None; // close previous if any

    let port = serialport::new(&port_name, baud_rate.unwrap_or(9600))
        .parity(serialport::Parity::None)
        .stop_bits(serialport::StopBits::One)
        .timeout(Duration::from_millis(50))
        .open()
        .map_err(|e| format!("GPS port open failed ({}): {}", port_name, e))?;

    log::info!("GPS serial port opened: {} @ {} baud", port_name, baud_rate.unwrap_or(9600));
    *guard = Some(port);
    state.buf.lock().map_err(|e| e.to_string())?.clear();
    Ok(())
}

/// Read one complete NMEA line from the GPS port.
/// Returns an empty string if no complete line is available yet.
/// The caller should poll this at ~10 Hz.
#[tauri::command]
pub fn serial_gps_readline(
    state: tauri::State<'_, GpsSerialState>,
) -> Result<String, String> {
    let mut port_guard = state.port.lock().map_err(|e| e.to_string())?;
    let port = match port_guard.as_mut() {
        Some(p) => p,
        None => return Ok(String::new()),
    };
    let mut buf_guard = state.buf.lock().map_err(|e| e.to_string())?;

    // Drain available bytes into the line buffer (non-blocking, 50 ms timeout)
    let mut tmp = [0u8; 256];
    match port.read(&mut tmp) {
        Ok(n) => buf_guard.extend_from_slice(&tmp[..n]),
        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
        Err(e) => return Err(format!("GPS read error: {}", e)),
    }

    // Return one complete line if available
    if let Some(pos) = buf_guard.iter().position(|&b| b == b'\n') {
        let line = buf_guard.drain(..=pos).collect::<Vec<u8>>();
        let s = String::from_utf8_lossy(&line).trim_end().to_string();
        return Ok(s);
    }
    Ok(String::new())
}

/// Close the GPS serial port.
#[tauri::command]
pub fn serial_gps_close(
    state: tauri::State<'_, GpsSerialState>,
) -> Result<(), String> {
    let mut guard = state.port.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        *guard = None;
        log::info!("GPS serial port closed");
    }
    Ok(())
}
