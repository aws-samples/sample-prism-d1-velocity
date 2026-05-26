#!/usr/bin/env bash
# PRISM CLI - Entry point
# Usage: ./prism <command> [subcommand] [options]
# Examples:
#   ./prism assessment run
#   ./prism workshop verify-setup

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load nvm if available (handles cases where nvm is installed but not in the current shell)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi

REQUIRED_NODE_MAJOR=20

install_node_via_nvm() {
  # Install nvm if not present
  if ! command -v nvm &> /dev/null; then
    echo "nvm is not installed. Installing nvm..."
    NVM_INSTALL_SCRIPT=$(mktemp)
    curl -fsSL -o "$NVM_INSTALL_SCRIPT" https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh
    bash "$NVM_INSTALL_SCRIPT"
    rm -f "$NVM_INSTALL_SCRIPT"
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
  fi

  echo "Installing Node.js v${REQUIRED_NODE_MAJOR} via nvm..."
  nvm install "$REQUIRED_NODE_MAJOR"
  nvm use "$REQUIRED_NODE_MAJOR"
}

# Check Node.js is available
if ! command -v node &> /dev/null; then
  echo "Node.js is not installed or not in PATH."
  read -rp "Would you like to install Node.js v${REQUIRED_NODE_MAJOR} via nvm? [Y/n] " answer
  answer="${answer:-Y}"
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    install_node_via_nvm
  else
    echo "Aborted. Install Node.js >= ${REQUIRED_NODE_MAJOR} manually and re-run."
    exit 1
  fi
fi

# Check minimum Node version
NODE_MAJOR=$(node --version | grep -oE '[0-9]+' | head -1)
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  echo "Node.js >= ${REQUIRED_NODE_MAJOR} required (found $(node --version))."
  read -rp "Would you like to install Node.js v${REQUIRED_NODE_MAJOR} via nvm? [Y/n] " answer
  answer="${answer:-Y}"
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    install_node_via_nvm
  else
    echo "Aborted. Upgrade Node.js manually and re-run."
    exit 1
  fi
fi

# Install or update dependencies if needed
PRISM_CLI_DIR="$SCRIPT_DIR/cli"
if [ ! -d "$PRISM_CLI_DIR/node_modules" ] || [ "$PRISM_CLI_DIR/package.json" -nt "$PRISM_CLI_DIR/node_modules/.package-lock.json" ]; then
  echo "Installing prism-cli dependencies..."
  (cd "$PRISM_CLI_DIR" && npm install --silent)
fi

# Build if dist is missing or source is newer
if [ ! -d "$PRISM_CLI_DIR/dist" ] || [ "$(find "$PRISM_CLI_DIR/src" "$PRISM_CLI_DIR/bin" -name '*.ts' -newer "$PRISM_CLI_DIR/dist" 2>/dev/null | head -1)" ]; then
  echo "Building prism-cli..."
  (cd "$PRISM_CLI_DIR" && npx tsc)
fi

exec node "$PRISM_CLI_DIR/dist/bin/prism-cli.js" "$@"
