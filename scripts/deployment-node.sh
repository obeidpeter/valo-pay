#!/usr/bin/env bash
# Deployment-only Node pin. Never downloads during production startup.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(cat "$root/.node-version")"
case "$version:$(uname -s):$(uname -m)" in
  24.21.0:Linux:x86_64)
    archive_sha=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
    binary_sha=7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c
    ;;
  *) echo "Unsupported deployment Node pin or platform; no fallback permitted." >&2; exit 1 ;;
esac
archive="node-v${version}-linux-x64"
runtime="$root/.deployment-runtime/$archive"
mode="${1:-}"
case "$mode" in
  build|run) shift ;;
  *) echo "Usage: bash scripts/deployment-node.sh build|run COMMAND [ARG...]" >&2; exit 1 ;;
esac
if [[ ! -d "$runtime" ]]; then
  if [[ "$mode" != build ]]; then
    echo "Verified Node runtime missing from deployment; rebuild before starting." >&2
    exit 1
  fi
  mkdir -p "$root/.deployment-runtime"
  staging="$(mktemp -d "$root/.deployment-runtime/install.XXXXXXXX")"
  trap 'rm -rf "$staging"' EXIT
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
    --connect-timeout 15 --max-time 180 --retry 2 \
    "https://nodejs.org/dist/v${version}/${archive}.tar.xz" -o "$staging/node.tar.xz"
  printf '%s  %s\n' "$archive_sha" "$staging/node.tar.xz" | sha256sum --check --status
  tar -xJf "$staging/node.tar.xz" -C "$staging"
  printf '%s  %s\n' "$binary_sha" "$staging/$archive/bin/node" | sha256sum --check --status
  # Artifact builds may run in parallel. Publish an immutable, complete directory;
  # an already-installed winner is verified below, never merged or overwritten.
  mv -T -n "$staging/$archive" "$runtime"
fi
if ! printf '%s  %s\n' "$binary_sha" "$runtime/bin/node" | sha256sum --check --status; then
  echo "Deployment Node executable missing or checksum mismatch; rebuild before starting." >&2
  exit 1
fi
export PATH="$runtime/bin:$PATH"
actual="$("$runtime/bin/node" --version)"
[[ "$actual" == "v$version" ]] || { echo "Deployment Node version mismatch." >&2; exit 1; }
echo "deployment-node: mode=$mode version=$actual executable=$runtime/bin/node" >&2
[[ $# -gt 0 ]] || { echo "Missing deployment command." >&2; exit 1; }
if [[ -n "${staging:-}" ]]; then
  rm -rf "$staging"
  trap - EXIT
fi
exec "$@"