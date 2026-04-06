# rs-ft8n PWA User Manual

**[Japanese version](manual.md)** | **[Open App](https://jl1nie.github.io/rs-ft8n/)**

rs-ft8n is a browser-based FT8 QSO application -- decode, transmit, CAT control, and log management in a single PWA. No installation required -- works on Chrome, Edge, and Safari (WebKit).

---

## Screen Layout

```
+--------------------------------------+
| rs-ft8n [Scout][Snipe] 14.074  12s * | <- Header (mode/band/secs/settings)
|--------------------------------------|
| ::::::::: Waterfall ::::::::::::::::: | <- Waterfall (tap to set DF)
| ::::::::|::::::::::::::::::::::::::::: |    Red dashed line = current DF
|--------------------------------------|
| oooo CALLING 3Y0Z  12 decoded(213ms)| <- Scout status bar
|--------------------------------------|
| --- 12:30 -------------------------- | <- Period separator (UTC inline)
|  1234 +0.3  -12  CQ 3Y0Z JD34       | <- DF  DT  SNR  Message
|   800 +0.1   -8  JA1ABC 3Y0Z PM95   |
|--------------------------------------|
| [CQ]  [Halt]  Auto                  | <- TX actions (dynamic)
+--------------------------------------+
```

---

## Initial Setup

1. Open the [app](https://jl1nie.github.io/rs-ft8n/)
2. The settings panel (gear icon) opens automatically (first time only)
3. Enter the following:
   - **My Callsign** -- your callsign (e.g., `W1AW`). Auto-converted to uppercase
   - **My Grid** -- your grid locator (e.g., `FN31`). Auto-converted to uppercase
   - **Audio Input** -- select your USB audio interface (receive side)
   - **Audio Output** -- select TX audio output device (transmit side)
   - **RX / TX Gain** -- adjust input/output levels with sliders (see below)
4. Select operating band from the **Band** selector in the header (e.g., `14.074 (20m)`)
5. **Tap the logo (rs-ft8n)** to start live decoding (logo turns blue)

> Audio device selections are saved in localStorage and automatically restored on next visit. After initial setup, just tap the logo to start.

---

## Header

```
rs-ft8n [Scout][Snipe]  14.074(20m)  12s  *
```

| Element | Description |
|---------|-------------|
| **rs-ft8n logo** | Tap to toggle Audio Start/Stop. Dimmed = stopped, blue = live |
| **Mode tabs** | Scout / Snipe toggle |
| **Band selector** | Operating band. On change, sets rig VFO frequency and mode (DATA-USB) when CAT is connected |
| **Seconds remaining** | Integer seconds until next period boundary |
| **Gear icon** | Open settings panel |

---

## Two Modes

### Scout Mode -- Casual CQ Operation

A chat-style UI for relaxed QSOs. Ideal for portable operation and smartphone use.

**Basic operations:**

| Action | Effect |
|--------|--------|
| **CQ button** | Queue CQ for the next period |
| **Tap waterfall** | Set TX frequency (DF). Shown as a red dashed vertical line |
| **Tap an RX message** | Call the sender (call2) of that message (TX queued for next period) |
| **Auto checkbox** | ON: automatic responses. OFF: manually select TX messages |
| **Halt** | Immediately stop transmission |

**Scout status bar (between waterfall and list):**

```
oooo CALLING  3Y0Z   |   12 decoded (213ms)
```

- Progress dots (4 stages: grey=pending, blue=current, green=done)
- QSO state + DX callsign
- Decode count + decode time
- IDLE: decode info only

**Message display:**

```
--- 12:30 --------------------------
 1234  +0.3  -12  CQ 3Y0Z JD34
  800  +0.1   -8  JA1ABC 3Y0Z PM95
--- 12:45 --------------------------
 1500  +0.2   -5  CQ VK2RG QF56
```

- **DF / DT / SNR / Message** in unified column format
- Period boundaries shown as UTC timestamp inline separator (skipped when 0 decodes)
- Blue border = RX, grey border = TX
- **Yellow bold** = your callsign, **green bold** = QSO partner

**QSO flow (Auto mode):**

1. Tap the waterfall to set DF
2. Tap CQ to queue for next period, or tap an RX message to call that station
3. Response received -- automatic report exchange
4. RR73 / 73 -- QSO complete (auto-saved to log)

**Scout AP decoding:**

During an active QSO, A Priori (AP) decoding is automatically enabled using the QSO partner's callsign (no manual input needed). If decode time exceeds the FT8 budget, AP and subtract are automatically paused (see [Adaptive Budget](#adaptive-budget-scout-mode)).

---

### Snipe Mode -- DX Hunting

A dedicated mode for hunting target stations. The waterfall is larger.

The core of Snipe mode is the **separation of DF (TX frequency) and BPF (RX window center)**. Set the transmit frequency in Watch phase, then in Call phase only the receive window moves to track the target. This enables "off-frequency calling" where you transmit on a different frequency than the DX station.

#### Watch Phase (Full-Band Receive)

Find the target and choose the **transmit frequency (DF)**. Receive is full-band (100--3000 Hz).

| Action | Effect |
|--------|--------|
| **Tap waterfall** | Set **DF (TX frequency)** (shown as red dashed line) |
| **Tap an RX message** | Set call1 as target (AP auto-enabled). A secondary "Call call2" button also appears in TX actions |

**Phase hint:** Status shows `full-band  DF 1200 Hz`

**Watch display:**

- **Top**: Target station's latest message (call / frequency / SNR)
- **Callers**: List of other stations calling the target
- **Message list**: DF / DT / SNR / Message in unified format (with period separators)
- **QSO progress dots**: filled-circle empty-circle empty-circle empty-circle -> all filled

#### Call Phase (Narrow-Filter Receive)

Once you've set the DF in Watch, switch to **Call**. When CAT is connected, the rig's DSP narrow filter (FIL3) is automatically engaged, and the VFO frequency shifts to track the BPF window center.

| Action | Effect |
|--------|--------|
| **Tap waterfall** | Set **BPF (RX window center)**. DF (TX frequency) remains as set in Watch. VFO tracks BPF when CAT is connected |

**Phase hint:** Status shows `BPF 1050 Hz  DF 1200 Hz`

- 500 Hz BPF window shown as a cyan band on the waterfall
- Only messages involving you and the target are displayed (noise reduction)
- If you tapped a target in Watch, Auto mode continues the QSO state progression automatically
- Switching to Call alone does not start TX -- tap a target in Watch first to initiate the QSO
- QSO failure (retry limit reached) -- auto-reverts to Watch, rig filter restored to wide
- You can manually switch back to Watch to change DF

**VFO tracking (when CAT is connected):**

Moving the BPF window automatically shifts the rig's VFO frequency so the physical filter covers the target signal. Returning to Watch restores the VFO to the original band frequency.

**Switching Watch / Call:**

Use the `[Watch] [Call]` tabs at the top of the Snipe view. The message list is preserved when switching. Returning to Watch automatically restores the CAT filter to wide (FIL2).

---

## Waterfall

Real-time spectrogram covering 200-2800 Hz. Scout: responsive height (min(25vh, 220px)), Snipe: 280px.

| Element | Description |
|---------|-------------|
| **Top labels** | Frequency axis (200, 500, 1000, 1500, 2000, 2500 Hz) |
| **Red dashed line (vertical)** | DF (TX frequency) -- shown in all modes on tap |
| **Cyan band** | Snipe Call phase 500 Hz BPF window |
| **Red dashed line (horizontal)** | Period boundary (15-second intervals) |
| **Yellow text** | Decoded messages |
| **Tap / click** | Set DF + status bar shows frequency |
| **WAV drag & drop** | Offline analysis (auto-stops live audio) |

---

## TX Actions (Bottom Bar)

All TX is **synchronized to the next period boundary** (never immediate).

| QSO State | Auto ON | Auto OFF |
|-----------|---------|----------|
| **IDLE** | `[CQ]` button | `[CQ]` button |
| **Active QSO** | Single next-TX message | All TX options as buttons |

- **Snipe**: A secondary `[Call xxx]` button appears when call2 differs from the target
- **Halt / Reset (progressive)**: First tap = stop TX immediately (button changes to "Reset"), second tap = reset QSO (saved as incomplete to log)
- Status bar shows `TX queued: ...` when TX is pending

---

## QSO State Machine

QSO management uses a 4-state progression:

```
IDLE -> CALLING -> REPORT -> FINAL -> IDLE (complete)
```

| State | Meaning | TX content |
|-------|---------|------------|
| **IDLE** | Standby | -- |
| **CALLING** | Calling | `DX MYCALL GRID` or `CQ MYCALL GRID` |
| **REPORT** | Report exchange | `DX MYCALL R+00` |
| **FINAL** | Awaiting confirmation | `DX MYCALL RR73` or `73` |

- **Auto ON**: Fully automatic state transitions. Retries on no response (up to 15 times).
- **Auto OFF**: TX message selector buttons appear for manual selection.
- When the retry limit is reached, the QSO is logged as incomplete.

---

## Adaptive Budget (Scout Mode)

In Scout mode, when decode time exceeds the FT8 budget (2.4 seconds), heavy features are automatically paused in order:

| Priority | Feature | Load |
|----------|---------|------|
| 1 (OFF first) | Multi-pass subtract | 3-pass SIC (heaviest) |
| 2 (OFF next) | A Priori (AP) | Sniper + EQ single pass |

The status bar shows `[-sub]` or `[-sub,AP]` when features are paused.

Recovery at 60% budget headroom, in reverse order:
1. AP re-enabled first
2. Subtract re-enabled when budget allows

Snipe mode always runs both features (narrow band = fast enough).

---

## Callsign Hash Resolution

Some FT8 message types (Type 4 non-standard calls, DXpedition messages, etc.) transmit callsigns as 10/12/22-bit hashes. Normally displayed as `<...>`, rs-ft8n automatically builds a **hash table from decoded callsigns** and resolves hashes to actual calls like `<JA1ABC>` in subsequent messages.

The table accumulates during the WASM session (max 1000 entries, LRU eviction) and clears on page reload.

---

## Audio Level Controls

The Station section in the settings panel provides RX / TX level adjustment.

| Item | Description |
|------|-------------|
| **RX gain slider** | Receive input level (0--200%). Adjusts GainNode before the decoder |
| **RX level meter** | Real-time peak level display (green = normal, red = clipping). Slider changes reflected instantly |
| **TX gain slider** | Transmit output level (0--200%) |
| **TX level meter** | Peak level display during Test Tone and transmission. Slider changes reflected instantly |
| **CLIP indicator** | Red **CLIP** text lights up when digital waveform peak exceeds 95% |
| **Test Tone button** | Plays a continuous sine wave at the current DF frequency. Tap to start/stop. Use to adjust rig input level |

### RX Level Adjustment

Excessive input levels are a major cause of decode failure. If the RX meter is constantly red (CLIP), reduce the RX gain or lower the rig's audio output level.

### TX Level Adjustment

**The CLIP indicator only reflects digital clipping within the app.** No digital distortion occurs at TX gain 100% or below.

However, the actual signal level reaching the rig is determined outside the app:

- **Phone OS media volume** -- Android volume slider
- **USB audio DAC output level** -- device-specific
- **Rig MOD input gain** -- analog stage setting

These are not reflected in the app's CLIP indicator. Play Test Tone and check the **rig's ALC meter** to ensure ALC does not deflect. Adjust OS volume and TX gain accordingly.

Gain settings are saved to localStorage and restored on next launch.

---

## Settings Panel

Open/close with the gear icon. Organized as an accordion with 4 sections.

### Station

| Item | Description |
|------|-------------|
| **My Callsign** | Your callsign (auto-uppercase on input) |
| **My Grid** | Grid locator (4 characters, auto-uppercase) |
| **Audio Input** | Receive audio device (selection auto-saved) |
| **Audio Output** | TX audio output device (selection auto-saved) |
| **RX / TX Gain** | Input/output level sliders + level meters + CLIP indicators |
| **Start Audio** | Start or stop live decoding (also via logo tap) |

### CAT

| Item | Description |
|------|-------------|
| **Rig Model** | Rig selector dropdown (dynamically populated from rig-profiles.json) |
| **Connect CAT** | Connect to rig via Web Serial. Desktop Chrome / Edge only |
| **Connect BLE** | Connect to IC-705 via Web Bluetooth. Mobile supported (see below) |

### Decode

| Item | Description |
|------|-------------|
| **Multi-pass subtract** | Successive interference cancellation (3-pass SIC). Default ON. Auto-paused over budget |
| **A Priori (AP)** | AP decoding. Default ON. Auto-paused over budget |
| **CQ response: first decoded** | ON: respond to the first decoded CQ. OFF (default): respond to the strongest SNR CQ |
| **Open WAV File** | Select a WAV file for offline analysis |

### Log

| Item | Description |
|------|-------------|
| **Export ZIP (ADIF + RX)** | Download QSO and RX logs as ZIP |
| **Clear All Logs** | Delete all logs (confirmation dialog shown) |

> AP target is set automatically -- from the QSO partner in Scout mode, or from the tapped target in Snipe mode. No manual input needed.

---

## Log Management

### Auto-Save

- **QSO complete**: Automatically saved to localStorage (state = IDLE)
- **QSO aborted**: Saved as incomplete on Reset or retry timeout (state = CALLING/REPORT/FINAL)
- **All RX messages**: All decoded messages accumulated in RX log (max 10,000 entries)

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

Drag & drop a WAV file onto the waterfall, or use **Open WAV File** in the settings panel.

- **Requirements**: 12 kHz / 16-bit / mono WAV
- Auto-stops live audio if active
- Waterfall + decode results displayed immediately

---

## CAT Control

### Web Serial (Desktop)

Uses the Web Serial API to control rig PTT, filter, frequency, and mode via USB.

**Supported rigs:**

| Protocol | Supported rigs |
|----------|---------------|
| **Yaesu text CAT** | FTDX10, FTDX101MP, FT-891 |
| **Icom CI-V** | IC-7300, IC-705, IC-7851 |

**Connection steps:**

1. Connect your rig to the PC via USB cable
2. Select **Rig Model** in the CAT section of the settings panel
3. **Connect CAT** -- browser serial port selection dialog opens
4. Select the port -- connected

### Web Bluetooth / IC-705 BLE (Mobile)

Mobile browsers do not support Web Serial, but the IC-705 supports BLE (Bluetooth Low Energy) for CI-V commands. Web Bluetooth API enables CAT control of the IC-705 from a smartphone.

**IC-705 BLE connection steps:**

1. **Pair IC-705 in your phone's OS Bluetooth settings** (standard Bluetooth pairing)
2. On IC-705: MENU -> Set -> Connectors -> Bluetooth -> **Pairing Reception = ON** (put radio in pairing-wait state)
3. **Turn on Location (GPS)** on your phone (required for Android BLE scanning)
4. In the app settings, tap **Connect BLE**
5. Select IC-705 from the browser's device selection dialog
6. The app connects via BLE GATT and automatically performs the application-level pairing sequence
7. IC-705 grants CI-V bus access -- connected

**Notes:**

- The Connect BLE button only appears in browsers that support Web Bluetooth
- Tested on Android Chrome. iOS Safari does not support Web Bluetooth (use Bluefy or similar)
- BLE connection auto-selects IC-705 as the rig model
- If already paired, skip step 1 (start from step 2 on subsequent connections)

### Automatic CAT Functions

| Function | Trigger |
|----------|---------|
| **PTT ON/OFF** | Automatic on TX start/end |
| **Mode setting** | Sets DATA-USB (FIL2) on band change |
| **Narrow filter** | FIL3 (500 Hz) auto-engaged on Snipe Call phase |
| **Wide filter** | FIL2 (2400 Hz) auto-restored on Snipe Watch phase |
| **VFO frequency** | Auto-set on band change. Tracks BPF window in Snipe Call phase |

**Icom rig filter setup (prerequisite):**

CI-V commands switch between FIL2 and FIL3. Configure the filter widths on the radio:
- **FIL2**: 2400 Hz (wide)
- **FIL3**: 500 Hz (narrow)

Setup: MENU -> Set -> Filter -> DATA-USB -> adjust FIL2 / FIL3 widths

> Web Serial API is only available in Chrome / Edge. Safari / Firefox are not supported.

---

## Troubleshooting

| Symptom | Solution |
|---------|----------|
| Logo stays dimmed | Tap logo to start audio. Check Audio Input is selected in settings |
| 0 decodes | Check antenna, audio level (verify no CLIP), and frequency (e.g., 14.074 MHz) |
| RX meter always shows CLIP | Lower RX gain or reduce rig audio output level |
| WAV drop error | Verify 12 kHz / 16-bit / mono format. 48 kHz WAV is not supported |
| CAT won't connect | Use Chrome / Edge. Restart browser and retry |
| IC-705 not found via BLE | Ensure phone Location is ON. Ensure IC-705 Pairing Reception is ON. Pair in OS settings first |
| CAT disconnected appears | Command write collision. Restart browser and reconnect |
| Waterfall is black | Verify the correct Audio Input device. Tap logo to restart |
| QSO not progressing | Check that Auto is ON. Tap an RX message to select the target station |
| `[-sub]` `[-sub,AP]` shown | Decode is too heavy; features auto-paused. Will recover when budget allows |
| `<...>` not resolved | That station hasn't been decoded in this session. Hash table clears on page reload |

---

## PWA Installation (Offline Support)

rs-ft8n can be installed as a PWA on your device and works offline.

**How to install:**

| Browser | Steps |
|---------|-------|
| **Chrome (PC)** | Click install icon in address bar, or Menu -> "Install app" |
| **Chrome (Android)** | Menu -> "Add to Home screen" |
| **Safari (iOS)** | Share button -> "Add to Home Screen" |
| **Edge** | Menu -> "Apps" -> "Install this site as an app" |

After installation, launch from your home screen / app list as a standalone app. Files are cached on first online visit; WAV analysis works offline afterward (live audio requires device microphone permission).

> Updates: The app automatically downloads the latest version when online.

---

## System Requirements

| Item | Requirement |
|------|-------------|
| **Browser** | Chrome 90+, Edge 90+, Safari 15+ |
| **Web Serial** | Chrome / Edge only (desktop CAT control) |
| **Web Bluetooth** | Chrome Android (IC-705 BLE connection) |
| **Audio** | getUserMedia support (HTTPS or localhost) |
| **WASM** | WebAssembly support (all modern browsers) |
| **Display** | Mobile-friendly (responsive layout) |
