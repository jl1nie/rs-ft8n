// SPDX-License-Identifier: GPL-3.0-or-later
//
// End-to-end C++ driver for the rs-ft8n FFI — encodes a known test
// message for every supported protocol, feeds the synthesised PCM
// back through the matching decoder handle, and verifies the decoded
// text round-trips correctly. Doubles as smoke test for the ABI
// (NULL handling, last-error, samples / message-list lifetimes) and
// as proof that each protocol is actually wired up in the C ABI.
//
// Build: run `./build.sh`.

#include "wsjt.h"

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

// Tally of failed sub-tests — reported at the end so one broken
// protocol doesn't hide the status of the others.
int g_failures = 0;

void fail(const char* proto, const char* detail) {
    std::fprintf(stderr, "  FAIL [%s] %s\n", proto, detail);
    g_failures++;
}

// Helper: does any decoded message text contain `needle` (case-sensitive)?
bool any_contains(const WsjtMessageList& list, const char* needle) {
    for (size_t i = 0; i < list.len; ++i) {
        const WsjtMessage& m = list.items[i];
        if (m.text && std::strstr(m.text, needle) != nullptr) {
            return true;
        }
    }
    return false;
}

void print_decodes(const char* proto, const WsjtMessageList& list) {
    std::printf("  [%s] %zu decode(s):\n", proto, list.len);
    for (size_t i = 0; i < list.len; ++i) {
        const WsjtMessage& m = list.items[i];
        std::printf("    freq=%7.2f dt=%+.3f snr=%+.1f err=%u pass=%u text='%s'\n",
                    m.freq_hz, m.dt_sec, m.snr_db,
                    m.hard_errors, m.pass,
                    m.text ? m.text : "<null>");
    }
}

// ── FT8 ──────────────────────────────────────────────────────────────
void test_ft8() {
    std::printf("— FT8 roundtrip: encode 'CQ JA1ABC PM95' at 1500 Hz → decode\n");
    WsjtSamples pcm{};
    if (wsjt_encode_ft8("CQ", "JA1ABC", "PM95", 1500.0f, &pcm) != WSJT_STATUS_OK) {
        fail("FT8", wsjt_last_error());
        return;
    }
    WsjtDecoder* dec = wsjt_decoder_new(WSJT_PROTOCOL_FT8);
    WsjtMessageList list{};
    const WsjtStatus st = wsjt_decode_f32(dec, pcm.samples, pcm.len, 12000, &list);
    if (st != WSJT_STATUS_OK) {
        fail("FT8", wsjt_last_error() ? wsjt_last_error() : "decode_f32 failed");
    } else {
        print_decodes("FT8", list);
        if (!any_contains(list, "JA1ABC") || !any_contains(list, "PM95")) {
            fail("FT8", "expected callsign / grid not recovered");
        }
    }
    wsjt_message_list_free(&list);
    wsjt_decoder_free(dec);
    wsjt_samples_free(&pcm);
}

// ── FT4 ──────────────────────────────────────────────────────────────
void test_ft4() {
    std::printf("— FT4 roundtrip: encode 'CQ JA1ABC PM95' at 1500 Hz → decode\n");
    WsjtSamples pcm{};
    if (wsjt_encode_ft4("CQ", "JA1ABC", "PM95", 1500.0f, &pcm) != WSJT_STATUS_OK) {
        fail("FT4", wsjt_last_error());
        return;
    }
    WsjtDecoder* dec = wsjt_decoder_new(WSJT_PROTOCOL_FT4);
    WsjtMessageList list{};
    const WsjtStatus st = wsjt_decode_f32(dec, pcm.samples, pcm.len, 12000, &list);
    if (st != WSJT_STATUS_OK) {
        fail("FT4", wsjt_last_error() ? wsjt_last_error() : "decode_f32 failed");
    } else {
        print_decodes("FT4", list);
        if (!any_contains(list, "JA1ABC") || !any_contains(list, "PM95")) {
            fail("FT4", "expected callsign / grid not recovered");
        }
    }
    wsjt_message_list_free(&list);
    wsjt_decoder_free(dec);
    wsjt_samples_free(&pcm);
}

// ── WSPR ─────────────────────────────────────────────────────────────
void test_wspr() {
    std::printf("— WSPR roundtrip: encode 'K1ABC FN42 37' at 1500 Hz → decode\n");
    WsjtSamples pcm{};
    if (wsjt_encode_wspr("K1ABC", "FN42", 37, 1500.0f, &pcm) != WSJT_STATUS_OK) {
        fail("WSPR", wsjt_last_error());
        return;
    }
    WsjtDecoder* dec = wsjt_decoder_new(WSJT_PROTOCOL_WSPR);
    WsjtMessageList list{};
    const WsjtStatus st = wsjt_decode_f32(dec, pcm.samples, pcm.len, 12000, &list);
    if (st != WSJT_STATUS_OK) {
        fail("WSPR", wsjt_last_error() ? wsjt_last_error() : "decode_f32 failed");
    } else {
        print_decodes("WSPR", list);
        if (!any_contains(list, "K1ABC") || !any_contains(list, "FN42")) {
            fail("WSPR", "expected callsign / grid not recovered");
        }
    }
    wsjt_message_list_free(&list);
    wsjt_decoder_free(dec);
    wsjt_samples_free(&pcm);
}

// ── JT9 ──────────────────────────────────────────────────────────────
void test_jt9() {
    std::printf("— JT9 roundtrip: encode 'CQ K1ABC FN42' at 1500 Hz → decode\n");
    WsjtSamples pcm{};
    if (wsjt_encode_jt9("CQ", "K1ABC", "FN42", 1500.0f, &pcm) != WSJT_STATUS_OK) {
        fail("JT9", wsjt_last_error());
        return;
    }
    WsjtDecoder* dec = wsjt_decoder_new(WSJT_PROTOCOL_JT9);
    WsjtMessageList list{};
    const WsjtStatus st = wsjt_decode_f32(dec, pcm.samples, pcm.len, 12000, &list);
    if (st != WSJT_STATUS_OK) {
        fail("JT9", wsjt_last_error() ? wsjt_last_error() : "decode_f32 failed");
    } else {
        print_decodes("JT9", list);
        if (!any_contains(list, "K1ABC") || !any_contains(list, "FN42")) {
            fail("JT9", "expected callsign / grid not recovered");
        }
    }
    wsjt_message_list_free(&list);
    wsjt_decoder_free(dec);
    wsjt_samples_free(&pcm);
}

// ── FST4-60A ─────────────────────────────────────────────────────────
// Gated behind the RUN_FST4_ROUNDTRIP environment variable because the
// 60-s slot + outer 786 432-pt FFT makes this multi-second and not
// every developer wants to wait on it every build.
void test_fst4() {
    if (!std::getenv("RUN_FST4_ROUNDTRIP")) {
        std::printf("— FST4-60A roundtrip: skipped (set RUN_FST4_ROUNDTRIP=1)\n");
        return;
    }
    std::printf("— FST4-60A roundtrip: encode 'CQ JA1ABC PM95' at 1500 Hz → decode\n");
    WsjtSamples pcm{};
    if (wsjt_encode_fst4s60("CQ", "JA1ABC", "PM95", 1500.0f, &pcm) != WSJT_STATUS_OK) {
        fail("FST4", wsjt_last_error());
        return;
    }
    // Pad up to a full 60-s slot with 1 s of leading silence so the
    // outer FFT has the window decode_frame expects.
    constexpr size_t kSlot = 60 * 12000;
    std::vector<float> slot(kSlot, 0.0f);
    const size_t offset = 12000;
    const size_t copy_len = std::min(pcm.len, kSlot - offset);
    std::memcpy(slot.data() + offset, pcm.samples, copy_len * sizeof(float));

    WsjtDecoder* dec = wsjt_decoder_new(WSJT_PROTOCOL_FST4S60);
    WsjtMessageList list{};
    const WsjtStatus st = wsjt_decode_f32(dec, slot.data(), slot.size(), 12000, &list);
    if (st != WSJT_STATUS_OK) {
        fail("FST4", wsjt_last_error() ? wsjt_last_error() : "decode_f32 failed");
    } else {
        print_decodes("FST4", list);
        if (!any_contains(list, "JA1ABC") || !any_contains(list, "PM95")) {
            fail("FST4", "expected callsign / grid not recovered");
        }
    }
    wsjt_message_list_free(&list);
    wsjt_decoder_free(dec);
    wsjt_samples_free(&pcm);
}

// ── JT65 ─────────────────────────────────────────────────────────────
void test_jt65() {
    std::printf("— JT65 roundtrip: encode 'CQ K1ABC FN42' at 1270 Hz → decode\n");
    WsjtSamples pcm{};
    if (wsjt_encode_jt65("CQ", "K1ABC", "FN42", 1270.0f, &pcm) != WSJT_STATUS_OK) {
        fail("JT65", wsjt_last_error());
        return;
    }
    WsjtDecoder* dec = wsjt_decoder_new(WSJT_PROTOCOL_JT65);
    WsjtMessageList list{};
    const WsjtStatus st = wsjt_decode_f32(dec, pcm.samples, pcm.len, 12000, &list);
    if (st != WSJT_STATUS_OK) {
        fail("JT65", wsjt_last_error() ? wsjt_last_error() : "decode_f32 failed");
    } else {
        print_decodes("JT65", list);
        if (!any_contains(list, "K1ABC") || !any_contains(list, "FN42")) {
            fail("JT65", "expected callsign / grid not recovered");
        }
    }
    wsjt_message_list_free(&list);
    wsjt_decoder_free(dec);
    wsjt_samples_free(&pcm);
}

// ── Negative paths ──────────────────────────────────────────────────
void test_null_handling() {
    std::printf("— NULL / invalid-arg handling\n");
    // NULL decoder
    WsjtMessageList list{};
    WsjtStatus st = wsjt_decode_f32(nullptr, nullptr, 0, 12000, &list);
    if (st != WSJT_STATUS_INVALID_ARG) {
        fail("null", "expected INVALID_ARG for null decoder");
    }
    // Free NULL pointers — must not crash.
    wsjt_decoder_free(nullptr);
    wsjt_message_list_free(nullptr);
    wsjt_samples_free(nullptr);
    // Unknown callsign at encode time → InvalidArg + meaningful error.
    WsjtSamples bogus{};
    st = wsjt_encode_ft8("XXX", "Y2Z", "FN42", 1500.0f, &bogus);
    if (st == WSJT_STATUS_OK) {
        fail("null", "expected pack77 failure for bogus callsigns");
        wsjt_samples_free(&bogus);
    }
}

} // namespace

int main() {
    const uint32_t ver = wsjt_version();
    std::printf("wsjt-ffi version: %u.%u.%u\n",
                (ver >> 16) & 0xff,
                (ver >> 8) & 0xff,
                ver & 0xff);

    test_ft8();
    test_ft4();
    test_fst4();
    test_wspr();
    test_jt9();
    test_jt65();
    test_null_handling();

    if (g_failures == 0) {
        std::printf("\nALL OK\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d FAILURE(S)\n", g_failures);
    return 1;
}
