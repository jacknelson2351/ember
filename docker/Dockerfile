ARG KALI_BASE_IMAGE
FROM ${KALI_BASE_IMAGE}

ARG PI_CODING_AGENT_VERSION

# Base tooling for the interactive workspace surfaced by the desktop app.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl wget git jq procps \
    python3 python3-pip python3-venv \
    nodejs npm \
    ripgrep dnsutils iputils-ping \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash ember \
    && mkdir -p /workspace /config /memory /home/ember/.pi/agent /home/ember/.npm-global \
    && chown -R ember:ember /workspace /config /memory /home/ember

ENV HOME=/home/ember \
    NPM_CONFIG_PREFIX=/home/ember/.npm-global \
    PATH=/home/ember/.npm-global/bin:$PATH

WORKDIR /workspace
USER ember

# Pin the CLI package so runtime behavior is reproducible across rebuilds.
RUN npm install -g @mariozechner/pi-coding-agent@${PI_CODING_AGENT_VERSION}

# Keep the runtime alive so the desktop app can exec into it on demand.
CMD ["tail", "-f", "/dev/null"]
