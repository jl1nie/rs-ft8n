#!/usr/bin/env bash
# Build + run the C++ smoke test for wsjt-ffi.
set -euo pipefail

cd "$(dirname "$0")"
REPO_ROOT="$(cd ../../.. && pwd)"
WSJT_TARGET="$REPO_ROOT/target/release"

cargo build -p wsjt-ffi --release

g++ -std=c++17 \
    -I"$REPO_ROOT/wsjt-ffi/include" \
    main.cpp \
    -L"$WSJT_TARGET" -lwsjt \
    -pthread -ldl -lm \
    -Wl,-rpath,"$WSJT_TARGET" \
    -O2 -Wall -Wextra \
    -o cpp_smoke

./cpp_smoke
