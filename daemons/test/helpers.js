/**
 * Test helpers for daemon and gateway testing
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMONS_DIR = path.join(__dirname, '..');
const GATEWAY_SCRIPT = path.join(__dirname, '..', '..', 'gateway', 'index.js');

/**
 * Start a daemon process directly from its folder
 */
export async function startDaemon(type, port, options = {}) {
  const daemonScript = path.join(DAEMONS_DIR, type, 'index.js');
  const env = {
    ...process.env,
    DEBUG: options.debug ? 'true' : 'false',
    ...options.env,
  };

  const proc = spawn('node', [daemonScript, port.toString()], {
    env,
    cwd: DAEMONS_DIR,
    stdio: options.stdio || ['pipe', 'pipe', 'pipe'],
  });

  const output = { stdout: '', stderr: '' };

  proc.stdout.on('data', (data) => {
    output.stdout += data.toString();
    if (options.debug) console.log(`[${type}:${port}]`, data.toString().trim());
  });

  proc.stderr.on('data', (data) => {
    output.stderr += data.toString();
    if (options.debug) console.error(`[${type}:${port}]`, data.toString().trim());
  });

  // Wait for daemon to be ready
  const timeout = options.timeout || 30000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        const data = await res.json();
        if (data.ready && data.authenticated) {
          return { proc, port, type, output };
        }
      }
    } catch {
      // Not ready yet
    }
    await sleep(500);
  }

  proc.kill();
  throw new Error(`Daemon ${type} failed to start within ${timeout}ms\nstdout: ${output.stdout}\nstderr: ${output.stderr}`);
}

/**
 * Start the gateway
 */
export async function startGateway(port, options = {}) {
  const env = {
    ...process.env,
    DEBUG: options.debug ? 'true' : 'false',
    GATEWAY_PORT: port.toString(),
    ...options.env,
  };

  const proc = spawn('node', [GATEWAY_SCRIPT, port.toString()], {
    env,
    cwd: path.dirname(GATEWAY_SCRIPT),
    stdio: options.stdio || ['pipe', 'pipe', 'pipe'],
  });

  const output = { stdout: '', stderr: '' };

  proc.stdout.on('data', (data) => {
    output.stdout += data.toString();
    if (options.debug) console.log(`[gateway:${port}]`, data.toString().trim());
  });

  proc.stderr.on('data', (data) => {
    output.stderr += data.toString();
    if (options.debug) console.error(`[gateway:${port}]`, data.toString().trim());
  });

  // Wait for gateway to be ready
  const timeout = options.timeout || 10000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        return { proc, port, output };
      }
    } catch {
      // Not ready yet
    }
    await sleep(200);
  }

  proc.kill();
  throw new Error(`Gateway failed to start within ${timeout}ms\nstdout: ${output.stdout}\nstderr: ${output.stderr}`);
}

/**
 * Stop a process gracefully
 */
export async function stopProcess(proc, timeout = 5000) {
  if (!proc || proc.killed) return;

  proc.kill('SIGTERM');

  const killTimer = setTimeout(() => {
    if (!proc.killed) proc.kill('SIGKILL');
  }, timeout);

  try {
    await once(proc, 'close');
  } finally {
    clearTimeout(killTimer);
  }
}

/**
 * WebSocket client helper
 */
export class WSClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.messages = [];
    this.waiters = [];
  }

  async connect(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, timeout);

      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        this.messages.push(msg);

        // Check waiters
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          const waiter = this.waiters[i];
          if (waiter.predicate(msg)) {
            waiter.resolve(msg);
            this.waiters.splice(i, 1);
          }
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      this.ws.on('close', () => {
        // Reject all pending waiters
        for (const waiter of this.waiters) {
          waiter.reject(new Error('WebSocket closed'));
        }
        this.waiters = [];
      });
    });
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Wait for a message matching the predicate
   */
  waitFor(predicate, timeout = 10000) {
    // Check existing messages
    const existing = this.messages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`Timeout waiting for message. Received: ${JSON.stringify(this.messages.map(m => m.type))}`));
      }, timeout);

      this.waiters.push({
        predicate,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  /**
   * Wait for a message of a specific type
   */
  waitForType(type, timeout = 10000) {
    return this.waitFor((msg) => msg.type === type, timeout);
  }

  /**
   * Collect messages until a condition is met
   */
  async collectUntil(predicate, timeout = 30000) {
    const collected = [];
    const startIdx = this.messages.length;

    await this.waitFor((msg) => {
      collected.push(msg);
      return predicate(msg);
    }, timeout);

    return collected;
  }

  /**
   * Collect all messages of a chat response
   */
  async collectChatResponse(timeout = 60000) {
    return this.collectUntil(
      (msg) => msg.type === 'done' || msg.type === 'error',
      timeout
    );
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  clearMessages() {
    this.messages = [];
  }
}

/**
 * HTTP helper
 */
export async function httpGet(url) {
  const res = await fetch(url);
  const data = await res.json();
  return { status: res.status, data };
}

/**
 * Sleep helper
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Get an available port
 */
let portCounter = 5000;
export function getPort() {
  return portCounter++;
}

/**
 * Reset port counter (for test isolation)
 */
export function resetPorts() {
  portCounter = 5000;
}
