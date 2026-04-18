# WebFT8 PWA User Manual

**[Japanese version](manual.md)** | **[Open App](https://jl1nie.github.io/webft8/)**

WebFT8 is a browser-based FT8 QSO application -- decode, transmit, CAT control, and log management in a single PWA. No installation required -- works on Chrome, Edge, and Safari (WebKit).

---

## Screen Layout

```
+--------------------------------------+
| WebFT8 [Scout][Snipe] 14.074  12s * | <- Header (mode/band/secs/settings)
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

1. Open the [app](https://jl1nie.github.io/webft8/)
2. The settings panel (gear icon) opens automatically (first time only)
3. Enter the following:
   - **My Callsign** -- your callsign (e.g., `W1AW`). Auto-converted to uppercase
   - **My Grid** -- your grid locator (e.g., `FN31`). Auto-converted to uppercase
   - **Audio Input** -- select your USB audio interface (receive side)
   - **Audio Output** -- select TX audio output device (transmit side)
   - **RX / TX Gain** -- adjust input/output levels with sliders (see below)
4. Select operating band from the **Band** selector in the header (e.g., `14.074 (20m)`)
5. **Tap the logo (WebFT8)** to start live decoding (logo turns blue)

> Audio device selections are saved in localStorage and automatically restored on next visit. After initial setup, just tap the logo to start.

---

## Header

```
WebFT8 [Scout][Snipe]  14.074(20m)  12s  *
```

| Element | Description |
|---------|-------------|
| **WebFT8 logo** | Tap to toggle Audio Start/Stop. Dimmed = stopped, blue = live |
| **Mode tabs** | Scout / Snipe toggle |
| **Band selector** | Operating band. On change, sets rig VFO frequency and mode (DATA-USB) when CAT is connected |
| **Seconds remaining** | Integer seconds until next period boundary |
| **DT±X.X** | Clock offset display. Shows the auto-corrected value (in seconds) when DT auto-correct is ON and signals have been decoded |
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

The core of Snipe mode is the **independent control of DF (TX frequency) and BPF (RX window center)**. Your transmit frequency (DF) is chosen once in Watch phase and stays fixed throughout the QSO. Meanwhile, the 500 Hz hardware BPF center continuously tracks the target station's frequency. This means you can **transmit from a clean, uncrowded slot while the pre-ADC filter stays precisely aimed at the DX station** — maximising SNR exactly where it matters. If the DX station drifts slightly during a pileup, only the BPF follows; there is no need to retune your TX frequency.

#### Watch Phase (Full-Band Receive)

Find the target and choose the **transmit frequency (DF)**. Receive is full-band (100--3000 Hz).

| Action | Effect |
|--------|--------|
| **Tap waterfall** | Set **DF (TX frequency)** (shown as red dashed line) |
| **Tap an RX message** | Set that station as target (AP auto-enabled) and set **BPF center** to that station's frequency. TX actions show a "Call" button for the sender |

**Phase hint:** Status shows `full-band  DF 1200 Hz` (small text, top-right of Watch/Call tabs)

**Watch display:**

- **Top card**: `TARGET_CALL  1234 Hz  -18 dB` — target callsign and latest heard freq/SNR on one line
- **Picked line**: `Picked: YB2AYA@1234` — who the DX responded to this period and their DF. Decoded from the DX's own transmit period, so always visible. Shows who is getting through — if it's not you, the slot is in play
- **Message list**: DF / DT / SNR / Message unified format with period separators. Shared between Watch and Call — preserved across phase switches
- **QSO progress dots**: filled → → → all filled

#### Call Phase (Narrow-Filter Receive)

Once you've set the DF in Watch, switch to **Call**. When CAT is connected, the rig's DSP narrow filter (FIL3) is automatically engaged, and the VFO shifts so the BPF center (1500 Hz audio, USB passband standard) covers the target.

| Action | Effect |
|--------|--------|
| **Tap waterfall** | Set **BPF (RX window center)**. DF (TX frequency) stays as set in Watch. VFO tracks BPF when CAT is connected |
| **Tap an RX message** | Set BPF center to that station's frequency and update VFO accordingly |

**Phase hint:** Status shows `BPF 1050 Hz  DF 1200 Hz`

- 500 Hz BPF window shown as a cyan band on the waterfall
- Only messages involving you and the target are displayed (noise reduction)
- If you tapped a target in Watch, Auto mode continues the QSO automatically in Call
- Switching to Call alone does not start TX — tap a target in Watch first to initiate the QSO
- QSO failure (retry limit reached) → auto-reverts to Watch, rig filter restored to wide
- You can manually switch back to Watch to change DF

**VFO tracking (when CAT is connected):**

Moving the BPF window shifts the rig VFO so the physical filter always covers the target. The BPF center is always 1500 Hz in audio (the USB passband center per ITU standard), so `dial_freq = band_freq + (BPF_target − 1500)`. Returning to Watch restores the VFO to the original band frequency.

**Switching Watch / Call:**

Use the `[Watch] [Call]` tabs at the top of the Snipe view. The message list is shared and preserved across phase switches. Returning to Watch automatically restores the CAT filter to wide (FIL2).

---

## Waterfall

Real-time spectrogram covering 100-3000 Hz. Scout: responsive height (min(25vh, 220px)), Snipe: 280px.

| Element | Description |
|---------|-------------|
| **Top labels** | Frequency axis (200, 500, 1000, 1500, 2000, 2500 Hz) |
| **Red dashed line (vertical)** | DF (TX frequency) -- shown in all modes on tap |
| **Cyan band** | Snipe Call phase 500 Hz BPF window |
| **Red dashed line (horizontal)** | Period boundary (15-second intervals) |
| **Yellow text** | Decoded messages |
| **Tap / click** | Set DF + status bar shows frequency |
| **WAV drag & drop** | Offline analysis (auto-stops live audio) |

### How FT8 signals look

FT8 signals appear as ~50 Hz wide vertical bands that **smoothly snake between 8 tone positions, hopping every 160 ms (one symbol)**. This is the natural per-symbol visualization of 8-GFSK modulation — it is **normal**, not a glitch.

WSJT-X uses a much longer FFT integration window (~2.7 s ≈ 17 symbols), so the per-symbol tone hops are averaged out into uniform 50 Hz wide bars. WebFT8 renders per-symbol ("honest"), WSJT-X renders per-frame ("tidied up"). The display difference does not affect decode quality.

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

**State navigation (desync recovery):**

While a QSO is active (any state other than IDLE), a state nav row appears below the TX buttons. Use it to manually recover when your state machine falls out of sync with the other station.

| Button | Visible in state | Action |
|--------|-----------------|--------|
| `← CALLING` | REPORT / FINAL | Force back to CALLING; retransmit grid |
| `→ REPORT` | CALLING | Advance to REPORT; send SNR report |
| `→ FINAL` | REPORT | Advance to FINAL; send RR73 |
| `✓ Complete` | FINAL | Log the QSO and return to IDLE (no need to receive 73) |
| `↺ Reset` | All states | Cancel TX and reset to IDLE |

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

- **Auto ON**: Fully automatic state transitions. Retries on no response (up to 5 times = 75 seconds).
- **Auto OFF**: TX message selector buttons appear for manual selection.
- When the retry limit is reached, the QSO is logged as incomplete.
- **Desync recovery**: Use the state nav buttons in the TX actions area to manually force a state transition (see [TX Actions](#tx-actions-bottom-bar)).

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

Some FT8 message types (Type 4 non-standard calls, DXpedition messages, etc.) transmit callsigns as 10/12/22-bit hashes. Normally displayed as `<...>`, WebFT8 automatically builds a **hash table from decoded callsigns** and resolves hashes to actual calls like `<JA1ABC>` in subsequent messages.

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

Open/close with the gear icon. Organized as an accordion with 5 sections (ordered by importance).

### Station

| Item | Description |
|------|-------------|
| **My Callsign** | Your callsign (auto-uppercase on input) |
| **My Grid** | Grid locator (4 characters, auto-uppercase) |

### Rig

| Item | Description |
|------|-------------|
| **Audio Input** | Receive audio device (selection auto-saved) |
| **Audio Output** | TX audio output device (selection auto-saved) |
| **RX / TX Gain** | Input/output level sliders + level meters |
| **Test Tone** | Continuous carrier for ALC adjustment (CAT PTT auto) |
| **Start Audio** | Start or stop live decoding (also via logo tap) |
| **Transport** | Connection type (Serial / BLE). Serial-only on platforms without Web Bluetooth |
| **Rig Model** | Rig selector dropdown (shown for Serial only) |
| **Port** | COM port selector (Tauri desktop only) |
| **Connect** | Connect/disconnect using the selected transport. BLE is IC-705 only |
| **GPS Sync** | Sync UTC from IC-705 USB-B NMEA or BLE CI-V |
| **NTP Sync** | Sync time via HTTP (**mobile only**) |

### Log

| Item | Description |
|------|-------------|
| **Export ZIP (ADIF + RX)** | Download QSO and RX logs as ZIP |
| **Clear All Logs** | Delete all logs (confirmation dialog shown) |

### TX Messages

| Item | Description |
|------|-------------|
| **Tx1 CQ suffix** | CQ suffix (POTA / SOTA / DX, max 4 chars) |
| **Tx5 Free text** | Free text (SOTA ref, POTA ref, JCC, max 13 chars). Replaces RR73 |

### Decode

| Item | Description |
|------|-------------|
| **Strictness** | Decode sensitivity vs false-positive (Strict / Normal / Deep) |
| **Equalizer** | Adaptive equalizer (Off / Adaptive). BPF edge correction |
| **Retry limit** | QSO retry count limit (default 5) |
| **Multi-pass subtract** | Successive interference cancellation (3-pass SIC). Default ON |
| **A Priori (AP)** | AP decoding. Default ON |
| **CQ reply: best SNR** | ON: respond to strongest CQ. OFF: first decoded |
| **DT auto-correct** | ON: automatically corrects the clock offset using the median DT of decoded FT8 signals. Shows `DT±X.X` in the header. Default ON |
| **Waterfall FFT** | Toggle waterfall display |
| **Open WAV File** | Select a WAV file for offline analysis |

> AP target is set automatically -- from the QSO partner in Scout mode, or from the tapped target in Snipe mode. No manual input needed.

### Pipelined Decode

When Subtract is ON, decoding runs in two phases:

1. **Phase 1** (~200ms): fast decode of strong signals → shown in chat immediately
2. **Phase 2** (~300-800ms): 3-pass subtract for weaker signals → appended to chat

Phase 1's FFT cache is reused by Phase 2, reducing computation. If budget is exceeded, Phase 2 is skipped (strong signals are already captured in Phase 1).

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

- **Requirements**: 16-bit / mono WAV (any sample rate — 12 / 44.1 / 48 kHz etc., auto-resampled in Rust)
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
2. In the settings panel **Rig** section, select **Transport: Serial** (default)
3. Select **Rig Model**
4. Click **Connect** — the browser serial port dialog opens (Tauri: select from dropdown)
5. Select the port — connected

### IC-705 BLE Connection (Mobile / Wireless)

The IC-705 supports BLE (Bluetooth Low Energy) for CI-V CAT commands. This lets you control PTT and frequency from a smartphone without cables. Audio still needs a separate path (USB audio cable or 3.5mm).

> **BLE = CAT control only.** Audio (RX/TX) does not go through BLE. Connect audio via USB OTG cable or the ACC/SP jacks.

#### First-time Setup

BLE requires no OS-level pairing. Just follow these steps:

1. **On the IC-705:** MENU → **SET** → **Bluetooth** → **Bluetooth** = **ON**, then tap **Pairing from Other Device** to start waiting
2. **In WebFT8 settings** (gear icon) → **Rig** section, select **Transport: BLE**
3. Tap **Connect** — the browser device selection dialog opens
4. Select "ICOM BT(IC-705)" — status shows "connected" — done!

#### Subsequent Connections

Once paired, the IC-705 remembers the device. On the next session:

1. Ensure IC-705 Bluetooth is ON (it usually stays on)
2. In WebFT8, tap the logo (or settings → **Transport: BLE** → **Connect**)
3. Select the IC-705 from the dialog — connects in seconds

#### Requirements

| Item | Details |
|------|---------|
| **Browser** | Chrome on Android (Web Bluetooth required) |
| **iOS** | Safari does not support Web Bluetooth. Use [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) browser |
| **Location** | Android requires Location (GPS) to be ON for BLE scanning |
| **Audio** | Separate USB audio cable or 3.5mm cable required |

#### Troubleshooting

| Problem | Solution |
|---------|----------|
| IC-705 not found in dialog | Turn on phone Location (GPS). Confirm IC-705 Pairing Reception = ON |
| Pairing fails | Delete old pairing on both devices, retry from step 1 |
| Connected but no PTT | Check IC-705 CI-V address (default 0xA4). Ensure DATA mode |
| Audio not working | BLE is CAT only. Connect USB audio cable separately |

### Automatic CAT Functions

| Function | Trigger |
|----------|---------|
| **Auto-connect** | On app launch, if a rig and port are saved in settings, connects automatically |
| **Rig setup** | After connect: sets DATA-USB mode → 200 ms delay → band frequency → wide filter (FIL2) |
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
| WAV drop error | Verify 16-bit / mono format (any sample rate is OK) |
| CAT won't connect | Use Chrome / Edge. Restart browser and retry |
| `port busy or unresponsive` shown | Another CAT app (e.g. WSJT-X) is holding the same COM port. Close it and retry |
| IC-705 not found via BLE | Ensure phone Location is ON. Ensure IC-705 Pairing Reception is ON. Pair in OS settings first |
| CAT disconnected appears | Command write collision. Restart browser and reconnect |
| Waterfall is black | Verify the correct Audio Input device. Tap logo to restart |
| QSO not progressing | Check that Auto is ON. Tap an RX message to select the target station |
| `[-sub]` `[-sub,AP]` shown | Decode is too heavy; features auto-paused. Will recover when budget allows |
| `<...>` not resolved | That station hasn't been decoded in this session. Hash table clears on page reload |

---

## PWA Installation (Offline Support)

WebFT8 can be installed as a PWA on your device and works offline.

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
