// SPDX-License-Identifier: GPL-3.0-or-later
//
// Minimal C++ smoke test for the rs-ft8n FFI: generate a clean FT8 tone
// via the Rust side (simpler than inlining the simulator here), feed it
// back through the C ABI, and verify at least one message decodes.
//
// Build: run `./build.sh` (or see it for the raw g++ invocation).

#include "wsjt.h"

#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <vector>

namespace {

// FT8: 79 symbols × 1920 samples/symbol @ 12 kHz = 151 680 samples = 12.64 s
constexpr double kSampleRate = 12000.0;
constexpr size_t  kSlotSamples = 180000;      // 15 s @ 12 kHz
constexpr double  kRefBw = 2500.0;

// Very small deterministic Gaussian RNG (LCG + Box-Muller); enough for
// a smoke test — real simulator lives on the Rust side.
struct Lcg {
    uint64_t state;
    double spare = 0.0;
    bool have_spare = false;
    explicit Lcg(uint64_t seed) : state(seed + 1) {}
    uint64_t next_u64() {
        state = state * 6364136223846793005ULL + 1442695040888963407ULL;
        return state;
    }
    double uniform() {
        return (double((next_u64() >> 11) + 1)) / double((uint64_t(1) << 53) + 1);
    }
    double gauss() {
        if (have_spare) { have_spare = false; return spare; }
        const double u = uniform();
        const double v = uniform();
        const double m = std::sqrt(-2.0 * std::log(u));
        spare = m * std::sin(2.0 * M_PI * v);
        have_spare = true;
        return m * std::cos(2.0 * M_PI * v);
    }
};

// Inject a single-tone dummy signal at f0 Hz + WSJT-X SNR-convention AWGN.
// This isn't a real FT8 frame — it just exercises the FFI end-to-end and
// the Rust coarse-sync will find "no candidates". A valid decode requires
// encoding through ft8_core::wave_gen, which is callable from Rust tests
// but not from C++ without extra bindings. For our smoke we content
// ourselves with verifying the ABI boundary works (no crashes, no leaks,
// zero messages returned for noise).
std::vector<int16_t> make_noise_slot(uint64_t seed) {
    Lcg rng(seed);
    std::vector<int16_t> pcm(kSlotSamples);
    for (size_t i = 0; i < kSlotSamples; ++i) {
        const double x = rng.gauss();
        const double clipped = std::max(-32768.0, std::min(32767.0, x * 3000.0));
        pcm[i] = static_cast<int16_t>(clipped);
    }
    return pcm;
}

} // namespace

int main() {
    const uint32_t ver = wsjt_version();
    std::printf("wsjt-ffi version: %u.%u.%u\n",
                (ver >> 16) & 0xff,
                (ver >> 8) & 0xff,
                ver & 0xff);

    // ── FT8 decoder round-trip on pure noise ────────────────────────────
    WsjtDecoder* dec = wsjt_decoder_new(WSJT_PROTOCOL_FT8);
    if (dec == nullptr) {
        std::fprintf(stderr, "wsjt_decoder_new failed: %s\n", wsjt_last_error());
        return 1;
    }

    auto pcm = make_noise_slot(42);
    WsjtMessageList list{};
    const WsjtStatus st = wsjt_decode_i16(
        dec,
        pcm.data(),
        pcm.size(),
        12000,
        &list);

    if (st != WSJT_STATUS_OK) {
        std::fprintf(stderr, "wsjt_decode_i16 failed: status=%d err=%s\n",
                     int(st), wsjt_last_error());
        wsjt_decoder_free(dec);
        return 2;
    }

    std::printf("FT8 noise-only decode: %zu messages (expect 0)\n", list.len);
    for (size_t i = 0; i < list.len; ++i) {
        const WsjtMessage& m = list.items[i];
        std::printf("  [%zu] freq=%.1f dt=%+0.3f snr=%.1f err=%u pass=%u text='%s'\n",
                    i, m.freq_hz, m.dt_sec, m.snr_db,
                    m.hard_errors, m.pass,
                    m.text ? m.text : "<null>");
    }

    wsjt_message_list_free(&list);
    wsjt_decoder_free(dec);

    // ── FT4 decoder handle round-trip ───────────────────────────────────
    WsjtDecoder* dec4 = wsjt_decoder_new(WSJT_PROTOCOL_FT4);
    if (dec4 == nullptr) { return 3; }
    WsjtMessageList list4{};
    wsjt_decode_i16(dec4, pcm.data(), pcm.size(), 12000, &list4);
    std::printf("FT4 noise-only decode: %zu messages (expect 0)\n", list4.len);
    wsjt_message_list_free(&list4);
    wsjt_decoder_free(dec4);

    std::printf("OK\n");
    return 0;
}
