/**
 * ProcessManager - Direct daemon process management (no containers)
 *
 * Manages daemon processes: spawning, stopping, health checks, port allocation.
 * Simpler alternative to ContainerManager for development.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Port range for dynamic allocation
const PORT_RANGE_START = 4000;
const PORT_RANGE_END = 4100;

export class ProcessManager extends EventEmitter {
  constructor(options = {}) {
    super();

    // Process registry: processId -> ProcessInfo
    this.processes = new Map();

    // Port allocation: port -> processId
    this.allocatedPorts = new Map();

    // Provider configs
    this.providerConfigs = {
      gemini: {
        defaultPort: 3456,
        healthEndpoint: '/health',
        env: { GEMINI_MODEL: process.env.GEMINI_MODEL },
      },
      claude: {
        defaultPort: 3457,
        healthEndpoint: '/health',
        env: { CLAUDE_MODEL: process.env.CLAUDE_MODEL },
      },
      copilot: {
        defaultPort: 3458,
        healthEndpoint: '/health',
        env: { COPILOT_MODEL: process.env.COPILOT_MODEL },
      },
    };

    // Health check interval
    this.healthCheckInterval = options.healthCheckInterval || 30000;
    this.healthCheckTimer = null;

    // Path to daemon.js
    this.daemonScript = path.join(__dirname, '..', 'daemon.js');
  }

  // ============ PORT MANAGEMENT ============

  allocatePort() {
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      if (!this.allocatedPorts.has(port)) {
        return port;
      }
    }
    throw new Error('No available ports in range');
  }

  releasePort(port) {
    this.allocatedPorts.delete(port);
  }

  // ============ PROCESS LIFECYCLE ============

  /**
   * Spawn a new daemon process
   */
  async spawn(provider, options = {}) {
    const config = this.providerConfigs[provider];
    if (!config) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    // Allocate port
    const port = options.port || this.allocatePort();
    const processId = `${provider}-${port}`;

    console.log(`[ProcessManager] Spawning ${provider} on port ${port}`);

    // Build environment
    const env = {
      ...process.env,
      PORT: port.toString(),
      DEBUG: process.env.DEBUG || 'false',
      ...config.env,
    };

    if (options.model) {
      const modelEnv = `${provider.toUpperCase()}_MODEL`;
      env[modelEnv] = options.model;
    }

    // Spawn process
    const proc = spawn('node', [this.daemonScript, provider, port.toString()], {
      env,
      cwd: path.dirname(this.daemonScript),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    // Register process
    const processInfo = {
      id: processId,
      pid: proc.pid,
      name: `zeus-${provider}-${port}`,
      provider,
      port,
      status: 'starting',
      health: 'unknown',
      createdAt: new Date(),
      restartCount: 0,
      model: options.model || null,
      process: proc,
    };

    this.processes.set(processId, processInfo);
    this.allocatedPorts.set(port, processId);

    // Handle process output
    proc.stdout.on('data', (data) => {
      if (process.env.DEBUG === 'true') {
        console.log(`[${processInfo.name}]`, data.toString().trim());
      }
    });

    proc.stderr.on('data', (data) => {
      console.error(`[${processInfo.name}]`, data.toString().trim());
    });

    proc.on('close', (code) => {
      console.log(`[ProcessManager] Process ${processInfo.name} exited with code ${code}`);
      processInfo.status = 'stopped';
      processInfo.health = 'unhealthy';
      this.emit('process:stopped', processInfo);
    });

    proc.on('error', (err) => {
      console.error(`[ProcessManager] Process ${processInfo.name} error:`, err.message);
      processInfo.status = 'failed';
      processInfo.health = 'unhealthy';
      this.emit('process:failed', processInfo);
    });

    // Wait for process to be healthy
    try {
      await this.waitForHealthy(processId);
      this.emit('process:started', processInfo);
    } catch (err) {
      console.error(`[ProcessManager] Process ${processInfo.name} failed to start:`, err.message);
      this.stop(processId);
      throw err;
    }

    return processInfo;
  }

  /**
   * Stop a process
   */
  async stop(processId) {
    const processInfo = this.processes.get(processId);
    if (!processInfo) {
      throw new Error(`Process not found: ${processId}`);
    }

    console.log(`[ProcessManager] Stopping process: ${processInfo.name}`);

    if (processInfo.process && !processInfo.process.killed) {
      processInfo.process.kill('SIGTERM');

      // Force kill after 5 seconds
      setTimeout(() => {
        if (!processInfo.process.killed) {
          processInfo.process.kill('SIGKILL');
        }
      }, 5000);
    }

    // Cleanup
    this.releasePort(processInfo.port);
    this.processes.delete(processId);

    return processInfo;
  }

  /**
   * Stop all processes for a provider
   */
  async stopAll(provider) {
    const toStop = [];
    for (const [id, processInfo] of this.processes) {
      if (!provider || processInfo.provider === provider) {
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
   * Check process health
   */
  async checkHealth(processId) {
    const processInfo = this.processes.get(processId);
    if (!processInfo) return null;

    // Check if process is still running
    if (!processInfo.process || processInfo.process.killed) {
      processInfo.status = 'stopped';
      processInfo.health = 'unhealthy';
      return processInfo;
    }

    try {
      const response = await fetch(`http://localhost:${processInfo.port}/health`, {
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        const data = await response.json();
        processInfo.status = 'running';
        processInfo.health = 'healthy';
        processInfo.model = data.model || processInfo.model;
        processInfo.ready = data.ready;
      } else {
        processInfo.health = 'unhealthy';
      }
    } catch (err) {
      processInfo.health = 'unhealthy';
      if (processInfo.status === 'running') {
        processInfo.status = 'degraded';
      }
    }

    return processInfo;
  }

  /**
   * Wait for process to become healthy
   */
  async waitForHealthy(processId, timeout = 30000) {
    const startTime = Date.now();
    const processInfo = this.processes.get(processId);

    while (Date.now() - startTime < timeout) {
      await this.checkHealth(processId);

      if (processInfo.health === 'healthy') {
        processInfo.status = 'running';
        return true;
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    throw new Error(`Process ${processId} did not become healthy within ${timeout}ms`);
  }

  /**
   * Run health checks on all processes
   */
  async checkAllHealth() {
    for (const processId of this.processes.keys()) {
      await this.checkHealth(processId);
    }
  }

  /**
   * Start periodic health checks
   */
  startHealthChecks() {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(() => {
      this.checkAllHealth().catch((err) => {
        console.error('[ProcessManager] Health check error:', err.message);
      });
    }, this.healthCheckInterval);

    console.log(`[ProcessManager] Health checks started (interval: ${this.healthCheckInterval}ms)`);
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
    for (const processInfo of this.processes.values()) {
      if (!provider || processInfo.provider === provider) {
        result.push({
          id: processInfo.id,
          name: processInfo.name,
          provider: processInfo.provider,
          port: processInfo.port,
          status: processInfo.status,
          health: processInfo.health,
          model: processInfo.model,
          pid: processInfo.pid,
        });
      }
    }
    return result;
  }

  get(processId) {
    return this.processes.get(processId);
  }

  getByProvider(provider) {
    return this.list(provider);
  }

  getHealthy(provider) {
    return this.list(provider).filter((p) => p.health === 'healthy');
  }

  getStatus() {
    const summary = {
      total: this.processes.size,
      byProvider: {},
      byHealth: { healthy: 0, unhealthy: 0, unknown: 0 },
      allocatedPorts: Array.from(this.allocatedPorts.keys()),
    };

    for (const processInfo of this.processes.values()) {
      if (!summary.byProvider[processInfo.provider]) {
        summary.byProvider[processInfo.provider] = { total: 0, healthy: 0 };
      }
      summary.byProvider[processInfo.provider].total++;
      if (processInfo.health === 'healthy') {
        summary.byProvider[processInfo.provider].healthy++;
      }
      summary.byHealth[processInfo.health] = (summary.byHealth[processInfo.health] || 0) + 1;
    }

    return summary;
  }

  // ============ CLEANUP ============

  async cleanup() {
    console.log('[ProcessManager] Cleaning up...');
    this.stopHealthChecks();
    await this.stopAll();
  }
}
