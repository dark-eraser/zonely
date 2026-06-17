#!/usr/bin/env bash
# garmin-weekly-zones — installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/dark-eraser/garmin-weekly-zones/main/install.sh | bash

set -euo pipefail

REPO_URL="https://github.com/dark-eraser/garmin-weekly-zones.git"
INSTALL_DIR="${GARMIN_ZONES_HOME:-$HOME/.garmin-weekly-zones}"
LINK_DIR="${GARMIN_ZONES_LINK_DIR:-/usr/local/bin}"
LINK_PATH="$LINK_DIR/garmin-zones"

# ─── colors ──────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  R=$'\033[0m'; B=$'\033[1m'; GR=$'\033[90m'
  GN=$'\033[32m'; YL=$'\033[33m'; RD=$'\033[31m'; CY=$'\033[36m'
else
  R=""; B=""; GR=""; GN=""; YL=""; RD=""; CY=""
fi

say()  { printf "%s\n" "$*"; }
ok()   { printf "%s\n" "${GN}✓${R} $*"; }
warn() { printf "%s\n" "${YL}!${R} $*"; }
err()  { printf "%s\n" "${RD}✗${R} $*" >&2; }
hdr()  { printf "\n%s\n" "${B}${CY}$*${R}"; }

hdr "garmin-weekly-zones installer"
say "  install dir: ${GR}${INSTALL_DIR}${R}"
say "  link path:   ${GR}${LINK_PATH}${R}"

# ─── step 1: bun ─────────────────────────────────────────────────────────────
hdr "[1/4] Checking bun"
if command -v bun >/dev/null 2>&1; then
  ok "bun found: $(bun --version)"
else
  err "bun is not installed."
  say "    install it from: ${CY}https://bun.sh${R}"
  say "    quick install:   ${B}curl -fsSL https://bun.sh/install | bash${R}"
  say "    then restart your shell and re-run this installer."
  exit 1
fi

# ─── step 2: garmin-connect CLI ──────────────────────────────────────────────
hdr "[2/4] Checking garmin-connect CLI"
if command -v garmin-connect >/dev/null 2>&1; then
  ok "garmin-connect already installed"
else
  warn "garmin-connect not found — installing globally with bun"
  if bun add -g garmin-connect; then
    ok "garmin-connect installed"
  else
    err "Failed to install garmin-connect. Try:  ${B}bun add -g garmin-connect${R}"
    exit 1
  fi
fi

# ─── step 3: fetch repo ──────────────────────────────────────────────────────
hdr "[3/4] Fetching garmin-weekly-zones"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  ok "found existing install — pulling latest"
  git -C "$INSTALL_DIR" pull --ff-only
elif [[ -d "$INSTALL_DIR" ]]; then
  warn "${INSTALL_DIR} exists but is not a git repo — leaving it alone"
  say "    remove it manually and re-run the installer if you want a fresh checkout."
else
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
    ok "cloned to $INSTALL_DIR"
  else
    err "git is required to clone the repo but was not found."
    exit 1
  fi
fi

WRAPPER="$INSTALL_DIR/bin/garmin-zones"
if [[ ! -f "$WRAPPER" ]]; then
  err "wrapper missing: $WRAPPER"
  exit 1
fi
chmod +x "$WRAPPER"

# ─── step 4: symlink ─────────────────────────────────────────────────────────
hdr "[4/4] Linking $LINK_PATH"

ensure_link() {
  if [[ -L "$LINK_PATH" && "$(readlink "$LINK_PATH")" == "$WRAPPER" ]]; then
    ok "symlink already points at install"
    return 0
  fi
  if [[ -e "$LINK_PATH" ]]; then
    warn "$LINK_PATH already exists — backing up to ${LINK_PATH}.bak"
    mv "$LINK_PATH" "${LINK_PATH}.bak"
  fi
  ln -s "$WRAPPER" "$LINK_PATH"
  ok "symlinked $LINK_PATH -> $WRAPPER"
}

if [[ -w "$LINK_DIR" ]]; then
  ensure_link
else
  warn "$LINK_DIR is not writable — retrying with sudo"
  if sudo bash -c "$(declare -f ensure_link); LINK_PATH='$LINK_PATH' WRAPPER='$WRAPPER' ensure_link"; then
    :
  else
    err "Could not symlink. Run manually:"
    say "    ${B}sudo ln -s '$WRAPPER' '$LINK_PATH'${R}"
    exit 1
  fi
fi

# ─── next steps ──────────────────────────────────────────────────────────────
hdr "Installed!"
say ""
say "  Next steps:"
say "    ${B}1.${R} Login to Garmin Connect:  ${CY}garmin-connect auth login${R}"
say "    ${B}2.${R} Configure your weekly plan: ${CY}garmin-zones setup${R}"
say "    ${B}3.${R} Run it:                    ${CY}garmin-zones${R}"
say ""
say "  Other commands:"
say "    ${GR}garmin-zones --help${R}              show usage"
say "    ${GR}garmin-zones --no-daily${R}          skip daily HR fetch"
say "    ${GR}garmin-zones --week 2026-06-08${R}   view a specific week"
say "    ${GR}garmin-zones setup --reset${R}       reconfigure the plan"
say ""
