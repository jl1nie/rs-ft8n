//! WSPR 50-bit message codec.
//!
//! Ports `lib/wsprd/wsprd_utils.c` (unpack) and `lib/wsprd/wsprsim_utils.c`
//! (pack) from WSJT-X. The 50-bit payload carries one of three message
//! types:
//!
//! | Type | Contents                       | n1 (28 bit) | n2 (22 bit) |
//! |------|--------------------------------|-------------|-------------|
//! | 1    | 6-char callsign + grid4 + dBm  | packed call | grid+power  |
//! | 2    | prefix/suffix callsign + dBm   | packed call | prefix+type |
//! | 3    | hashed call + grid6 + dBm      | packed grid6| hash+type   |
//!
//! Type discrimination happens on the decode side: `ntype = (n2 & 127) - 64`.
//! Valid "power-in-dBm" values (0, 3, 7, 10, …, 60) mark Type 1; other
//! positive ntype is Type 2; negative ntype is Type 3.
//!
//! Currently Type 1 and Type 3 are implemented end-to-end. Type 2 is
//! detected but reported as a placeholder — the prefix/suffix unpack
//! logic can be ported verbatim when a test corpus materialises.
//!
//! The decoded representation is a `WsprMessage` enum so callers can
//! distinguish the types; the convenience `to_string()` impl yields the
//! familiar `"CALL GRID DBM"` tuple layout that WSPRnet expects.

use core::fmt;

const POWERS: &[i32] = &[
    0, 3, 7, 10, 13, 17, 20, 23, 27, 30, 33, 37, 40, 43, 47, 50, 53, 57, 60,
];

/// Decoded WSPR message payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WsprMessage {
    /// Standard Type-1 message: 6-char callsign, 4-char grid, transmit power.
    Type1 {
        callsign: String,
        grid: String,
        power_dbm: i32,
    },
    /// Type-2 prefix/suffix callsign (e.g. `PJ4/K1ABC 37`).
    /// Currently returned with the callsign-portion packed-number as a
    /// placeholder hex string; full unpack is a follow-up.
    Type2 {
        callsign_packed: u32,
        suffix_or_prefix_packed: u32,
        power_dbm: i32,
    },
    /// Type-3 hashed callsign + 6-char grid.
    Type3 {
        /// Callsign hash (unresolved — needs external hash table to recover).
        callsign_hash: u32,
        grid: String,
        power_dbm: i32,
    },
}

impl fmt::Display for WsprMessage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WsprMessage::Type1 {
                callsign,
                grid,
                power_dbm,
            } => write!(f, "{} {} {}", callsign, grid, power_dbm),
            WsprMessage::Type2 { power_dbm, .. } => {
                write!(f, "<type2-callsign> {} dBm", power_dbm)
            }
            WsprMessage::Type3 {
                callsign_hash,
                grid,
                power_dbm,
            } => write!(f, "<hash:{:05x}> {} {}", callsign_hash, grid, power_dbm),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Character tables
// ─────────────────────────────────────────────────────────────────────────

/// 37-entry table used by callsign/grid unpacking — digits, uppercase
/// letters, and space. Matches `c[]` in `wsprd_utils.c::unpackcall`.
const CHAR37: &[u8; 37] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ ";

fn callsign_char_code(ch: u8) -> Option<u8> {
    match ch {
        b'0'..=b'9' => Some(ch - b'0'),
        b'A'..=b'Z' => Some(ch - b'A' + 10),
        b' ' => Some(36),
        _ => None,
    }
}

fn locator_char_code(ch: u8) -> Option<u8> {
    match ch {
        b'0'..=b'9' => Some(ch - b'0'),
        b'A'..=b'R' => Some(ch - b'A'),
        b' ' => Some(36),
        _ => None,
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Pack / unpack 50 bits ↔ (n1, n2)
// ─────────────────────────────────────────────────────────────────────────

/// Pack (n1, n2) into 50 bits laid out across 7 bytes + 1 bit.
/// Byte layout matches `wsprsim_utils.c`:
/// ```text
/// data[0]=n1[27..20]  data[1]=n1[19..12]  data[2]=n1[11..4]
/// data[3]=n1[3..0]<<4 | n2[21..18]
/// data[4]=n2[17..10]  data[5]=n2[9..2]    data[6]=n2[1..0]<<6
/// ```
pub fn pack50(n1: u32, n2: u32) -> [u8; 7] {
    [
        ((n1 >> 20) & 0xff) as u8,
        ((n1 >> 12) & 0xff) as u8,
        ((n1 >> 4) & 0xff) as u8,
        (((n1 & 0x0f) << 4) | ((n2 >> 18) & 0x0f)) as u8,
        ((n2 >> 10) & 0xff) as u8,
        ((n2 >> 2) & 0xff) as u8,
        (((n2 & 0x03) << 6) & 0xff) as u8,
    ]
}

/// Inverse of [`pack50`]: 7-byte packed word → (n1, n2).
/// Tolerates the 7th byte carrying only the top 2 bits.
pub fn unpack50(data: &[u8; 7]) -> (u32, u32) {
    let mut n1: u32 = (data[0] as u32) << 20;
    n1 |= (data[1] as u32) << 12;
    n1 |= (data[2] as u32) << 4;
    n1 |= ((data[3] >> 4) & 0x0f) as u32;

    let mut n2: u32 = ((data[3] & 0x0f) as u32) << 18;
    n2 |= (data[4] as u32) << 10;
    n2 |= (data[5] as u32) << 2;
    n2 |= ((data[6] >> 6) & 0x03) as u32;

    (n1, n2)
}

// ─────────────────────────────────────────────────────────────────────────
// Callsign + grid packing (Type 1)
// ─────────────────────────────────────────────────────────────────────────

/// Encode a callsign into a 28-bit integer. Returns `None` if the callsign
/// doesn't fit the compressed form (must be ≤ 6 chars with a digit in
/// position 1 or 2, and only A-Z / 0-9 / space).
pub fn pack_call(callsign: &str) -> Option<u32> {
    let bytes = callsign.as_bytes();
    if bytes.len() > 6 || bytes.is_empty() {
        return None;
    }
    let mut call6 = [b' '; 6];
    // Right-align to the 3rd slot: if char[2] is a digit keep as-is,
    // else if char[1] is a digit shift one position right.
    if bytes.len() >= 3 && bytes[2].is_ascii_digit() {
        for (i, &b) in bytes.iter().enumerate() {
            call6[i] = b;
        }
    } else if bytes.len() >= 2 && bytes[1].is_ascii_digit() {
        for (i, &b) in bytes.iter().enumerate() {
            call6[i + 1] = b;
        }
    } else {
        return None;
    }

    let codes: [u8; 6] = {
        let mut c = [0u8; 6];
        for i in 0..6 {
            c[i] = callsign_char_code(call6[i])?;
        }
        c
    };

    // n = c0*36 + c1 ...       (first two slots: 37-symbol alphabet)
    // then digit (c2, 0-9), then three letter/space (c3..c5, 27 symbols).
    let mut n: u32 = codes[0] as u32;
    n = n * 36 + codes[1] as u32;
    n = n * 10 + codes[2] as u32;
    n = n * 27 + (codes[3].wrapping_sub(10)) as u32;
    n = n * 27 + (codes[4].wrapping_sub(10)) as u32;
    n = n * 27 + (codes[5].wrapping_sub(10)) as u32;
    Some(n)
}

/// Unpack a 28-bit callsign integer. Returns `None` for the "reserved"
/// range (≥ 262_177_560) that WSJT-X treats as non-Type-1.
pub fn unpack_call(ncall: u32) -> Option<String> {
    if ncall >= 262_177_560 {
        return None;
    }
    let mut n = ncall;
    let mut tmp = [b' '; 6];
    // Reverse of pack_call: pull digits/letters out LSB-first.
    let i = (n % 27 + 10) as usize;
    tmp[5] = CHAR37[i];
    n /= 27;
    let i = (n % 27 + 10) as usize;
    tmp[4] = CHAR37[i];
    n /= 27;
    let i = (n % 27 + 10) as usize;
    tmp[3] = CHAR37[i];
    n /= 27;
    let i = (n % 10) as usize;
    tmp[2] = CHAR37[i];
    n /= 10;
    let i = (n % 36) as usize;
    tmp[1] = CHAR37[i];
    n /= 36;
    tmp[0] = CHAR37[n as usize];

    let s = core::str::from_utf8(&tmp).ok()?;
    Some(s.trim().to_string())
}

/// Pack a 4-char grid and transmit power into a 22-bit integer.
pub fn pack_grid4_power(grid: &str, power_dbm: i32) -> Option<u32> {
    let bytes = grid.as_bytes();
    if bytes.len() != 4 {
        return None;
    }
    let g0 = locator_char_code(bytes[0])? as u32;
    let g1 = locator_char_code(bytes[1])? as u32;
    let g2 = locator_char_code(bytes[2])? as u32;
    let g3 = locator_char_code(bytes[3])? as u32;
    let m = (179 - 10 * g0 - g2) * 180 + 10 * g1 + g3;
    Some(m * 128 + (power_dbm as u32) + 64)
}

/// Unpack the 22-bit grid+power integer. Returns `(grid, ntype)` where
/// `ntype = (n2 & 127) - 64` — the caller decides whether `ntype` names a
/// Type 1 dBm value, a Type 2 suffix count, or a Type 3 negative tag.
pub fn unpack_grid(ngrid_full: u32) -> Option<(String, i32)> {
    let ntype = (ngrid_full & 127) as i32 - 64;
    let ngrid = ngrid_full >> 7;
    if ngrid >= 32_400 {
        return None;
    }
    let dlat = (ngrid % 180) as i32 - 90;
    let mut dlong = (ngrid / 180) as i32 * 2 - 180 + 2;
    if dlong < -180 {
        dlong += 360;
    }
    if dlong > 180 {
        dlong += 360;
    }
    let nlong = (60.0 * (180.0 - dlong as f32) / 5.0) as i32;
    let ln1 = nlong / 240;
    let ln2 = (nlong - 240 * ln1) / 24;

    let nlat = (60.0 * (dlat + 90) as f32 / 2.5) as i32;
    let la1 = nlat / 240;
    let la2 = (nlat - 240 * la1) / 24;

    let mut grid = [b'0'; 4];
    grid[0] = CHAR37[(10 + ln1) as usize];
    grid[2] = CHAR37[ln2 as usize];
    grid[1] = CHAR37[(10 + la1) as usize];
    grid[3] = CHAR37[la2 as usize];
    Some((
        core::str::from_utf8(&grid).ok()?.to_string(),
        ntype,
    ))
}

// ─────────────────────────────────────────────────────────────────────────
// Public encode / decode entry points
// ─────────────────────────────────────────────────────────────────────────

/// Pack a Type-1 WSPR message (callsign + 4-char grid + power in dBm) into
/// 50 bits, stored MSB-first across a 50-element `[u8; 50]` of 0/1 values —
/// the form required by [`mfsk_fec::ConvFano::encode`].
pub fn pack_type1(callsign: &str, grid: &str, power_dbm: i32) -> Option<[u8; 50]> {
    if !POWERS.contains(&power_dbm) {
        return None;
    }
    let n1 = pack_call(callsign)?;
    let n2 = pack_grid4_power(grid, power_dbm)?;
    let bytes = pack50(n1, n2);
    let mut bits = [0u8; 50];
    for i in 0..50 {
        let byte = bytes[i / 8];
        bits[i] = (byte >> (7 - (i % 8))) & 1;
    }
    Some(bits)
}

/// Unpack 50 info bits into a [`WsprMessage`]. Returns `None` for
/// pathological ntype/ngrid combinations.
pub fn unpack(bits: &[u8; 50]) -> Option<WsprMessage> {
    // Pack bit vector back into the 7-byte word format unpack50 expects.
    let mut data = [0u8; 7];
    for i in 0..50 {
        if bits[i] & 1 != 0 {
            data[i / 8] |= 1 << (7 - (i % 8));
        }
    }
    let (n1, n2) = unpack50(&data);

    let (maybe_grid, ntype) = unpack_grid(n2).unzip();

    // Type 3: negative ntype → hashed callsign + grid6.
    if ntype.is_some_and(|t| t < 0) {
        let power_dbm = -(ntype.unwrap() + 1);
        // In Type 3, n1 was pack_call(grid6) — the callsign unpacker will
        // return a string that looks like a callsign but is actually the
        // rotated 6-char grid. We expose the raw packed hash in `n2 >> 7`.
        let hash = n2 >> 7;
        let grid = maybe_grid.unwrap_or_else(|| "XXXX".into());
        return Some(WsprMessage::Type3 {
            callsign_hash: hash,
            grid,
            power_dbm,
        });
    }

    let ntype_val = ntype?;
    let grid = maybe_grid?;

    // Type 1 test: nu = ntype % 10 ∈ {0,3,7} AND ntype ≤ 60.
    if (0..=62).contains(&ntype_val) {
        let nu = ntype_val % 10;
        if nu == 0 || nu == 3 || nu == 7 {
            let callsign = unpack_call(n1)?;
            return Some(WsprMessage::Type1 {
                callsign,
                grid,
                power_dbm: ntype_val,
            });
        }
    }

    // Otherwise Type 2 (prefix/suffix + power). Expose the packed fields
    // for now — full unpack deferred.
    Some(WsprMessage::Type2 {
        callsign_packed: n1,
        suffix_or_prefix_packed: n2 >> 7,
        power_dbm: ntype_val,
    })
}

// ─────────────────────────────────────────────────────────────────────────
// MessageCodec trait impl
// ─────────────────────────────────────────────────────────────────────────

use mfsk_core::{DecodeContext, MessageCodec, MessageFields};

#[derive(Copy, Clone, Debug, Default)]
pub struct Wspr50Message;

impl MessageCodec for Wspr50Message {
    type Unpacked = WsprMessage;
    const PAYLOAD_BITS: u32 = 50;
    const CRC_BITS: u32 = 0;

    fn pack(&self, fields: &MessageFields) -> Option<Vec<u8>> {
        let call = fields.call1.as_deref()?;
        let grid = fields.grid.as_deref()?;
        let power = fields.report?; // re-using MessageFields.report for dBm
        let bits = pack_type1(call, grid, power)?;
        Some(bits.to_vec())
    }

    fn unpack(&self, payload: &[u8], _ctx: &DecodeContext) -> Option<Self::Unpacked> {
        if payload.len() != 50 {
            return None;
        }
        let mut buf = [0u8; 50];
        buf.copy_from_slice(payload);
        unpack(&buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type1_roundtrip_callsign() {
        let bits = pack_type1("K1ABC", "FN42", 37).expect("pack");
        let m = unpack(&bits).expect("unpack");
        assert_eq!(
            m,
            WsprMessage::Type1 {
                callsign: "K1ABC".into(),
                grid: "FN42".into(),
                power_dbm: 37,
            }
        );
    }

    #[test]
    fn type1_roundtrip_with_digit_in_second_slot() {
        // Callsigns with digit at position 1 (e.g. "K9AN") shift into the
        // "right-aligned" form, which is a known WSJT-X pack-call path.
        let bits = pack_type1("K9AN", "EN50", 33).expect("pack");
        let m = unpack(&bits).expect("unpack");
        match m {
            WsprMessage::Type1 { callsign, grid, power_dbm } => {
                assert_eq!(callsign, "K9AN");
                assert_eq!(grid, "EN50");
                assert_eq!(power_dbm, 33);
            }
            other => panic!("expected Type 1, got {:?}", other),
        }
    }

    #[test]
    fn invalid_power_rejected() {
        assert!(pack_type1("K1ABC", "FN42", 42).is_none());
    }

    #[test]
    fn invalid_grid_rejected() {
        // Grid chars beyond 'R' are out of WSJT's locator alphabet.
        assert!(pack_type1("K1ABC", "SS01", 37).is_none());
    }

    #[test]
    fn unpack_rejects_reserved_call_range() {
        // n1 values ≥ 262177560 have no Type-1 interpretation; when ntype
        // looks like a Type 1 dBm we bail out to None.
        let bits = {
            let mut b = [0u8; 50];
            // Set n1 = all ones = 0x0fff_ffff (28-bit) → well into reserved.
            let n1 = 0x0fff_ffffu32;
            let n2 = pack_grid4_power("FN42", 37).unwrap();
            let bytes = pack50(n1, n2);
            for i in 0..50 {
                b[i] = (bytes[i / 8] >> (7 - (i % 8))) & 1;
            }
            b
        };
        // Should not produce Type 1 — either None or Type 2/3.
        match unpack(&bits) {
            Some(WsprMessage::Type1 { .. }) => panic!("shouldn't be Type 1"),
            _ => {} // Type 2/3 or None is fine
        }
    }

    #[test]
    fn pack50_unpack50_all_bits() {
        let n1 = 0x0deadb3u32;
        let n2 = 0x001abcdu32 & 0x003f_ffff;
        let bytes = pack50(n1, n2);
        let (rn1, rn2) = unpack50(&bytes);
        assert_eq!(rn1, n1);
        assert_eq!(rn2, n2);
    }
}
