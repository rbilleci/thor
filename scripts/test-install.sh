#!/bin/sh
# Offline tests for the POSIX bootstrap. They replace curl/uname/checksum tools
# in a private temporary PATH; no network request or real installation occurs.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/thor-bootstrap-test.XXXXXX")
cleanup() { rm -rf "$temporary_directory"; }
trap cleanup EXIT HUP INT TERM

fake_bin="$temporary_directory/bin"
mkdir "$fake_bin"
real_sha256sum=$(command -v sha256sum)

write_fake_tools() {
    printf '%s\n' '#!/bin/sh' \
        'case "$1" in -s) printf "%s\n" "$TEST_OS" ;; -m) printf "%s\n" "$TEST_ARCH" ;; esac' \
        > "$fake_bin/uname"
    chmod 755 "$fake_bin/uname"
    printf '%s\n' '#!/bin/sh' \
        'output=' \
        'url=' \
        'while [ "$#" -gt 0 ]; do' \
        '  case "$1" in --output) output=$2; shift 2 ;; *) url=$1; shift ;; esac' \
        'done' \
        'printf "%s\n" "$url" >> "$TEST_LOG"' \
        'case "$url" in' \
        '  */SHA256SUMS) printf "%s  %s\n" "${TEST_CHECKSUM:-$TEST_HASH}" "$TEST_ASSET" > "$output" ;;' \
        '  *) printf "%s" "$TEST_CONTENT" > "$output" ;;' \
        'esac' \
        > "$fake_bin/curl"
    chmod 755 "$fake_bin/curl"
    printf '%s\n' '#!/bin/sh' \
        'exec "$REAL_SHA256SUM" "$@"' \
        > "$fake_bin/sha256sum"
    chmod 755 "$fake_bin/sha256sum"
}

assert_contains() {
    case "$1" in *"$2"*) ;; *) printf 'expected %s to contain %s\n' "$1" "$2" >&2; exit 1 ;; esac
}

write_fake_tools
export REAL_SHA256SUM="$real_sha256sum"
export TEST_CONTENT='thor-test-binary'
export TEST_HASH=$(printf '%s' "$TEST_CONTENT" | "$real_sha256sum" | awk '{ print $1 }')

# Linux x64 chooses the expected pinned-release URL and honors THOR_BIN_DIR.
export TEST_OS=Linux TEST_ARCH=x86_64 TEST_ASSET=thor-linux-amd64
export TEST_LOG="$temporary_directory/linux.log"
PATH="$fake_bin:$PATH" THOR_BIN_DIR="$temporary_directory/linux-bin" THOR_VERSION=v1.2.3 THOR_REPOSITORY=acme/thor \
    sh "$root/scripts/install.sh"
test -x "$temporary_directory/linux-bin/thor"
assert_contains "$(cat "$TEST_LOG")" '/releases/download/v1.2.3/thor-linux-amd64'

# macOS ARM64 resolves a different release asset.
export TEST_OS=Darwin TEST_ARCH=arm64 TEST_ASSET=thor-darwin-arm64
export TEST_LOG="$temporary_directory/darwin.log"
PATH="$fake_bin:$PATH" THOR_BIN_DIR="$temporary_directory/darwin-bin" THOR_VERSION=v1.2.3 THOR_REPOSITORY=acme/thor \
    sh "$root/scripts/install.sh"
test -x "$temporary_directory/darwin-bin/thor"
assert_contains "$(cat "$TEST_LOG")" '/releases/download/v1.2.3/thor-darwin-arm64'

# A bad checksum cannot install a binary.
export TEST_OS=Linux TEST_ARCH=x86_64 TEST_ASSET=thor-linux-amd64 TEST_CHECKSUM=0000
export TEST_LOG="$temporary_directory/bad-checksum.log"
if PATH="$fake_bin:$PATH" THOR_BIN_DIR="$temporary_directory/bad-bin" THOR_VERSION=v1.2.3 THOR_REPOSITORY=acme/thor \
    sh "$root/scripts/install.sh"; then
    printf '%s\n' 'checksum mismatch unexpectedly succeeded' >&2
    exit 1
fi
test ! -e "$temporary_directory/bad-bin/thor"
unset TEST_CHECKSUM

# Unsupported platforms fail before downloading anything.
export TEST_OS=FreeBSD TEST_ARCH=x86_64 TEST_ASSET=thor-linux-amd64
if PATH="$fake_bin:$PATH" THOR_BIN_DIR="$temporary_directory/unsupported-bin" THOR_VERSION=v1.2.3 THOR_REPOSITORY=acme/thor \
    sh "$root/scripts/install.sh"; then
    printf '%s\n' 'unsupported platform unexpectedly succeeded' >&2
    exit 1
fi
test ! -e "$temporary_directory/unsupported-bin/thor"

printf '%s\n' 'POSIX bootstrap tests passed'
