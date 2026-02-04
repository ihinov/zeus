/**
 * ContainerManager - Docker container management for AI daemons
 *
 * Manages daemon containers: spawning, stopping, health checks, port allocation.
 * Each daemon runs in its own isolated container with workspace.
 */

import { spawn, execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Port range for dynamic allocation
const PORT_RANGE_START = 4000;
const PORT_RANGE_END = 4100;

// Docker image name
const DAEMON_IMAGE = process.env.DAEMON_IMAGE || 'zeus-daemon';

export class ContainerManager extends EventEmitter {
  constructor(options = {}) {
    super();

    // Container registry: containerId -> ContainerInfo
    this.containers = new Map();

    // Port allocation: port -> containerId
    this.allocatedPorts = new Map();

    // Provider configs
    this.providerConfigs = {
      gemini: {
        defaultPort: 3456,
        healthEndpoint: '/health',
        env: { GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.0-flash' },
      },
      claude: {
        defaultPort: 3456,
        healthEndpoint: '/health',
        env: { CLAUDE_MODEL: process.env.CLAUDE_MODEL || 'sonnet' },
      },
      copilot: {
        defaultPort: 3456,
        healthEndpoint: '/health',
        env: { COPILOT_MODEL: process.env.COPILOT_MODEL || 'gpt-4o' },
      },
    };

    // Health check interval
    this.healthCheckInterval = options.healthCheckInterval || 30000;
    this.healthCheckTimer = null;

    // Path to daemons directory (for building image)
    this.daemonsDir = path.join(__dirname, '..', 'daemons');

    // Workspace base directory (host path for volume mounts)
    this.workspaceBase = options.workspaceBase || path.join(process.env.HOME, '.zeus', 'containers');
  }

  // ============ DOCKER HELPERS ============

  /**
   * Check if Docker is available
   */
  async checkDocker() {
    try {
      execSync('docker version', { stdio: 'pipe' });
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Check if daemon image exists
   */
  async imageExists() {
    try {
      execSync(`docker image inspect ${DAEMON_IMAGE}`, { stdio: 'pipe' });
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Build the daemon Docker image
   */
  async buildImage() {
    console.log(`[ContainerManager] Building image: ${DAEMON_IMAGE}...`);

    return new Promise((resolve, reject) => {
      const proc = spawn('docker', ['build', '-t', DAEMON_IMAGE, '.'], {
        cwd: this.daemonsDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      proc.stdout.on('data', (data) => {
        output += data.toString();
        if (process.env.DEBUG === 'true') {
          console.log('[Docker]', data.toString().trim());
        }
      });

      proc.stderr.on('data', (data) => {
        output += data.toString();
        if (process.env.DEBUG === 'true') {
          console.error('[Docker]', data.toString().trim());
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          console.log(`[ContainerManager] Image built successfully`);
          resolve(true);
        } else {
          reject(new Error(`Docker build failed with code ${code}: ${output}`));
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * Ensure image is available (build if needed)
   */
  async ensureImage() {
    if (!(await this.imageExists())) {
      await this.buildImage();
    }
  }

  // ============ PORT MANAGEMENT ============

  /**
   * Check if a port is available on the system
   */
  isPortAvailable(port) {
    try {
      // Check if port is in use by any process
      const result = execSync(`ss -tlnp 2>/dev/null | grep ':${port} ' || true`, { encoding: 'utf-8' });
      return result.trim() === '';
    } catch {
      // If ss fails, try netstat
      try {
        const result = execSync(`netstat -tlnp 2>/dev/null | grep ':${port} ' || true`, { encoding: 'utf-8' });
        return result.trim() === '';
      } catch {
        // Can't check, assume available
        return true;
      }
    }
  }

  /**
   * Allocate a free port, checking both our registry and system availability
   */
  allocatePort() {
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      if (!this.allocatedPorts.has(port) && this.isPortAvailable(port)) {
        return port;
      }
    }
    throw new Error('No available ports in range');
  }

  releasePort(port) {
    this.allocatedPorts.delete(port);
  }

  /**
   * Clean up orphaned Zeus containers from previous runs
   */
  async cleanupOrphanedContainers() {
    try {
      // Find all zeus containers (running or stopped)
      const containers = execSync('docker ps -a --filter "name=zeus-" --format "{{.Names}}"', { encoding: 'utf-8' })
        .trim()
        .split('\n')
        .filter(Boolean);

      if (containers.length === 0) {
        return;
      }

      console.log(`[ContainerManager] Found ${containers.length} orphaned Zeus containers, cleaning up...`);

      for (const name of containers) {
        try {
          // Stop if running
          execSync(`docker stop ${name} 2>/dev/null || true`, { stdio: 'pipe' });
          // Remove
          execSync(`docker rm ${name} 2>/dev/null || true`, { stdio: 'pipe' });
          console.log(`[ContainerManager] Removed orphaned container: ${name}`);
        } catch (err) {
          console.error(`[ContainerManager] Failed to remove ${name}:`, err.message);
        }
      }
    } catch (err) {
      // No containers or docker not available
      if (process.env.DEBUG === 'true') {
        console.log('[ContainerManager] No orphaned containers found');
      }
    }
  }

  // ============ CONTAINER LIFECYCLE ============

  /**
   * Spawn a new daemon container
   */
  async spawn(provider, options = {}) {
    const config = this.providerConfigs[provider];
    if (!config) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    // Ensure image exists
    await this.ensureImage();

    // Allocate port
    const hostPort = options.port || this.allocatePort();
    const containerPort = config.defaultPort;
    const containerName = `zeus-${provider}-${hostPort}`;

    console.log(`[ContainerManager] Spawning ${provider} container on port ${hostPort}`);

    // Remove any existing container with the same name (from failed previous run)
    try {
      execSync(`docker stop ${containerName} 2>/dev/null || true`, { stdio: 'pipe' });
      execSync(`docker rm ${containerName} 2>/dev/null || true`, { stdio: 'pipe' });
    } catch {
      // Ignore - container doesn't exist
    }

    // Create workspace directory for this container
    const workspaceDir = path.join(this.workspaceBase, containerName);
    execSync(`mkdir -p ${workspaceDir}/prompts ${workspaceDir}/sessions ${workspaceDir}/data`);

    // Shared workspace for serving files (accessible via gateway at /serve/)
    const sharedWorkspace = path.join(this.workspaceBase, 'shared', 'workspace');
    execSync(`mkdir -p "${sharedWorkspace}"`);
    execSync(`chmod 777 "${sharedWorkspace}"`);

    // Shared prompts directory for dynamic system prompt configuration
    const sharedPrompts = path.join(this.workspaceBase, 'shared', 'prompts');
    execSync(`mkdir -p "${sharedPrompts}"`);
    execSync(`chmod 777 "${sharedPrompts}"`);

    // Build docker run command
    const args = [
      'run',
      '-d',
      '--name', containerName,
      '-p', `${hostPort}:${containerPort}`,
      '-v', `${workspaceDir}:/workspace`,
      '-v', `${sharedWorkspace}:/app/public:rw`,  // Shared dir for serving files
      '-v', `${sharedPrompts}:/config/prompts:ro`,  // Shared prompts for dynamic config
      '-e', `PORT=${containerPort}`,
      '-e', `WORKSPACE=/workspace`,
      '-e', `PUBLIC_DIR=/app/public`,  // Tell daemon about public dir
      '-e', `PROMPTS_DIR=/config/prompts`,  // Tell daemon about prompts dir
    ];

    // Add provider-specific environment
    for (const [key, value] of Object.entries(config.env)) {
      if (value) {
        args.push('-e', `${key}=${value}`);
      }
    }

    // Add model if specified
    if (options.model) {
      const modelEnv = `${provider.toUpperCase()}_MODEL`;
      args.push('-e', `${modelEnv}=${options.model}`);
    }

    // Add debug flag
    if (process.env.DEBUG === 'true') {
      args.push('-e', 'DEBUG=true');
    }

    // Mount CLI credentials - Claude needs writable .claude directory
    const homeDir = process.env.HOME;
    if (provider === 'claude') {
      // Claude needs writable .claude for session data, todos, stats, etc.
      // Use a SHARED .claude directory so sessions persist across container restarts
      const sharedClaudeDir = path.join(this.workspaceBase, 'shared', 'claude', '.claude');
      const hostClaudeDir = path.join(homeDir, '.claude');

      // Create and setup the shared .claude directory (only once)
      // Container runs as zeus (UID 999), so we need to make directory writable
      execSync(`mkdir -p "${sharedClaudeDir}"`);
      execSync(`chmod 777 "${sharedClaudeDir}"`);

      // Copy credentials file if it exists (this contains auth tokens)
      const credentialsFile = path.join(hostClaudeDir, '.credentials.json');
      const destCredentials = path.join(sharedClaudeDir, '.credentials.json');
      if (fs.existsSync(credentialsFile)) {
        // Always update credentials in case they were refreshed
        execSync(`cp "${credentialsFile}" "${destCredentials}"`);
        execSync(`chmod 666 "${destCredentials}"`);
      }

      // Copy settings if exists (only if not already present)
      const settingsFile = path.join(hostClaudeDir, 'settings.json');
      const destSettings = path.join(sharedClaudeDir, 'settings.json');
      if (fs.existsSync(settingsFile) && !fs.existsSync(destSettings)) {
        execSync(`cp "${settingsFile}" "${destSettings}"`);
        execSync(`chmod 666 "${destSettings}"`);
      }

      // Mount the SHARED .claude directory so sessions persist
      args.push('-v', `${sharedClaudeDir}:/home/zeus/.claude`);
    } else if (provider === 'gemini') {
      // Mount Gemini credentials
      args.push('-v', `${homeDir}/.gemini:/home/zeus/.gemini:ro`);
    } else if (provider === 'copilot') {
      // Mount GitHub CLI credentials
      args.push('-v', `${homeDir}/.config/gh:/home/zeus/.config/gh:ro`);
    }

    // Image and command - run daemon directly from its folder
    args.push(DAEMON_IMAGE);
    args.push('node', `${provider}/index.js`, containerPort.toString());

    if (process.env.DEBUG === 'true') {
      console.log('[Docker] Running:', 'docker', args.join(' '));
    }

    // Run container
    let dockerId;
    try {
      dockerId = execSync(`docker ${args.join(' ')}`, { encoding: 'utf-8' }).trim();
    } catch (err) {
      this.releasePort(hostPort);
      throw new Error(`Failed to start container: ${err.message}`);
    }

    // Register container
    const containerInfo = {
      id: containerName,
      dockerId: dockerId.slice(0, 12),
      name: containerName,
      provider,
      port: hostPort,
      containerPort,
      status: 'starting',
      health: 'unknown',
      createdAt: new Date(),
      restartCount: 0,
      model: options.model || null,
      workspaceDir,
    };

    this.containers.set(containerName, containerInfo);
    this.allocatedPorts.set(hostPort, containerName);

    // Wait for container to be healthy
    try {
      await this.waitForHealthy(containerName);
      this.emit('container:started', containerInfo);
    } catch (err) {
      console.error(`[ContainerManager] Container ${containerName} failed to start:`, err.message);
      await this.stop(containerName);
      throw err;
    }

    return containerInfo;
  }

  /**
   * Stop a container
   */
  async stop(containerId) {
    const containerInfo = this.containers.get(containerId);
    if (!containerInfo) {
      throw new Error(`Container not found: ${containerId}`);
    }

    console.log(`[ContainerManager] Stopping container: ${containerInfo.name}`);

    try {
      execSync(`docker stop ${containerInfo.name}`, { stdio: 'pipe', timeout: 10000 });
    } catch (err) {
      // Force kill if stop times out
      try {
        execSync(`docker kill ${containerInfo.name}`, { stdio: 'pipe' });
      } catch (e) {
        // Ignore
      }
    }

    // Remove container
    try {
      execSync(`docker rm ${containerInfo.name}`, { stdio: 'pipe' });
    } catch (err) {
      // Ignore
    }

    // Cleanup
    this.releasePort(containerInfo.port);
    this.containers.delete(containerId);

    this.emit('container:stopped', containerInfo);

    return containerInfo;
  }

  /**
   * Stop all containers for a provider
   */
  async stopAll(provider) {
    const toStop = [];
    for (const [id, containerInfo] of this.containers) {
      if (!provider || containerInfo.provider === provider) {
        toStop.push(id);
      }
    }

    for (const id of toStop) {
      await this.stop(id);
    }

    return toStop.length;
  }

  // ============ HEALTH CHECKS ============

  /**
   * Check container health
   */
  async checkHealth(containerId) {
    const containerInfo = this.containers.get(containerId);
    if (!containerInfo) return null;

    // Check if container is running
    try {
      const status = execSync(`docker inspect -f '{{.State.Status}}' ${containerInfo.name}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (status !== 'running') {
        containerInfo.status = 'stopped';
        containerInfo.health = 'unhealthy';
        return containerInfo;
      }
    } catch (err) {
      containerInfo.status = 'stopped';
      containerInfo.health = 'unhealthy';
      return containerInfo;
    }

    // Check HTTP health endpoint
    try {
      const response = await fetch(`http://localhost:${containerInfo.port}/health`, {
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        const data = await response.json();
        containerInfo.status = 'running';
        containerInfo.health = 'healthy';
        containerInfo.model = data.model || containerInfo.model;
        containerInfo.ready = data.ready;
      } else {
        containerInfo.health = 'unhealthy';
      }
    } catch (err) {
      containerInfo.health = 'unhealthy';
      if (containerInfo.status === 'running') {
        containerInfo.status = 'degraded';
      }
    }

    return containerInfo;
  }

  /**
   * Wait for container to become healthy
   */
  async waitForHealthy(containerId, timeout = 60000) {
    const startTime = Date.now();
    const containerInfo = this.containers.get(containerId);

    while (Date.now() - startTime < timeout) {
      await this.checkHealth(containerId);

      if (containerInfo.health === 'healthy') {
        containerInfo.status = 'running';
        return true;
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    throw new Error(`Container ${containerId} did not become healthy within ${timeout}ms`);
  }

  /**
   * Run health checks on all containers
   */
  async checkAllHealth() {
    for (const containerId of this.containers.keys()) {
      await this.checkHealth(containerId);
    }
  }

  /**
   * Start periodic health checks
   */
  startHealthChecks() {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(() => {
      this.checkAllHealth().catch((err) => {
        console.error('[ContainerManager] Health check error:', err.message);
      });
    }, this.healthCheckInterval);

    console.log(`[ContainerManager] Health checks started (interval: ${this.healthCheckInterval}ms)`);
  }

  /**
   * Stop health checks
   */
  stopHealthChecks() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // ============ QUERIES ============

  list(provider = null) {
    const result = [];
    for (const containerInfo of this.containers.values()) {
      if (!provider || containerInfo.provider === provider) {
        result.push({
          id: containerInfo.id,
          dockerId: containerInfo.dockerId,
          name: containerInfo.name,
          provider: containerInfo.provider,
          port: containerInfo.port,
          status: containerInfo.status,
          health: containerInfo.health,
          model: containerInfo.model,
          workspaceDir: containerInfo.workspaceDir,
        });
      }
    }
    return result;
  }

  get(containerId) {
    return this.containers.get(containerId);
  }

  getByProvider(provider) {
    return this.list(provider);
  }

  getHealthy(provider) {
    return this.list(provider).filter((c) => c.health === 'healthy');
  }

  getStatus() {
    const summary = {
      total: this.containers.size,
      byProvider: {},
      byHealth: { healthy: 0, unhealthy: 0, unknown: 0 },
      allocatedPorts: Array.from(this.allocatedPorts.keys()),
    };

    for (const containerInfo of this.containers.values()) {
      if (!summary.byProvider[containerInfo.provider]) {
        summary.byProvider[containerInfo.provider] = { total: 0, healthy: 0 };
      }
      summary.byProvider[containerInfo.provider].total++;
      if (containerInfo.health === 'healthy') {
        summary.byProvider[containerInfo.provider].healthy++;
      }
      summary.byHealth[containerInfo.health] = (summary.byHealth[containerInfo.health] || 0) + 1;
    }

    return summary;
  }

  // ============ CONTAINER LOGS ============

  /**
   * Get container logs
   */
  getLogs(containerId, options = {}) {
    const containerInfo = this.containers.get(containerId);
    if (!containerInfo) {
      throw new Error(`Container not found: ${containerId}`);
    }

    const args = ['logs'];
    if (options.tail) {
      args.push('--tail', options.tail.toString());
    }
    if (options.follow) {
      args.push('-f');
    }
    args.push(containerInfo.name);

    try {
      return execSync(`docker ${args.join(' ')}`, { encoding: 'utf-8' });
    } catch (err) {
      throw new Error(`Failed to get logs: ${err.message}`);
    }
  }

  // ============ CONFIGURATION ============

  /**
   * Get the shared prompts directory path
   */
  getPromptsDir() {
    return path.join(this.workspaceBase, 'shared', 'prompts');
  }

  /**
   * Get system prompt for a provider
   */
  getSystemPrompt(provider) {
    const promptFile = path.join(this.getPromptsDir(), `${provider}-system-prompt.txt`);
    try {
      if (fs.existsSync(promptFile)) {
        return fs.readFileSync(promptFile, 'utf-8');
      }
    } catch (err) {
      console.error(`[ContainerManager] Failed to read prompt for ${provider}:`, err.message);
    }
    return null;
  }

  /**
   * Set system prompt for a provider
   */
  setSystemPrompt(provider, content) {
    const promptsDir = this.getPromptsDir();
    execSync(`mkdir -p "${promptsDir}"`);
    execSync(`chmod 777 "${promptsDir}"`);

    const promptFile = path.join(promptsDir, `${provider}-system-prompt.txt`);
    fs.writeFileSync(promptFile, content, 'utf-8');
    execSync(`chmod 666 "${promptFile}"`);

    console.log(`[ContainerManager] Updated system prompt for ${provider}`);
    return promptFile;
  }

  /**
   * Get full configuration for a provider
   */
  getConfig(provider) {
    const config = this.providerConfigs[provider];
    if (!config) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    return {
      provider,
      systemPrompt: this.getSystemPrompt(provider),
      env: config.env,
      healthEndpoint: config.healthEndpoint,
    };
  }

  /**
   * Update configuration for a provider
   * Returns list of containers that need restart
   */
  updateConfig(provider, updates) {
    if (!this.providerConfigs[provider]) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    const affectedContainers = [];

    // Update system prompt if provided
    if (updates.systemPrompt !== undefined) {
      this.setSystemPrompt(provider, updates.systemPrompt);

      // Find all containers for this provider that need restart
      for (const containerInfo of this.containers.values()) {
        if (containerInfo.provider === provider) {
          affectedContainers.push(containerInfo.id);
        }
      }
    }

    return affectedContainers;
  }

  // ============ CLEANUP ============

  async cleanup() {
    console.log('[ContainerManager] Cleaning up...');
    this.stopHealthChecks();
    await this.stopAll();
  }
}
