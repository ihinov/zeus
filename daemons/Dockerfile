# Zeus Daemon Container
# Runs AI CLI daemons with isolated workspace

FROM node:20-slim

# Install common utilities
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (for Copilot)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI (npm global)
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user for security (Claude CLI refuses --dangerously-skip-permissions as root)
RUN groupadd -r zeus && useradd -r -g zeus -d /home/zeus -m zeus

# Create workspace directory structure
RUN mkdir -p /workspace/prompts /workspace/sessions /workspace/data \
    && chown -R zeus:zeus /workspace

# Create config directories for all providers' credentials
RUN mkdir -p /home/zeus/.claude /home/zeus/.gemini /home/zeus/.config/gh \
    && chown -R zeus:zeus /home/zeus

# Set working directory
WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy daemon code
COPY . .

# Change ownership of app directory to zeus user
RUN chown -R zeus:zeus /app

# Environment variables
ENV NODE_ENV=production
ENV WORKSPACE=/workspace
ENV PORT=3456

# Expose WebSocket port (internal - host port mapped at runtime)
EXPOSE 3456

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Labels
LABEL org.opencontainers.image.title="Zeus Daemon"
LABEL org.opencontainers.image.description="AI CLI daemon with WebSocket interface"
LABEL org.opencontainers.image.vendor="Zeus"

# Switch to non-root user
USER zeus

# Default command (provider and port passed at runtime)
CMD ["node", "daemon.js", "claude", "3456"]
