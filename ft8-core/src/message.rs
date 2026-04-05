// SPDX-License-Identifier: GPL-3.0-or-later
//! FT8 77-bit message decoder.
//!
//! Ported from WSJT-X `lib/77bit/packjt77.f90` (subroutines `unpack77`,
//! `unpack28`, `to_grid4`, `unpacktext77`).
//!
//! Only the most common message types are decoded:
//! - Type 0 n3=0 : Free text (71 bits → 13 chars)
//! - Type 1       : Standard (callsign + callsign + grid/report)
//! - Type 2       : Standard with /P suffix (EU VHF contest)
//! - Type 4       : One non-standard call + one hashed call
//!
//! For message types that require a hash table (22-bit hashed callsigns),
//! `<...>` is returned as a placeholder because we have no runtime call-sign
//! database.

// ── Character sets (match WSJT-X packjt77.f90) ──────────────────────────────

/// c1 in Fortran: 37 chars for callsign position 1
const C1: &[u8] = b" 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/";
/// c2: 36 chars for position 2
const C2: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/// c3: 10 chars for position 3 (digit only)
const C3: &[u8] = b"0123456789";
/// c4: 27 chars for positions 4-6 (space + A-Z)
const C4: &[u8] = b" ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/// c (38 chars) used for non-standard callsign in Type 4
const C38: &[u8] = b" 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/";
/// 42-char alphabet for free-text messages
const FREE_TEXT: &[u8] = b" 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?";

// ── Token boundaries ─────────────────────────────────────────────────────────

const NTOKENS: u32 = 2_063_592;
const MAX22: u32 = 4_194_304;
const MAX_GRID4: u32 = 32_400;

// ── Internal helpers ─────────────────────────────────────────────────────────

/// Read `len` bits starting at `start` from `msg` (MSB first) into a u32.
fn read_bits(msg: &[u8; 77], start: usize, len: usize) -> u32 {
    let mut n = 0u32;
    for i in start..start + len {
        n = (n << 1) | (msg[i] & 1) as u32;
    }
    n
}

/// Same as `read_bits` but returns u64 (for the 58-bit field in Type 4).
fn read_bits_u64(msg: &[u8; 77], start: usize, len: usize) -> u64 {
    let mut n = 0u64;
    for i in start..start + len {
        n = (n << 1) | (msg[i] & 1) as u64;
    }
    n
}

/// Decode a 28-bit packed callsign token.
///
/// Returns the human-readable callsign, "DE", "QRZ", "CQ", "CQ NNN",
/// "CQ XXXX", or "<...>" when the token is a 22-bit hash that cannot be
/// resolved without a call-sign database.
fn unpack28(n28: u32) -> String {
    if n28 < NTOKENS {
        return match n28 {
            0 => "DE".to_string(),
            1 => "QRZ".to_string(),
            2 => "CQ".to_string(),
            3..=1002 => format!("CQ {:03}", n28 - 3),
            _ => {
                // 1003..=532443: "CQ XXXX" (4-char directional CQ)
                let n = n28 - 1003;
                let i1 = (n / (27 * 27 * 27)) as usize;
                let n = n % (27 * 27 * 27);
                let i2 = (n / (27 * 27)) as usize;
                let n = n % (27 * 27);
                let i3 = (n / 27) as usize;
                let i4 = (n % 27) as usize;
                let suffix: String = [C4[i1], C4[i2], C4[i3], C4[i4]]
                    .iter()
                    .map(|&b| b as char)
                    .collect();
                format!("CQ {}", suffix.trim())
            }
        };
    }

    let n = n28 - NTOKENS;
    if n < MAX22 {
        // 22-bit hash — no call-sign database available
        return "<...>".to_string();
    }

    // Standard callsign: 6 characters from mixed alphabets
    let n = n - MAX22;
    let i1 = (n / (36 * 10 * 27 * 27 * 27)) as usize;
    let n = n % (36 * 10 * 27 * 27 * 27);
    let i2 = (n / (10 * 27 * 27 * 27)) as usize;
    let n = n % (10 * 27 * 27 * 27);
    let i3 = (n / (27 * 27 * 27)) as usize;
    let n = n % (27 * 27 * 27);
    let i4 = (n / (27 * 27)) as usize;
    let n = n % (27 * 27);
    let i5 = (n / 27) as usize;
    let i6 = (n % 27) as usize;

    if i1 >= C1.len() || i2 >= C2.len() || i3 >= C3.len()
        || i4 >= C4.len() || i5 >= C4.len() || i6 >= C4.len()
    {
        return "?????".to_string();
    }

    let s: String = [C1[i1], C2[i2], C3[i3], C4[i4], C4[i5], C4[i6]]
        .iter()
        .map(|&b| b as char)
        .collect();
    s.trim().to_string()
}

/// Decode a 15-bit Maidenhead grid square index.
fn to_grid4(n: u32) -> Option<String> {
    if n > MAX_GRID4 {
        return None;
    }
    let j1 = n / (18 * 10 * 10);
    let n = n % (18 * 10 * 10);
    let j2 = n / (10 * 10);
    let n = n % (10 * 10);
    let j3 = n / 10;
    let j4 = n % 10;
    if j1 > 17 || j2 > 17 {
        return None;
    }
    Some(format!(
        "{}{}{}{}",
        (b'A' + j1 as u8) as char,
        (b'A' + j2 as u8) as char,
        (b'0' + j3 as u8) as char,
        (b'0' + j4 as u8) as char,
    ))
}

/// Decode a 71-bit free-text message (13 chars from a 42-char alphabet).
fn unpack_free_text(msg: &[u8; 77]) -> String {
    let mut n = 0u128;
    for i in 0..71 {
        n = (n << 1) | (msg[i] & 1) as u128;
    }
    let mut chars = [b' '; 13];
    for i in (0..13).rev() {
        chars[i] = FREE_TEXT[(n % 42) as usize];
        n /= 42;
    }
    String::from_utf8(chars.to_vec())
        .unwrap_or_default()
        .trim()
        .to_string()
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Decode a 77-bit FT8 message into a human-readable string.
///
/// Returns `None` if the message type is unsupported or the bits are
/// inconsistent (e.g. unused type codes, bad grid index).
///
/// Supported types:
/// - `0/0`  Free text
/// - `0/1`  DXpedition RR73
/// - `0/3`, `0/4`  ARRL Field Day (callsigns only, exchange shown as `[FD]`)
/// - `1`    Standard: `CALL1 CALL2 GRID` or `CALL1 CALL2 REPORT`
/// - `2`    Standard with `/P`
/// - `4`    One non-standard callsign + 12-bit hashed counterpart
pub fn unpack77(msg: &[u8; 77]) -> Option<String> {
    let n3 = read_bits(msg, 71, 3);
    let i3 = read_bits(msg, 74, 3);

    match i3 {
        // ── Type 0: various sub-types ────────────────────────────────────
        0 => match n3 {
            0 => {
                let text = unpack_free_text(msg);
                if text.is_empty() { None } else { Some(text) }
            }
            1 => {
                // DXpedition: CALL1 RR73; CALL2 <hash> REPORT
                // Format: b28 b28 b10 b5
                let n28a = read_bits(msg, 0, 28);
                let n28b = read_bits(msg, 28, 28);
                let n5   = read_bits(msg, 66, 5);
                let irpt = 2 * n5 as i32 - 30;
                let crpt = if irpt >= 0 {
                    format!("+{:02}", irpt)
                } else {
                    format!("{:03}", irpt)
                };
                let c1 = unpack28(n28a);
                let c2 = unpack28(n28b);
                Some(format!("{} RR73; {} <...> {}", c1, c2, crpt))
            }
            3 | 4 => {
                // ARRL Field Day — show callsigns + tag
                let c1 = unpack28(read_bits(msg, 0, 28));
                let c2 = unpack28(read_bits(msg, 28, 28));
                Some(format!("{} {} [FD]", c1, c2))
            }
            _ => None,
        },

        // ── Type 1 / 2: standard or /P message ───────────────────────────
        1 | 2 => {
            // Format: b28 b1 b28 b1 b1 b15 b3
            let n28a  = read_bits(msg, 0, 28);
            let ipa   = msg[28] & 1;
            let n28b  = read_bits(msg, 29, 28);
            let ipb   = msg[57] & 1;
            let ir    = msg[58] & 1;
            let igrid = read_bits(msg, 59, 15);

            let mut c1 = unpack28(n28a);
            let mut c2 = unpack28(n28b);

            // Append /R or /P if the flag bit is set (but not for CQ-type tokens)
            if ipa == 1 && !c1.starts_with('<') && !c1.starts_with("CQ") {
                c1.push_str(if i3 == 1 { "/R" } else { "/P" });
            }
            if ipb == 1 && !c2.starts_with('<') {
                c2.push_str(if i3 == 1 { "/R" } else { "/P" });
            }

            let report = if igrid <= MAX_GRID4 {
                let grid = to_grid4(igrid)?;
                if ir == 0 { grid } else { format!("R {}", grid) }
            } else {
                let irpt = igrid - MAX_GRID4;
                match irpt {
                    1 => String::new(),
                    2 => "RRR".to_string(),
                    3 => "RR73".to_string(),
                    4 => "73".to_string(),
                    n => {
                        let mut isnr = n as i32 - 35;
                        if isnr > 50 { isnr -= 101; }
                        let sign = if isnr >= 0 { "+" } else { "" };
                        if ir == 1 {
                            format!("R{}{:02}", sign, isnr)
                        } else {
                            format!("{}{:02}", sign, isnr)
                        }
                    }
                }
            };

            if report.is_empty() {
                Some(format!("{} {}", c1, c2))
            } else {
                Some(format!("{} {} {}", c1, c2, report))
            }
        }

        // ── Type 3: ARRL RTTY Contest ─────────────────────────────────────
        3 => {
            // Format: b1 b28 b28 b1 b3 b13 b3
            let _itu  = msg[0] & 1;
            let n28a  = read_bits(msg, 1, 28);
            let n28b  = read_bits(msg, 29, 28);
            let c1 = unpack28(n28a);
            let c2 = unpack28(n28b);
            Some(format!("{} {} [RTTY]", c1, c2))
        }

        // ── Type 4: one non-standard call + 12-bit hash ───────────────────
        4 => {
            // Format: b12 b58 b1 b2 b1 (b3 = i3)
            let n58   = read_bits_u64(msg, 12, 58);
            let iflip = msg[70] & 1;
            let nrpt  = read_bits(msg, 71, 2);
            let icq   = msg[73] & 1;

            // Decode 11-char non-standard callsign from 58-bit base-38 number
            let mut n = n58;
            let mut buf = [b' '; 11];
            for i in (0..11).rev() {
                buf[i] = C38[(n % 38) as usize];
                n /= 38;
            }
            let nonstd = String::from_utf8(buf.to_vec())
                .unwrap_or_default()
                .trim()
                .to_string();

            if icq == 1 {
                return Some(format!("CQ {}", nonstd));
            }

            let (c1, c2) = if iflip == 0 {
                ("<...>".to_string(), nonstd)
            } else {
                (nonstd, "<...>".to_string())
            };

            match nrpt {
                0 => Some(format!("{} {}", c1, c2)),
                1 => Some(format!("{} {} RRR", c1, c2)),
                2 => Some(format!("{} {} RR73", c1, c2)),
                3 => Some(format!("{} {} 73", c1, c2)),
                _ => None,
            }
        }

        _ => None,
    }
}

// ── Callsign validation ─────────────────────────────────────────────────────

/// Check if a callsign matches the standard amateur radio format.
///
/// Based on WSJT-X `MainWindow::stdCall` regex:
/// ```text
/// (part1)(part2)(/R|/P)?
/// part1: [A-Z]{0,2} | [A-Z][0-9] | [0-9][A-Z]
/// part2: [0-9][A-Z]{0,3}
/// ```
///
/// Examples: JA1ABC, 3Y0Z, W1AW, VK2RG/P
pub fn is_standard_callsign(call: &str) -> bool {
    let call = call.trim();
    // Strip /R or /P suffix
    let base = if call.ends_with("/R") || call.ends_with("/P") {
        &call[..call.len() - 2]
    } else {
        call
    };

    let b = base.as_bytes();
    if b.is_empty() || b.len() > 6 { return false; }

    // Find the boundary: part2 starts with a digit followed by letters
    // Scan from right to find the digit that starts part2
    // part2 = [0-9][A-Z]{0,3}
    let mut split = None;
    for i in (0..b.len()).rev() {
        if b[i].is_ascii_digit() {
            // Check remaining chars after this digit are all A-Z
            if b[i + 1..].iter().all(|&c| c.is_ascii_uppercase()) {
                split = Some(i);
                break;
            }
        }
    }
    let split = match split { Some(s) => s, None => return false };

    let part1 = &b[..split];
    let part2 = &b[split..]; // [0-9][A-Z]{0,3}

    // Validate part2: digit + 0-3 uppercase letters
    if part2.is_empty() || !part2[0].is_ascii_digit() { return false; }
    if part2.len() > 4 { return false; }
    if !part2[1..].iter().all(|c| c.is_ascii_uppercase()) { return false; }

    // Validate part1: [A-Z]{0,2} | [A-Z][0-9] | [0-9][A-Z]
    match part1.len() {
        0 => true, // empty part1 is allowed
        1 => part1[0].is_ascii_uppercase() || part1[0].is_ascii_digit(),
        2 => {
            let (a, b) = (part1[0], part1[1]);
            (a.is_ascii_uppercase() && b.is_ascii_uppercase()) // [A-Z][A-Z]
            || (a.is_ascii_uppercase() && b.is_ascii_digit())  // [A-Z][0-9]
            || (a.is_ascii_digit() && b.is_ascii_uppercase())  // [0-9][A-Z]
        }
        _ => false,
    }
}

/// Check if a decoded FT8 message looks plausible (not a false positive).
///
/// Validates that callsign-like tokens in the message match standard format.
/// Special tokens (CQ, DE, QRZ, `<...>`, grid, report) are accepted.
pub fn is_plausible_message(text: &str) -> bool {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() { return false; }

    // Special message formats that are always OK
    if text.contains("[FD]") || text.contains("[RTTY]") || text.contains("RR73;") {
        // Contest/DXpedition types — trust the unpack
        return true;
    }

    // Check each token that looks like it should be a callsign
    for &w in words.iter() {
        // Skip known non-callsign tokens
        if matches!(w, "CQ" | "DE" | "QRZ" | "RRR" | "RR73" | "73"
            | "R" | "" | "DX") { continue; }
        if w.starts_with("CQ") { continue; } // "CQ NNN" patterns
        if w.starts_with('<') && w.ends_with('>') { continue; } // <...> hash
        if w.starts_with("R+") || w.starts_with("R-") { continue; } // R-report
        if w.starts_with('+') || w.starts_with('-') {
            // Check if numeric report like "-12" or "+05"
            if w[1..].parse::<i32>().is_ok() { continue; }
        }
        // 4-char grid locator (e.g., PM95)
        if w.len() == 4 {
            let b = w.as_bytes();
            if b[0].is_ascii_uppercase() && b[1].is_ascii_uppercase()
                && b[2].is_ascii_digit() && b[3].is_ascii_digit() {
                continue;
            }
        }

        // This token should be a callsign — validate it
        if !is_standard_callsign(w) {
            return false;
        }
    }
    true
}

// ── Packing (encode) ────────────────────────────────────────────────────────

/// Write `len` bits of `val` (MSB first) into `msg` starting at `start`.
fn write_bits(msg: &mut [u8; 77], start: usize, len: usize, val: u32) {
    for i in 0..len {
        msg[start + i] = ((val >> (len - 1 - i)) & 1) as u8;
    }
}

/// Pack a callsign into a 28-bit token (inverse of [`unpack28`]).
///
/// Supports `"DE"`, `"QRZ"`, `"CQ"`, and standard 1–6 character callsigns
/// whose 3rd character (1-indexed) is a digit (e.g. `"JQ1QSO"`, `"3Y0Z"`).
///
/// Returns `None` if the callsign contains characters outside the FT8 alphabet
/// or cannot be encoded in the standard 28-bit field.
pub fn pack28(call: &str) -> Option<u32> {
    let call = call.trim();
    match call {
        "DE"  => return Some(0),
        "QRZ" => return Some(1),
        "CQ"  => return Some(2),
        _ => {}
    }

    let bytes = call.as_bytes();
    if bytes.is_empty() || bytes.len() > 6 {
        return None;
    }

    // Pad to 6 characters: if position 3 (1-indexed) is not a digit, prepend space.
    let mut buf = [b' '; 6];
    if bytes.len() >= 3 && bytes[2].is_ascii_digit() {
        // Digit already at position 3 — left-align
        for (i, &b) in bytes.iter().enumerate().take(6) {
            buf[i] = b.to_ascii_uppercase();
        }
    } else if bytes.len() >= 2 && bytes[1].is_ascii_digit() {
        // Digit at position 2 — shift right by 1 so digit lands at position 3
        buf[0] = b' ';
        for (i, &b) in bytes.iter().enumerate() {
            if i + 1 < 6 { buf[i + 1] = b.to_ascii_uppercase(); }
        }
    } else {
        return None; // Cannot form a valid 6-char callsign
    }

    // Position 3 (index 2) must be a digit
    if !buf[2].is_ascii_digit() {
        return None;
    }

    let i1 = C1.iter().position(|&c| c == buf[0])?;
    let i2 = C2.iter().position(|&c| c == buf[1])?;
    let i3 = C3.iter().position(|&c| c == buf[2])?;
    let i4 = C4.iter().position(|&c| c == buf[3])?;
    let i5 = C4.iter().position(|&c| c == buf[4])?;
    let i6 = C4.iter().position(|&c| c == buf[5])?;

    let n = ((((i1 as u32 * 36 + i2 as u32) * 10 + i3 as u32) * 27
        + i4 as u32) * 27 + i5 as u32) * 27 + i6 as u32;
    Some(NTOKENS + MAX22 + n)
}

/// Pack a 4-character Maidenhead grid locator into a 15-bit index.
pub fn pack_grid4(grid: &str) -> Option<u32> {
    let g = grid.as_bytes();
    if g.len() != 4 { return None; }
    let j1 = g[0].to_ascii_uppercase().wrapping_sub(b'A') as u32;
    let j2 = g[1].to_ascii_uppercase().wrapping_sub(b'A') as u32;
    let j3 = g[2].wrapping_sub(b'0') as u32;
    let j4 = g[3].wrapping_sub(b'0') as u32;
    if j1 > 17 || j2 > 17 || j3 > 9 || j4 > 9 { return None; }
    Some(((j1 * 18 + j2) * 10 + j3) * 10 + j4)
}

/// Pack a Type 1 standard message: `"CALL1 CALL2 GRID"`.
///
/// Both callsigns must be packable via [`pack28`], and `grid` must be a valid
/// 4-character Maidenhead locator.  Returns the 77-bit message array.
pub fn pack77_type1(call1: &str, call2: &str, grid: &str) -> Option<[u8; 77]> {
    let n28a = pack28(call1)?;
    let n28b = pack28(call2)?;
    let igrid = pack_grid4(grid)?;

    let mut msg = [0u8; 77];
    write_bits(&mut msg, 0, 28, n28a);      // call1 (bits 0–27)
    // ipa = 0 (bit 28) — already zero
    write_bits(&mut msg, 29, 28, n28b);     // call2 (bits 29–56)
    // ipb = 0 (bit 57) — already zero
    // ir  = 0 (bit 58) — already zero
    write_bits(&mut msg, 59, 15, igrid);    // grid  (bits 59–73)
    write_bits(&mut msg, 74, 3, 1);         // i3=1  (bits 74–76)
    Some(msg)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Unpack a hex string (20 hex chars = 10 bytes) into a [u8; 77] bit array.
    fn hex_to_msg77(hex: &str) -> [u8; 77] {
        assert_eq!(hex.len(), 20, "need exactly 20 hex chars (10 bytes)");
        let bytes: Vec<u8> = (0..10)
            .map(|i| u8::from_str_radix(&hex[2*i..2*i+2], 16).unwrap())
            .collect();
        let mut msg = [0u8; 77];
        for (j, bit) in msg.iter_mut().enumerate() {
            *bit = (bytes[j / 8] >> (7 - j % 8)) & 1;
        }
        msg
    }

    #[test]
    fn decode_cq_r7iw_ln35() {
        // From 191111_110200.wav @ 1290.6 Hz (errors=1, BP)
        let msg = hex_to_msg77("0000002059654a94a3c8");
        let text = unpack77(&msg).expect("should decode");
        assert_eq!(text, "CQ R7IW LN35");
    }

    #[test]
    fn decode_cq_dx_r6wa_ln32() {
        // From 191111_110200.wav @ 2096.9 Hz (errors=0, BP)
        let msg = hex_to_msg77("000046f059519f14a308");
        let text = unpack77(&msg).expect("should decode");
        assert_eq!(text, "CQ DX R6WA LN32");
    }

    #[test]
    fn silence_bits_returns_none_or_empty() {
        let msg = [0u8; 77];
        // i3=0, n3=0 → free text, but all-zero = all-spaces → empty → None
        assert!(unpack77(&msg).is_none());
    }

    #[test]
    fn pack28_roundtrip() {
        // Standard callsigns
        for call in &["JQ1QSO", "3Y0Z", "R7IW", "JA1ABC", "W1AW", "VK2RG"] {
            let n = pack28(call).unwrap_or_else(|| panic!("pack28 failed for {call}"));
            let decoded = unpack28(n);
            assert_eq!(
                decoded, call.trim(),
                "roundtrip mismatch for {call}: got {decoded}"
            );
        }
        // Special tokens
        assert_eq!(pack28("CQ"), Some(2));
        assert_eq!(pack28("DE"), Some(0));
        assert_eq!(pack28("QRZ"), Some(1));
    }

    #[test]
    fn pack77_type1_roundtrip() {
        let msg = pack77_type1("CQ", "3Y0Z", "JD34").expect("pack failed");
        let text = unpack77(&msg).expect("unpack failed");
        assert_eq!(text, "CQ 3Y0Z JD34");

        let msg2 = pack77_type1("CQ", "JQ1QSO", "PM95").expect("pack failed");
        let text2 = unpack77(&msg2).expect("unpack failed");
        assert_eq!(text2, "CQ JQ1QSO PM95");
    }

    #[test]
    fn standard_callsign_valid() {
        assert!(is_standard_callsign("JA1ABC"));
        assert!(is_standard_callsign("3Y0Z"));
        assert!(is_standard_callsign("W1AW"));
        assert!(is_standard_callsign("VK2RG"));
        assert!(is_standard_callsign("R7IW"));
        assert!(is_standard_callsign("JQ1QSO"));
        assert!(is_standard_callsign("TA6CQ"));
        assert!(is_standard_callsign("JA1ABC/P"));
        assert!(is_standard_callsign("JM1VWQ/R"));
    }

    #[test]
    fn standard_callsign_invalid() {
        assert!(!is_standard_callsign("NFW/0811"));  // slash + digits, not /R or /P
        assert!(!is_standard_callsign("791JLI"));    // 79 is not a valid prefix
        assert!(!is_standard_callsign(""));
        assert!(!is_standard_callsign("ABCDEFG"));   // no digit, too long
        assert!(!is_standard_callsign("123"));       // all digits
    }

    #[test]
    fn standard_callsign_edge_cases() {
        // These are syntactically valid even if not real
        assert!(is_standard_callsign("SY2XHO"));    // SY prefix (Greece)
        assert!(is_standard_callsign("8I9NIH"));    // 8I prefix + 9NIH — valid format
    }

    #[test]
    fn plausible_message_check() {
        assert!(is_plausible_message("CQ JA1ABC PM95"));
        assert!(is_plausible_message("CQ DX R6WA LN32"));
        assert!(is_plausible_message("JA1ABC 3Y0Z -12"));
        assert!(is_plausible_message("JA1ABC 3Y0Z RRR"));
        assert!(is_plausible_message("JA1ABC 3Y0Z 73"));
        assert!(is_plausible_message("CQ 3Y0Z JD34"));
        assert!(is_plausible_message("OH3NIV ZS6S R-12"));

        // False positives from noise
        assert!(!is_plausible_message("NFW/0811 73"));
    }
}
