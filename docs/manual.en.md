# rs-ft8n PWA User Manual

**[Japanese version](manual.md)** | **[Open App](https://jl1nie.github.io/rs-ft8n/)**

rs-ft8n is a browser-based FT8 decoder PWA. No installation required — works on Chrome, Edge, and Safari (WebKit).

---

## Screen Layout

```
┌─────────────────────────────────────┐
│ rs-ft8n [Scout][Snipe]   12.3s  ⚙  │  ← Header (mode tabs, timer, settings)
├─────────────────────────────────────┤
│ ▓▓▓▓▓▓▓ Waterfall ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │  ← Waterfall (tap to set DF)
├─────────────────────────────────────┤
│                                     │
│   Message display area              │  ← Varies by mode
│                                     │
├─────────────────────────────────────┤
│ [CQ] [TX] [Halt] ☐Auto  status     │  ← Control buttons
├─────────────────────────────────────┤
│ Drop WAV | select file              │  ← File input
└─────────────────────────────────────┘
```

---

## Initial Setup

1. Open the [app](https://jl1nie.github.io/rs-ft8n/)
2. The settings panel (gear icon ⚙ in the top right) opens automatically
3. Enter the following:
   - **My Callsign** — your callsign (e.g., `W1AW`)
   - **My Grid** — your grid locator (e.g., `FN31`)
   - **Audio Input** — select your USB audio interface (receive side)
   - **Audio Output** — select TX audio output device (transmit side)
4. Tap **Start Audio** to begin live decoding

> For CAT control, select your CAT Protocol and tap **Connect CAT**. Requires a Web Serial API compatible browser (Chrome / Edge).

---

## Two Modes

### Scout Mode — Casual CQ Operation

A chat-style UI for relaxed QSOs. Ideal for portable operation and smartphone use.

**Basic operations:**

| Action | Effect |
|--------|--------|
| **CQ button** | Transmit CQ |
| **Tap waterfall** | Set TX frequency (DF). Shown as a red dashed vertical line |
| **Tap an RX message** | Call that station (auto-starts QSO) |
| **Auto checkbox** | ON: automatic responses. OFF: manually select TX messages |
| **Halt** | Immediately stop transmission |

**Chat display:**

- Blue border = received message (RX)
- Grey border = transmitted message (TX)
- **Yellow bold** = your callsign
- **Green bold** = QSO partner's callsign
- Left number = SNR (dB)

**QSO flow (Auto mode):**

1. Tap CQ to call CQ, or tap an RX message to call that station
2. Response received → automatic report exchange
3. RR73 / 73 → QSO complete (auto-saved to log)

---

### Snipe Mode — DX Hunting

A dedicated mode for hunting target stations. The waterfall is larger and the 500 Hz BPF window is visualized.

#### Watch Phase (Full-Band Receive)

Find the target and choose a calling frequency.

| Action | Effect |
|--------|--------|
| **DX Call (AP)** in settings | Set target station (enables AP decoding) |
| **Tap waterfall** | Set the center frequency of the 500 Hz window |
| **Tap an RX message** | Set that station as target |

**Watch display:**

- **Top**: Target station's latest message (call / frequency / SNR)
- **Callers**: List of other stations calling the target
- **Bottom**: All band activity (full RX message list)
- **QSO progress dots**: ●○○○ → ●●○○ → ●●●○ → ●●●●

#### Call Phase (Keep Calling)

Once you've set the DF in Watch, switch to **Call**.

- Only messages involving you and the target are displayed (noise reduction)
- Automatically starts calling the target
- QSO failure (retry limit reached) → auto-reverts to Watch
- You can manually switch back to Watch to change DF

**Switching Watch / Call:**

Use the `[Watch] [Call]` tabs at the top of the Snipe view.

---

## Waterfall

Real-time spectrogram covering 200-2800 Hz.

| Element | Description |
|---------|-------------|
| **Top labels** | Frequency axis (200, 500, 1000, 1500, 2000, 2500 Hz) |
| **Red dashed line (vertical)** | Scout mode DF (TX frequency) |
| **Cyan band** | Snipe mode 500 Hz window |
| **Red dashed line (horizontal)** | Period boundary (15-second intervals) |
| **Yellow text** | Decoded messages |
| **Tap / click** | Set DF / window center frequency |

---

## QSO State Machine

QSO management uses a 4-state progression:

```
IDLE → CALLING → REPORT → FINAL → IDLE (complete)
```

| State | Meaning | TX content |
|-------|---------|------------|
| **IDLE** | Standby | — |
| **CALLING** | Calling | `DX MYCALL GRID` or `CQ MYCALL GRID` |
| **REPORT** | Report exchange | `DX MYCALL R+00` |
| **FINAL** | Awaiting confirmation | `DX MYCALL RR73` or `73` |

- **Auto ON**: Fully automatic state transitions. Retries on no response (up to 15 times).
- **Auto OFF**: TX message selector buttons appear for manual selection.
- When the retry limit is reached, the QSO is logged as incomplete.

---

## Settings Panel

Open/close with the gear icon ⚙.

| Item | Description |
|------|-------------|
| **My Callsign** | Your callsign |
| **My Grid** | Grid locator (4 characters) |
| **Audio Input** | Select microphone / USB audio |
| **Audio Output** | Select TX audio output device (default: system output) |
| **DX Call (AP)** | Target station call (AP decoding + Snipe target) |
| **CAT Protocol** | Yaesu (FTDX10) / Icom (CI-V) |
| **Connect CAT** | Connect to rig via Web Serial (PTT control) |
| **Start / Stop Audio** | Start or stop live decoding |
| **Reset QSO** | Abort QSO (saved as incomplete to log) |
| **Multi-pass subtract** | Enable/disable successive interference cancellation (3-pass SIC) |

---

## Log Management

### Auto-Save

- **QSO complete**: Automatically saved to localStorage
- **QSO aborted**: Saved as incomplete on Reset or retry timeout (with state tag)
- **All RX messages**: All decoded messages are accumulated in the RX log (max 10,000 entries)

### ZIP Export

Tap **Export ZIP (ADIF + RX)** in the settings panel to download a ZIP containing 3 files:

| File | Contents |
|------|----------|
| `qso_complete_YYYYMMDD.adi` | Completed QSOs only (for LoTW / Club Log upload) |
| `qso_all_YYYYMMDD.adi` | All QSOs (incomplete entries include `<COMMENT>incomplete:STATE</COMMENT>`) |
| `rx_YYYYMMDD.csv` | All received decode log (UTC, Freq, SNR, Message) |

### Clearing Logs

**Clear All Logs** button deletes both QSO and RX logs (confirmation dialog shown).

---

## Offline Analysis with WAV Files

You can analyze recorded WAV files without live audio.

1. Stop live decoding, then drag & drop a WAV file onto the drop zone (or click "select file")
2. **Requirements**: 12 kHz / 16-bit / mono WAV
3. Waterfall + decode results are displayed immediately

---

## CAT Control

Uses the Web Serial API to control rig PTT from the browser.

**Supported protocols:**

| Protocol | Example rigs | Baud rate |
|----------|-------------|-----------|
| **Yaesu** | FTDX10, FT-991A, etc. | 38400 |
| **Icom CI-V** | IC-7300, IC-705, etc. | 19200 |

**Connection steps:**

1. Connect your rig to the PC via USB cable
2. Select CAT Protocol in the settings panel
3. **Connect CAT** → browser serial port selection dialog opens
4. Select the port → connected
5. PTT is automatically controlled during TX

> Web Serial API is only available in Chrome / Edge. Safari / Firefox are not supported.

---

## Keyboard Shortcuts

The current version does not have keyboard shortcuts. All operations are performed with buttons and taps.

---

## Troubleshooting

| Symptom | Solution |
|---------|----------|
| "Select audio device" shown | Select Audio Input in the settings panel |
| 0 decodes | Check antenna, audio level, and frequency (e.g., 14.074 MHz) |
| WAV drop error | Verify 12 kHz / 16-bit / mono format. 48 kHz WAV is not supported |
| CAT won't connect | Use Chrome / Edge. Restart browser and retry |
| Waterfall is black | Verify the correct Audio Input device. Press Start Audio again |
| QSO not progressing | Check that Auto is ON. Verify DX Call is correct |

---

## System Requirements

| Item | Requirement |
|------|-------------|
| **Browser** | Chrome 90+, Edge 90+, Safari 15+ |
| **Web Serial** | Chrome / Edge only (required for CAT control) |
| **Audio** | getUserMedia support (HTTPS or localhost) |
| **WASM** | WebAssembly support (all modern browsers) |
| **Display** | Mobile-friendly (responsive layout) |
