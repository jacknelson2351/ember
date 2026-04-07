FROM kalilinux/kali-rolling:latest

# Base tooling for the interactive workspace surfaced by the desktop app.
RUN apt-get update && apt-get install -y \
    bash ca-certificates curl wget git jq procps \
    python3 python3-pip python3-venv \
    nodejs npm \
    ripgrep dnsutils iputils-ping \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Install pi coding agent — the AI agent that powers the chat panel
# https://pi.dev  |  https://github.com/badlogic/pi-mono
RUN npm install -g @mariozechner/pi-coding-agent

# Keep the runtime alive so the desktop app can exec into it on demand.
CMD ["tail", "-f", "/dev/null"]
