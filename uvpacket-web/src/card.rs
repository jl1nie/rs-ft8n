// SPDX-License-Identifier: GPL-3.0-or-later
//! QSL / ADV JSON codec — bit-perfect compatible with pico_tnc.
//!
//! Build: emit a fixed-key-order JSON object so the produced bytes match
//! `qsl_build_json` (`pico_tnc/cmd.c:1737`) and `adv_build_json`
//! (`cmd.c:1758`) byte-for-byte. Empty fields are still emitted (never
//! omitted) since the C side uses unconditional `snprintf`.
//!
//! Parse: depth-1 key search for `"QSL"` or `"ADV"` (mirroring
//! `qsl_card_parse` in `pico_tnc/qsl_card.c`), then key/value walk inside
//! the object. Unknown keys go into `extensions`.

use alloc::string::String;
use alloc::vec::Vec;

extern crate alloc;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QslCard {
    pub fr: String,
    pub to: String,
    pub rs: String,
    pub date: String,
    pub time: String,
    pub freq: String,
    pub mode: String,
    pub qth: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AdvCard {
    pub fr: String,
    pub name: String,
    pub bio: String,
    pub address: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodedCard {
    Qsl(QslCard, Vec<(String, String)>),
    Adv(AdvCard, Vec<(String, String)>),
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    InvalidUtf8,
    InvalidJson,
    NoCard,
}

/// Build the QSL JSON in the canonical key order
/// (`FR → QSL{C,S,D,T,F,M,P}`). Output is bit-identical to
/// `pico_tnc/cmd.c::qsl_build_json` for the same inputs.
pub fn build_qsl_json(card: &QslCard) -> String {
    let mut out = String::with_capacity(192);
    out.push_str("{\"FR\":\"");
    push_escaped(&mut out, &card.fr);
    out.push_str("\",\"QSL\":{\"C\":\"");
    push_escaped(&mut out, &card.to);
    out.push_str("\",\"S\":\"");
    push_escaped(&mut out, &card.rs);
    out.push_str("\",\"D\":\"");
    push_escaped(&mut out, &card.date);
    out.push_str("\",\"T\":\"");
    push_escaped(&mut out, &card.time);
    out.push_str("\",\"F\":\"");
    push_escaped(&mut out, &card.freq);
    out.push_str("\",\"M\":\"");
    push_escaped(&mut out, &card.mode);
    out.push_str("\",\"P\":\"");
    push_escaped(&mut out, &card.qth);
    out.push_str("\"}}");
    out
}

/// Build the ADV JSON in the canonical key order
/// (`FR → ADV{N,B,A}`). Bit-identical to `pico_tnc/cmd.c::adv_build_json`.
pub fn build_adv_json(card: &AdvCard) -> String {
    let mut out = String::with_capacity(192);
    out.push_str("{\"FR\":\"");
    push_escaped(&mut out, &card.fr);
    out.push_str("\",\"ADV\":{\"N\":\"");
    push_escaped(&mut out, &card.name);
    out.push_str("\",\"B\":\"");
    push_escaped(&mut out, &card.bio);
    out.push_str("\",\"A\":\"");
    push_escaped(&mut out, &card.address);
    out.push_str("\"}}");
    out
}

/// pico_tnc `json_escape_message` — `"` `\` and control chars get
/// `\uXXXX`; printable ASCII passes through untouched. The C side
/// rejects bytes ≥ 0x80 (the snprintf-into-buffer path returns false);
/// we mirror that by emitting them as `\uXXXX` rather than UTF-8 raw,
/// so that signature-bytes are deterministic.
fn push_escaped(out: &mut String, s: &str) {
    for b in s.bytes() {
        match b {
            b'"' => out.push_str("\\\""),
            b'\\' => out.push_str("\\\\"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\t' => out.push_str("\\t"),
            0x20..=0x7E => out.push(b as char),
            _ => {
                use core::fmt::Write;
                let _ = write!(out, "\\u{:04x}", b as u32);
            }
        }
    }
}

// ───────────────────────── Parser ─────────────────────────

/// Parse a QSL or ADV JSON payload. The parser matches `qsl_card_parse`
/// semantics: it locates the first `"QSL":{...}` or `"ADV":{...}` object
/// at depth 1 and walks its key/value pairs. Top-level `"FR"` is also
/// extracted.
pub fn parse_card(json: &str) -> Result<DecodedCard, ParseError> {
    let bytes = json.as_bytes();
    let fr = top_level_string(bytes, b"FR").unwrap_or_default();

    if let Some(start) = find_object_at_depth1(bytes, b"QSL") {
        let (qsl, ext) = parse_qsl_body(bytes, start)?;
        let mut card = qsl;
        card.fr = fr;
        return Ok(DecodedCard::Qsl(card, ext));
    }
    if let Some(start) = find_object_at_depth1(bytes, b"ADV") {
        let (adv, ext) = parse_adv_body(bytes, start)?;
        let mut card = adv;
        card.fr = fr;
        return Ok(DecodedCard::Adv(card, ext));
    }
    Ok(DecodedCard::Unknown)
}

fn parse_qsl_body(bytes: &[u8], obj_start: usize) -> Result<(QslCard, Vec<(String, String)>), ParseError> {
    let mut card = QslCard::default();
    let mut ext = Vec::new();
    walk_object(bytes, obj_start, |k, v| match k {
        "C" => card.to = v.into(),
        "S" => card.rs = v.into(),
        "D" => card.date = v.into(),
        "T" => card.time = v.into(),
        "F" => card.freq = v.into(),
        "M" => card.mode = v.into(),
        "P" => card.qth = v.into(),
        _ => ext.push((k.into(), v.into())),
    })?;
    Ok((card, ext))
}

fn parse_adv_body(bytes: &[u8], obj_start: usize) -> Result<(AdvCard, Vec<(String, String)>), ParseError> {
    let mut card = AdvCard::default();
    let mut ext = Vec::new();
    walk_object(bytes, obj_start, |k, v| match k {
        "N" => card.name = v.into(),
        "B" => card.bio = v.into(),
        "A" => card.address = v.into(),
        _ => ext.push((k.into(), v.into())),
    })?;
    Ok((card, ext))
}

/// Find a `"<key>":{` object at depth 1 (i.e. directly inside the
/// outermost `{}`). Returns the byte index of the opening `{`.
fn find_object_at_depth1(bytes: &[u8], key: &[u8]) -> Option<usize> {
    let mut depth = 0usize;
    let mut in_str = false;
    let mut esc = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match c {
            b'"' => {
                if depth == 1 {
                    let key_start = i + 1;
                    let key_end = scan_string_end(bytes, key_start)?;
                    if &bytes[key_start..key_end] == key {
                        let mut j = key_end + 1;
                        j = skip_ws(bytes, j);
                        if j < bytes.len() && bytes[j] == b':' {
                            j = skip_ws(bytes, j + 1);
                            if j < bytes.len() && bytes[j] == b'{' {
                                return Some(j);
                            }
                        }
                        i = key_end + 1;
                        continue;
                    } else {
                        i = key_end + 1;
                        continue;
                    }
                }
                in_str = true;
                i += 1;
            }
            b'{' => {
                depth += 1;
                i += 1;
            }
            b'}' => {
                if depth > 0 {
                    depth -= 1;
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    None
}

/// Find a top-level (depth 1) `"<key>":"<string>"` and return the
/// unescaped string value.
fn top_level_string(bytes: &[u8], key: &[u8]) -> Option<String> {
    let mut depth = 0usize;
    let mut in_str = false;
    let mut esc = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match c {
            b'"' => {
                if depth == 1 {
                    let key_start = i + 1;
                    let key_end = scan_string_end(bytes, key_start)?;
                    if &bytes[key_start..key_end] == key {
                        let mut j = key_end + 1;
                        j = skip_ws(bytes, j);
                        if j < bytes.len() && bytes[j] == b':' {
                            j = skip_ws(bytes, j + 1);
                            if j < bytes.len() && bytes[j] == b'"' {
                                let v_start = j + 1;
                                let v_end = scan_string_end(bytes, v_start)?;
                                return Some(unescape(&bytes[v_start..v_end]));
                            }
                        }
                    }
                    i = key_end + 1;
                    continue;
                }
                in_str = true;
                i += 1;
            }
            b'{' => {
                depth += 1;
                i += 1;
            }
            b'}' => {
                if depth > 0 {
                    depth -= 1;
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    None
}

fn walk_object<F: FnMut(&str, &str)>(
    bytes: &[u8],
    obj_start: usize,
    mut visit: F,
) -> Result<(), ParseError> {
    let mut i = obj_start + 1;
    loop {
        i = skip_ws(bytes, i);
        if i >= bytes.len() {
            return Err(ParseError::InvalidJson);
        }
        if bytes[i] == b'}' {
            return Ok(());
        }
        if bytes[i] != b'"' {
            return Err(ParseError::InvalidJson);
        }
        let key_start = i + 1;
        let key_end = scan_string_end(bytes, key_start).ok_or(ParseError::InvalidJson)?;
        let key = unescape(&bytes[key_start..key_end]);

        i = skip_ws(bytes, key_end + 1);
        if i >= bytes.len() || bytes[i] != b':' {
            return Err(ParseError::InvalidJson);
        }
        i = skip_ws(bytes, i + 1);
        if i >= bytes.len() {
            return Err(ParseError::InvalidJson);
        }
        let val = if bytes[i] == b'"' {
            let v_start = i + 1;
            let v_end = scan_string_end(bytes, v_start).ok_or(ParseError::InvalidJson)?;
            i = v_end + 1;
            unescape(&bytes[v_start..v_end])
        } else {
            let v_end = scan_value_end(bytes, i);
            let v = core::str::from_utf8(&bytes[i..v_end])
                .map_err(|_| ParseError::InvalidUtf8)?;
            i = v_end;
            v.into()
        };

        visit(&key, &val);

        i = skip_ws(bytes, i);
        if i < bytes.len() && bytes[i] == b',' {
            i += 1;
        }
    }
}

fn scan_string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut i = start;
    let mut esc = false;
    while i < bytes.len() {
        let c = bytes[i];
        if esc {
            esc = false;
        } else if c == b'\\' {
            esc = true;
        } else if c == b'"' {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn scan_value_end(bytes: &[u8], start: usize) -> usize {
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut i = start;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                if depth == 0 {
                    return i;
                }
                depth -= 1;
            }
            b',' if depth == 0 => return i,
            _ => {}
        }
        i += 1;
    }
    i
}

fn skip_ws(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    i
}

fn unescape(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'\\' && i + 1 < bytes.len() {
            let n = bytes[i + 1];
            match n {
                b'"' => out.push('"'),
                b'\\' => out.push('\\'),
                b'/' => out.push('/'),
                b'n' => out.push('\n'),
                b'r' => out.push('\r'),
                b't' => out.push('\t'),
                b'u' if i + 5 < bytes.len() => {
                    if let Ok(s) = core::str::from_utf8(&bytes[i + 2..i + 6]) {
                        if let Ok(cp) = u32::from_str_radix(s, 16) {
                            if let Some(ch) = char::from_u32(cp) {
                                out.push(ch);
                            }
                        }
                    }
                    i += 6;
                    continue;
                }
                _ => out.push(n as char),
            }
            i += 2;
        } else {
            // Pass through valid UTF-8 bytes; replace invalid with U+FFFD.
            let start = i;
            while i < bytes.len() && bytes[i] != b'\\' {
                i += 1;
            }
            if let Ok(s) = core::str::from_utf8(&bytes[start..i]) {
                out.push_str(s);
            } else {
                out.push('\u{FFFD}');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference output captured from running pico_tnc cmd.c qsl_build_json
    /// in isolation with these inputs (verified manually against the
    /// `snprintf` template in pico_tnc/cmd.c:1737).
    #[test]
    fn build_qsl_matches_pico_tnc_template() {
        let card = QslCard {
            fr: "JL1NIE".into(),
            to: "JA1UMW".into(),
            rs: "59".into(),
            date: "2026-04-29".into(),
            time: "12:34".into(),
            freq: "430.090".into(),
            mode: "USB".into(),
            qth: "Tokyo".into(),
        };
        let json = build_qsl_json(&card);
        assert_eq!(
            json,
            "{\"FR\":\"JL1NIE\",\"QSL\":{\"C\":\"JA1UMW\",\"S\":\"59\",\"D\":\"2026-04-29\",\"T\":\"12:34\",\"F\":\"430.090\",\"M\":\"USB\",\"P\":\"Tokyo\"}}"
        );
    }

    #[test]
    fn build_adv_matches_pico_tnc_template() {
        let card = AdvCard {
            fr: "JL1NIE".into(),
            name: "Minoru".into(),
            bio: "uvpacket dev".into(),
            address: "MABC...".into(),
        };
        let json = build_adv_json(&card);
        assert_eq!(
            json,
            "{\"FR\":\"JL1NIE\",\"ADV\":{\"N\":\"Minoru\",\"B\":\"uvpacket dev\",\"A\":\"MABC...\"}}"
        );
    }

    #[test]
    fn parse_qsl_roundtrip() {
        let card = QslCard {
            fr: "JL1NIE".into(),
            to: "JA1UMW".into(),
            rs: "59".into(),
            date: "2026-04-29".into(),
            time: "12:34".into(),
            freq: "430.090".into(),
            mode: "USB".into(),
            qth: "Tokyo".into(),
        };
        let json = build_qsl_json(&card);
        let decoded = parse_card(&json).unwrap();
        match decoded {
            DecodedCard::Qsl(d, ext) => {
                assert_eq!(d, card);
                assert!(ext.is_empty());
            }
            _ => panic!("expected QSL"),
        }
    }

    #[test]
    fn parse_handles_quoted_specials() {
        let card = QslCard {
            fr: "JL1NIE".into(),
            to: "JA1UMW".into(),
            rs: "59".into(),
            date: "".into(),
            time: "".into(),
            freq: "".into(),
            mode: "".into(),
            qth: r#"He said "73""#.into(),
        };
        let json = build_qsl_json(&card);
        let decoded = parse_card(&json).unwrap();
        match decoded {
            DecodedCard::Qsl(d, _) => assert_eq!(d.qth, r#"He said "73""#),
            _ => panic!("expected QSL"),
        }
    }
}
