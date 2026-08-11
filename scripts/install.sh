#!/bin/sh
# Bootstrap a published Thor binary. This script intentionally never downloads
# source packs or executes repository code.
set -eu

repository=${THOR_REPOSITORY:-acme/thor}
version=${THOR_VERSION:-}
bin_dir=${THOR_BIN_DIR:-"$HOME/.local/bin"}

usage() {
    printf '%s\n' 'usage: install.sh [--version vX.Y.Z] [--repository owner/repo] [--bin-dir PATH]'
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --version) version=$2; shift 2 ;;
        --repository) repository=$2; shift 2 ;;
        --bin-dir) bin_dir=$2; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
done

case "$(uname -s)" in
    Darwin) operating_system=darwin ;;
    Linux) operating_system=linux ;;
    *) printf 'unsupported operating system: %s\n' "$(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
    x86_64|amd64) architecture=amd64 ;;
    arm64|aarch64) architecture=arm64 ;;
    *) printf 'unsupported architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac

asset="thor-${operating_system}-${architecture}"
if [ -n "$version" ]; then
    release="https://github.com/${repository}/releases/download/${version}"
else
    release="https://github.com/${repository}/releases/latest/download"
fi

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/thor-install.XXXXXX")
cleanup() { rm -rf "$temporary_directory"; }
trap cleanup EXIT HUP INT TERM

curl --fail --location --silent --show-error "$release/$asset" --output "$temporary_directory/$asset"
curl --fail --location --silent --show-error "$release/SHA256SUMS" --output "$temporary_directory/SHA256SUMS"

expected=$(awk -v file="$asset" '$2 == file || $2 == "*" file { print $1; exit }' "$temporary_directory/SHA256SUMS")
if [ -z "$expected" ]; then
    printf 'SHA256SUMS does not contain %s\n' "$asset" >&2
    exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$temporary_directory/$asset" | awk '{ print $1 }')
else
    actual=$(shasum -a 256 "$temporary_directory/$asset" | awk '{ print $1 }')
fi
if [ "$expected" != "$actual" ]; then
    printf 'checksum verification failed for %s\n' "$asset" >&2
    exit 1
fi

mkdir -p "$bin_dir"
mv "$temporary_directory/$asset" "$bin_dir/thor"
chmod 755 "$bin_dir/thor"
printf 'installed Thor to %s\n' "$bin_dir/thor"
