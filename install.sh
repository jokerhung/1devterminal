#!/bin/bash
set -e

# 9Remote Installation Script for Linux/macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/jokerhung/1devterminal/master/install.sh | bash

COLOR_RESET="\033[0m"
COLOR_GREEN="\033[0;32m"
COLOR_BLUE="\033[0;34m"
COLOR_RED="\033[0;31m"
COLOR_YELLOW="\033[0;33m"

print_info() {
    echo -e "${COLOR_BLUE}ℹ ${1}${COLOR_RESET}"
}

print_success() {
    echo -e "${COLOR_GREEN}✓ ${1}${COLOR_RESET}"
}

print_error() {
    echo -e "${COLOR_RED}✗ ${1}${COLOR_RESET}"
}

print_warning() {
    echo -e "${COLOR_YELLOW}⚠ ${1}${COLOR_RESET}"
}

check_command() {
    if command -v "$1" &> /dev/null; then
        return 0
    else
        return 1
    fi
}

install_node() {
    print_info "Node.js not found. Installing Node.js..."

    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        if check_command brew; then
            brew install node
        else
            print_error "Homebrew not found. Please install Homebrew first: https://brew.sh"
            exit 1
        fi
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux
        if check_command apt-get; then
            # Debian/Ubuntu
            curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
            sudo apt-get install -y nodejs
        elif check_command yum; then
            # CentOS/RHEL
            curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
            sudo yum install -y nodejs
        elif check_command dnf; then
            # Fedora
            curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
            sudo dnf install -y nodejs
        elif check_command pacman; then
            # Arch Linux
            sudo pacman -S --noconfirm nodejs npm
        else
            print_error "Unsupported package manager. Please install Node.js manually: https://nodejs.org"
            exit 1
        fi
    else
        print_error "Unsupported operating system"
        exit 1
    fi

    print_success "Node.js installed successfully"
}

install_git() {
    print_info "Git not found. Installing Git..."

    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        if check_command brew; then
            brew install git
        else
            xcode-select --install
        fi
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux
        if check_command apt-get; then
            sudo apt-get update && sudo apt-get install -y git
        elif check_command yum; then
            sudo yum install -y git
        elif check_command dnf; then
            sudo dnf install -y git
        elif check_command pacman; then
            sudo pacman -S --noconfirm git
        fi
    fi

    print_success "Git installed successfully"
}

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║                                                        ║"
echo "║              9Remote Installation Script              ║"
echo "║                                                        ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# Check and install prerequisites
print_info "Checking prerequisites..."

if ! check_command node; then
    install_node
else
    NODE_VERSION=$(node -v)
    print_success "Node.js is already installed: $NODE_VERSION"
fi

if ! check_command git; then
    install_git
else
    GIT_VERSION=$(git --version)
    print_success "Git is already installed: $GIT_VERSION"
fi

# Set installation directory
INSTALL_DIR="$HOME/1terminal"

# Check if directory exists
if [ -d "$INSTALL_DIR" ]; then
    print_warning "Directory $INSTALL_DIR already exists."
    echo ""

    # Check if running interactively (has TTY)
    if [ -t 0 ]; then
        echo "1. Remove old directory and reinstall (fresh start)"
        echo "2. Update to latest version (keeps local files)"
        echo "3. Cancel"
        echo ""
        read -p "Choose option (1/2/3): " choice
    else
        # Non-interactive mode (piped from curl): auto-update
        print_info "Non-interactive mode detected. Auto-updating to latest version..."
        choice="2"
    fi

    case $choice in
        1)
            print_info "Removing existing installation..."
            rm -rf "$INSTALL_DIR"
            print_info "Cloning 9Remote repository..."
            git clone https://github.com/jokerhung/1devterminal.git "$INSTALL_DIR"
            cd "$INSTALL_DIR"
            print_success "Repository cloned successfully"
            ;;
        2)
            print_info "Updating to latest version..."
            cd "$INSTALL_DIR"
            git fetch origin master
            git reset --hard origin/master
            print_success "Updated to latest version"
            ;;
        *)
            print_error "Installation cancelled"
            exit 1
            ;;
    esac
else
    print_info "Cloning 9Remote repository..."
    git clone https://github.com/jokerhung/1devterminal.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    print_success "Repository cloned successfully"
fi

# Install dependencies
print_info "Installing dependencies... (this may take a few minutes)"
npm install
print_success "Dependencies installed successfully"

# Build host package
print_info "Building host package..."
npm run host:build
print_success "Host package built successfully"

# Create systemd service (Linux only)
if [[ "$OSTYPE" == "linux-gnu"* ]] && check_command systemctl; then
    print_info "Would you like to create a systemd service? (recommended for auto-start)"
    read -p "(y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        SERVICE_FILE="$HOME/.config/systemd/user/9remote.service"
        mkdir -p "$HOME/.config/systemd/user"

        cat > "$SERVICE_FILE" << EOF
[Unit]
Description=9Remote Development Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) $INSTALL_DIR/host/index.js ui
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

        systemctl --user daemon-reload
        systemctl --user enable 9remote.service
        print_success "Systemd service created and enabled"
    fi
fi

# Get local IP
LOCAL_IP=""
if [[ "$OSTYPE" == "darwin"* ]]; then
    LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "localhost")
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    LOCAL_IP=$(hostname -I | awk '{print $1}' || echo "localhost")
fi

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║                                                        ║"
echo "║           ✓ Installation completed successfully       ║"
echo "║                                                        ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
print_success "9Remote is now installed at: $INSTALL_DIR"
echo ""

print_info "Starting 9Remote server to initialize permanent key..."
cd "$INSTALL_DIR"
npm run host:dev:server > /dev/null 2>&1 &
SERVER_PID=$!

# Wait for server to be ready (check health endpoint)
print_info "Waiting for server to be ready..."
for i in {1..30}; do
    if curl -s http://localhost:2208/api/health > /dev/null 2>&1; then
        print_success "Server is ready"
        break
    fi
    sleep 1
    if [ $i -eq 30 ]; then
        print_warning "Server health check timeout"
        kill $SERVER_PID 2>/dev/null
        wait $SERVER_PID 2>/dev/null
        print_error "Failed to start server for key generation"
        exit 1
    fi
done

if ! kill -0 $SERVER_PID 2>/dev/null; then
    print_error "Server process died unexpectedly"
    exit 1
fi

print_info "Generating permanent API key..."
sleep 2

# The key is auto-generated on first server start, just verify it exists
if [ -f "$HOME/.9remote/keys.json" ]; then
    KEY_VALUE=$(grep -o '"sk-[^"]*"' "$HOME/.9remote/keys.json" | head -1 | tr -d '"')
    if [ -n "$KEY_VALUE" ]; then
        print_success "Permanent key generated: $KEY_VALUE"
    else
        print_warning "Key file exists but could not extract key value"
    fi
else
    print_warning "Key file not found at ~/.9remote/keys.json"
fi

kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
sleep 1
print_success "Server stopped"

echo ""
print_info "To start the server manually, run:"
echo -e "  ${COLOR_GREEN}cd $INSTALL_DIR${COLOR_RESET}"
echo -e "  ${COLOR_GREEN}npm run dev:local${COLOR_RESET}"
echo ""
print_info "Access the web interface at:"
echo -e "  ${COLOR_GREEN}http://localhost:2208/workspace${COLOR_RESET}"
if [ "$LOCAL_IP" != "localhost" ]; then
    echo -e "  ${COLOR_GREEN}http://$LOCAL_IP:2208/workspace${COLOR_RESET} (LAN access)"
fi
echo ""
print_info "For remote access, use Cloudflare Tunnel:"
echo -e "  ${COLOR_GREEN}cloudflared tunnel --url http://localhost:2208${COLOR_RESET}"
echo ""

# Ask if user wants to start now
read -p "Would you like to start 9Remote now? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    print_info "Starting 9Remote in new terminal..."
    if [[ "$OSTYPE" == "linux-gnu"* ]] && check_command systemctl && systemctl --user is-enabled 9remote.service &>/dev/null; then
        systemctl --user start 9remote.service
        print_success "9Remote service started"
        print_info "Check status: systemctl --user status 9remote"
        sleep 8
        if check_command xdg-open; then
            xdg-open "http://localhost:2208/workspace" 2>/dev/null
        fi
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        osascript -e "tell application \"Terminal\" to do script \"cd '$INSTALL_DIR' && npm run dev:local\"" 2>/dev/null
        sleep 8
        open "http://localhost:2208/workspace" 2>/dev/null
    else
        print_info "Starting in current terminal..."
        npm run dev:local
    fi
fi
