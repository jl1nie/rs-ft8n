//! # mfsk-fec
//!
//! Forward-error-correction codecs shared across WSJT-family protocols.
//!
//! Each codec implements [`mfsk_core::FecCodec`] so generic pipeline code can
//! treat it uniformly. Protocol crates pick the codec via the
//! `type Fec = …;` associated type on [`mfsk_core::Protocol`].
//!
//! ## Contents
//!
//! | Family                 | Module       | Shared by                       |
//! |------------------------|--------------|---------------------------------|
//! | LDPC (174, 91) + CRC-14 | [`ldpc`]     | FT8, FT4, FT2, FST4             |
//! | (future) RS (63, 12)   | `rs`         | JT65                            |
//! | (future) Conv. + Fano  | `conv`       | JT9, WSPR                       |

pub mod ldpc;

pub use ldpc::Ldpc174_91;
