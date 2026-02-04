# Zeus Gateway Container
# Control plane for AI daemon orchestration

FROM node:20-slim

# Install Docker CLI (for container management)
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy gateway code
COPY . .

# Environment variables
ENV NODE_ENV=production
ENV PORT=3001
ENV GATEWAY_MODE=container

# Expose gateway port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Labels
LABEL org.opencontainers.image.title="Zeus Gateway"
LABEL org.opencontainers.image.description="Control plane for AI daemon orchestration"
LABEL org.opencontainers.image.vendor="Zeus"

CMD ["node", "index.js"]
