// SPDX-License-Identifier: GPL-3.0-or-later
//! uvpacket WASM bindings for the in-browser PWA.
//!
//! Application target: signed QSL card / ADV (advertisement) exchange,
//! wire-format compatible with `jl1nie/pico_tnc` (`pico_tnc/qsl_card.{c,h}`,
//! `pico_tnc/cmd.c::qsl_build_json`, `libmona_pico/INTEGRATION.md`).
//! The PHY swaps from AX.25 1200-baud AFSK to mfsk-core's uvpacket
//! (LDPC + interleaver + coherent QPSK on a narrow-FM or SSB channel),
//! while the application payload (`<JSON><88-char-base64-sig>`) stays
//! bit-identical so pico_tnc users can verify our packets via the
//! `sign recovery <payload>` TTY command.

pub mod card;
pub mod monacoin;
pub mod address;

mod wasm;
