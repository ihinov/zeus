/**
 * Gateway - Control plane for AI daemon orchestration
 *
 * Full lifecycle management: spawning, stopping, health monitoring,
 * port allocation, routing, and scaling.
 *
 * Uses Docker containers for daemon isolation and management.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { ContainerManager } from './ContainerManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class Gateway {
  constructor(options = {}) {
    this.port = options.port || 3000;
    this.sessionId = uuidv4();

    // Container manager for lifecycle management
    const managerOptions = {
      healthCheckInterval: options.healthCheckInterval || 30000,
    };

    this.containerManager = new ContainerManager(managerOptions);
    console.log('[Gateway] Using ContainerManager (Docker mode)');

    // Daemon connections: processId -> WebSocket
    this.daemonConnections = new Map();

    // Client connections: clientId -> { ws, currentProcessId, subscriptions }
    this.clients = new Map();

    // Subscriptions: processId -> Set<clientId>
    this.subscriptions = new Map();

    // Provider subscriptions: provider -> Set<clientId>
    this.providerSubscriptions = new Map();

    // Load balancing: provider -> [processId]
    this.providerPool = new Map();

    this.httpServer = null;
    this.wss = null;

    // Auto-spawn configuration
    this.autoSpawn = options.autoSpawn || {};

    // Setup process manager events
    this.setupContainerEvents();
  }

  // ============ DAEMON EVENTS ============

  setupContainerEvents() {
    this.containerManager.on('container:started', async (info) => {
      console.log(`[Gateway] Daemon started: ${info.name}`);
      try {
        await this.connectToProcess(info);
        this.updateProviderPool(info.provider);
      } catch (err) {
        console.error(`[Gateway] Failed to connect to ${info.name}:`, err.message);
      }
    });

    this.containerManager.on('container:stopped', (info) => {
      console.log(`[Gateway] Daemon stopped: ${info.name}`);
      this.disconnectFromProcess(info.id);
      this.updateProviderPool(info.provider);
    });

    this.containerManager.on('container:failed', (info) => {
      console.log(`[Gateway] Daemon failed: ${info.name}`);
      this.broadcastToClients({
        type: 'provider_status',
        payload: {
          provider: info.provider,
          status: 'degraded',
          message: `Daemon ${info.name} failed`,
        },
      });
    });
  }

  // ============ DAEMON CONNECTIONS ============

  /**
   * Connect to a daemon process's WebSocket
   */
  async connectToProcess(processInfo) {
    const url = `ws://localhost:${processInfo.port}`;

    return new Promise((resolve, reject) => {
      console.log(`[Gateway] Connecting to ${processInfo.name} at ${url}...`);

      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Connection timeout for ${processInfo.name}`));
      }, 10000);

      ws.on('open', () => {
        clearTimeout(timeout);
        this.daemonConnections.set(processInfo.id, ws);
        console.log(`[Gateway] Connected to ${processInfo.name}`);
        resolve();
      });

      ws.on('message', (data) => {
        this.handleDaemonMessage(processInfo.id, data);
      });

      ws.on('close', () => {
        console.log(`[Gateway] Disconnected from ${processInfo.name}`);
        this.daemonConnections.delete(processInfo.id);
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        console.error(`[Gateway] Connection error for ${processInfo.name}:`, err.message);
        reject(err);
      });
    });
  }

  /**
   * Disconnect from a process
   */
  disconnectFromProcess(processId) {
    const ws = this.daemonConnections.get(processId);
    if (ws) {
      ws.close();
      this.daemonConnections.delete(processId);
    }
  }

  /**
   * Update provider pool with healthy processes
   */
  updateProviderPool(provider) {
    const healthy = this.containerManager.getHealthy(provider);
    const ids = healthy.map((p) => p.id);
    this.providerPool.set(provider, ids);
    console.log(`[Gateway] Updated provider pool for ${provider}:`, ids);
  }

  /**
   * Get a process for a provider (load balancing)
   */
  getProcessForProvider(provider) {
    const pool = this.providerPool.get(provider) || [];
    console.log(`[Gateway] getProcessForProvider(${provider}): pool =`, pool);
    if (pool.length === 0) return null;

    // Simple round-robin
    const processId = pool[Math.floor(Math.random() * pool.length)];
    return this.containerManager.get(processId);
  }

  // ============ MESSAGE HANDLING ============

  /**
   * Handle message from daemon process
   */
  handleDaemonMessage(processId, data) {
    try {
      const message = JSON.parse(data.toString());
      const processInfo = this.containerManager.get(processId);

      // Update process info on connected event
      if (message.type === 'connected') {
        if (processInfo) {
          processInfo.model = message.payload.model;
          processInfo.models = message.payload.availableModels || [];
        }
        return;
      }

      // Enrich message with process info
      const enrichedMessage = {
        ...message,
        provider: processInfo?.provider,
        processId,
        processName: processInfo?.name,
      };

      // Forward to the client that initiated the chat
      for (const [clientId, client] of this.clients) {
        if (client.currentProcessId === processId) {
          this.sendToClient(clientId, enrichedMessage);

          // Clear current process on done/error
          if (message.type === 'done' || message.type === 'error') {
            client.currentProcessId = null;
          }
        }
      }

      // Broadcast to process subscribers
      const processSubs = this.subscriptions.get(processId);
      if (processSubs) {
        for (const clientId of processSubs) {
          // Don't double-send to the initiating client
          const client = this.clients.get(clientId);
          if (client && client.currentProcessId !== processId) {
            this.sendToClient(clientId, {
              type: 'stream',
              source: 'process',
              event: enrichedMessage.type,
              payload: enrichedMessage.payload,
              provider: enrichedMessage.provider,
              processId: enrichedMessage.processId,
              processName: enrichedMessage.processName,
            });
          }
        }
      }

      // Broadcast to provider subscribers
      if (processInfo?.provider) {
        const providerSubs = this.providerSubscriptions.get(processInfo.provider);
        if (providerSubs) {
          for (const clientId of providerSubs) {
            const client = this.clients.get(clientId);
            // Don't double-send to process subscribers or initiating client
            if (client &&
                client.currentProcessId !== processId &&
                !processSubs?.has(clientId)) {
              this.sendToClient(clientId, {
                type: 'stream',
                source: 'provider',
                event: enrichedMessage.type,
                payload: enrichedMessage.payload,
                provider: enrichedMessage.provider,
                processId: enrichedMessage.processId,
                processName: enrichedMessage.processName,
              });
            }
          }
        }
      }
    } catch (err) {
      console.error(`[Gateway] Error parsing daemon message:`, err.message);
    }
  }

  /**
   * Send message to a process
   */
  sendToProcess(processId, message) {
    const ws = this.daemonConnections.get(processId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Process ${processId} not connected`);
    }
    ws.send(JSON.stringify(message));
  }

  // ============ CLIENT HANDLING ============

  /**
   * Send message to client
   */
  sendToClient(clientId, message) {
    const client = this.clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Broadcast to all clients
   */
  broadcastToClients(message) {
    for (const clientId of this.clients.keys()) {
      this.sendToClient(clientId, message);
    }
  }

  /**
   * Handle client message
   */
  async handleClientMessage(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client) return;

    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'chat':
          await this.handleChat(clientId, message);
          break;

        case 'spawn':
          await this.handleSpawn(clientId, message);
          break;

        case 'stop':
          await this.handleStop(clientId, message);
          break;

        case 'scale':
          await this.handleScale(clientId, message);
          break;

        case 'set_model':
          await this.handleSetModel(clientId, message);
          break;

        case 'list_processes':
          this.sendToClient(clientId, {
            type: 'processes',
            payload: this.containerManager.list(message.provider),
          });
          break;

        case 'list_providers':
          this.sendToClient(clientId, {
            type: 'providers',
            payload: this.getProvidersInfo(),
          });
          break;

        case 'list_models':
          await this.handleListModels(clientId, message);
          break;

        case 'status':
          this.sendToClient(clientId, {
            type: 'status',
            payload: await this.getFullStatus(),
          });
          break;

        case 'ping':
          this.sendToClient(clientId, {
            type: 'pong',
            payload: { timestamp: Date.now() },
          });
          break;

        case 'subscribe':
          this.handleSubscribe(clientId, message);
          break;

        case 'unsubscribe':
          this.handleUnsubscribe(clientId, message);
          break;

        case 'list_subscriptions':
          this.sendToClient(clientId, {
            type: 'subscriptions',
            payload: this.getClientSubscriptions(clientId),
          });
          break;

        // ============ ORCHESTRATION: SESSION MANAGEMENT ============
        case 'new_session':
          await this.handleForwardToProcess(clientId, message);
          break;

        case 'set_session':
          await this.handleForwardToProcess(clientId, message);
          break;

        case 'get_session':
          await this.handleForwardToProcess(clientId, message);
          break;

        // ============ ORCHESTRATION: SYSTEM PROMPT ============
        case 'set_system_prompt':
          await this.handleForwardToProcess(clientId, message);
          break;

        case 'set_append_system_prompt':
          await this.handleForwardToProcess(clientId, message);
          break;

        case 'get_system_prompt':
          await this.handleForwardToProcess(clientId, message);
          break;

        // ============ ORCHESTRATION: TOOLS ============
        case 'set_allowed_tools':
          await this.handleForwardToProcess(clientId, message);
          break;

        case 'get_allowed_tools':
          await this.handleForwardToProcess(clientId, message);
          break;

        // ============ ORCHESTRATION: AGENT STATE ============
        case 'get_agent_state':
          await this.handleForwardToProcess(clientId, message);
          break;

        // ============ CONTAINER LOGS (container mode only) ============
        case 'get_logs':
          await this.handleGetLogs(clientId, message);
          break;

        default:
          this.sendToClient(clientId, {
            type: 'error',
            payload: { message: `Unknown message type: ${message.type}` },
          });
      }
    } catch (err) {
      console.error(`[Gateway] Error handling client message:`, err.message);
      this.sendToClient(clientId, {
        type: 'error',
        payload: { message: err.message },
      });
    }
  }

  /**
   * Handle chat request
   */
  async handleChat(clientId, message) {
    const client = this.clients.get(clientId);
    const provider = message.payload?.provider || message.provider || 'gemini';

    // Get a healthy process for the provider
    let processInfo = this.getProcessForProvider(provider);

    // Auto-spawn if no process available and auto-spawn enabled
    if (!processInfo && this.autoSpawn[provider]) {
      console.log(`[Gateway] Auto-spawning ${provider} process...`);
      try {
        processInfo = await this.containerManager.spawn(provider, {
          model: message.payload?.model,
        });
        await this.connectToProcess(processInfo);
        this.updateProviderPool(provider);
      } catch (err) {
        this.sendToClient(clientId, {
          type: 'error',
          payload: { message: `Failed to spawn ${provider}: ${err.message}` },
        });
        return;
      }
    }

    if (!processInfo) {
      this.sendToClient(clientId, {
        type: 'error',
        payload: {
          message: `No healthy ${provider} process available. Use 'spawn' to start one.`,
          hint: { type: 'spawn', provider },
        },
      });
      return;
    }

    // Mark client as using this process
    client.currentProcessId = processInfo.id;

    // Forward to process
    try {
      this.sendToProcess(processInfo.id, {
        type: 'chat',
        payload: message.payload,
      });
    } catch (err) {
      console.error(`[Gateway] Failed to send to process:`, err.message);
      this.sendToClient(clientId, {
        type: 'error',
        payload: {
          message: `Failed to communicate with ${provider} daemon: ${err.message}`,
          hint: 'The daemon may still be starting up. Try again in a moment.',
        },
      });
    }
  }

  /**
   * Handle spawn request
   */
  async handleSpawn(clientId, message) {
    const provider = message.payload?.provider || message.provider;
    if (!provider) {
      this.sendToClient(clientId, {
        type: 'error',
        payload: { message: 'Provider required for spawn' },
      });
      return;
    }

    try {
      this.sendToClient(clientId, {
        type: 'spawning',
        payload: { provider },
      });

      const processInfo = await this.containerManager.spawn(provider, {
        model: message.payload?.model,
        port: message.payload?.port,
      });

      await this.connectToProcess(processInfo);
      this.updateProviderPool(provider);

      this.sendToClient(clientId, {
        type: 'spawned',
        payload: processInfo,
      });
    } catch (err) {
      this.sendToClient(clientId, {
        type: 'error',
        payload: { message: `Spawn failed: ${err.message}` },
      });
    }
  }

  /**
   * Handle stop request
   */
  async handleStop(clientId, message) {
    const processId = message.payload?.processId || message.processId;
    const provider = message.payload?.provider || message.provider;

    try {
      if (processId) {
        await this.containerManager.stop(processId);
        this.sendToClient(clientId, {
          type: 'stopped',
          payload: { processId },
        });
      } else if (provider) {
        const count = await this.containerManager.stopAll(provider);
        this.updateProviderPool(provider);
        this.sendToClient(clientId, {
          type: 'stopped',
          payload: { provider, count },
        });
      } else {
        this.sendToClient(clientId, {
          type: 'error',
          payload: { message: 'processId or provider required for stop' },
        });
      }
    } catch (err) {
      this.sendToClient(clientId, {
        type: 'error',
        payload: { message: `Stop failed: ${err.message}` },
      });
    }
  }

  /**
   * Handle scale request
   */
  async handleScale(clientId, message) {
    const provider = message.payload?.provider || message.provider;
    const count = message.payload?.count || message.count;

    if (!provider || typeof count !== 'number') {
      this.sendToClient(clientId, {
        type: 'error',
        payload: { message: 'provider and count required for scale' },
      });
      return;
    }

    const current = this.containerManager.getByProvider(provider).length;
    const diff = count - current;

    try {
      if (diff > 0) {
        // Scale up
        for (let i = 0; i < diff; i++) {
          const processInfo = await this.containerManager.spawn(provider, {
            model: message.payload?.model,
          });
          await this.connectToProcess(processInfo);
        }
      } else if (diff < 0) {
        // Scale down
        const processes = this.containerManager.getByProvider(provider);
        for (let i = 0; i < Math.abs(diff); i++) {
          if (processes[i]) {
            await this.containerManager.stop(processes[i].id);
          }
        }
      }

      this.updateProviderPool(provider);

      this.sendToClient(clientId, {
        type: 'scaled',
        payload: {
          provider,
          previous: current,
          current: count,
        },
      });
    } catch (err) {
      this.sendToClient(clientId, {
        type: 'error',
        payload: { message: `Scale failed: ${err.message}` },
      });
    }
  }

  /**
   * Handle set_model request
   */
  async handleSetModel(clientId, message) {
    const processId = message.payload?.processId || message.processId;
    const model = message.payload?.model || message.model;

    if (!processId || !model) {
      this.sendToClient(clientId, {
        type: 'error',
        payload: { message: 'processId and model required for set_model' },
      });
      return;
    }

    const client = this.clients.get(clientId);
    client.currentProcessId = processId;

    this.sendToProcess(processId, {
      type: 'set_model',
      model,
    });
  }

  /**
   * Handle list_models request
   */
  async handleListModels(clientId, message) {
    const provider = message.payload?.provider || message.provider;

    const models = {};
    for (const processInfo of this.containerManager.list(provider)) {
      if (!models[processInfo.provider]) {
        models[processInfo.provider] = {
          models: processInfo.models || [],
          processes: [],
        };
      }
      models[processInfo.provider].processes.push({
        id: processInfo.id,
        model: processInfo.model,
        health: processInfo.health,
      });
    }

    this.sendToClient(clientId, {
      type: 'models',
      payload: models,
    });
  }

  // ============ ORCHESTRATION: FORWARD TO PROCESS ============

  /**
   * Forward a message to a specific process for orchestration operations.
   * Requires processId to identify the target daemon.
   * Optionally can use provider to auto-select a healthy process.
   */
  async handleForwardToProcess(clientId, message) {
    const client = this.clients.get(clientId);
    let processId = message.payload?.processId || message.processId;
    const provider = message.payload?.provider || message.provider;

    // If no processId but provider is given, select a process
    if (!processId && provider) {
      const processInfo = this.getProcessForProvider(provider);
      if (processInfo) {
        processId = processInfo.id;
      }
    }

    if (!processId) {
      this.sendToClient(clientId, {
        type: 'error',
        payload: {
          message: 'processId or provider required for this operation',
          hint: 'Use list_processes to find available processes',
        },
      });
      return;
    }

    // Check if process exists and is connected
    const processInfo = this.containerManager.get(processId);
    if (!processInfo) {
      this.sendToClient(clientId, {
        type: 'error',
        payload: { message: `Process ${processId} not found` },
      });
      return;
    }

    const ws = this.daemonConnections.get(processId);
    if (!ws || ws.readyState !== 1) { // 1 = WebSocket.OPEN
      this.sendToClient(clientId, {
        type: 'error',
        payload: { message: `Process ${processId} not connected` },
      });
      return;
    }

    // Mark client as expecting response from this process
    client.currentProcessId = processId;

    // Forward the message to the daemon
    this.sendToProcess(processId, {
      type: message.type,
      payload: message.payload,
    });
  }

  // ============ CONTAINER LOGS ============

  /**
   * Handle get_logs request
   */
  async handleGetLogs(clientId, message) {
    const processId = message.payload?.processId || message.processId;
    const tail = message.payload?.tail || 100;

    if (!processId) {
      this.sendToClient(clientId, {
        type: 'error',
        payload: { message: 'processId required for get_logs' },
      });
      return;
    }

    try {
      const logs = this.containerManager.getLogs(processId, { tail });
      this.sendToClient(clientId, {
        type: 'logs',
        payload: { processId, logs },
      });
    } catch (err) {
      this.sendToClient(clientId, {
        type: 'error',
        payload: { message: err.message },
      });
    }
  }

  // ============ SUBSCRIPTIONS ============

  /**
   * Handle subscribe request
   * Subscribe to a process or provider stream
   */
  handleSubscribe(clientId, message) {
    const processId = message.payload?.processId || message.processId;
    const provider = message.payload?.provider || message.provider;

    if (!processId && !provider) {
      this.sendToClient(clientId, {
        type: 'error',
        payload: { message: 'processId or provider required for subscribe' },
      });
      return;
    }

    const client = this.clients.get(clientId);
    if (!client.subscriptions) {
      client.subscriptions = { processes: new Set(), providers: new Set() };
    }

    if (processId) {
      // Subscribe to specific process
      if (!this.subscriptions.has(processId)) {
        this.subscriptions.set(processId, new Set());
      }
      this.subscriptions.get(processId).add(clientId);
      client.subscriptions.processes.add(processId);

      const processInfo = this.containerManager.get(processId);
      console.log(`[Gateway] Client ${clientId} subscribed to process ${processId}`);

      this.sendToClient(clientId, {
        type: 'subscribed',
        payload: {
          processId,
          processName: processInfo?.name,
          provider: processInfo?.provider,
        },
      });
    }

    if (provider) {
      // Subscribe to all processes of a provider
      if (!this.providerSubscriptions.has(provider)) {
        this.providerSubscriptions.set(provider, new Set());
      }
      this.providerSubscriptions.get(provider).add(clientId);
      client.subscriptions.providers.add(provider);

      console.log(`[Gateway] Client ${clientId} subscribed to provider ${provider}`);

      this.sendToClient(clientId, {
        type: 'subscribed',
        payload: {
          provider,
          processes: this.containerManager.getByProvider(provider).map((p) => ({
            id: p.id,
            name: p.name,
            health: p.health,
          })),
        },
      });
    }
  }

  /**
   * Handle unsubscribe request
   */
  handleUnsubscribe(clientId, message) {
    const processId = message.payload?.processId || message.processId;
    const provider = message.payload?.provider || message.provider;
    const all = message.payload?.all || message.all;

    const client = this.clients.get(clientId);
    if (!client.subscriptions) return;

    if (all) {
      // Unsubscribe from everything
      this.removeAllSubscriptions(clientId);
      this.sendToClient(clientId, {
        type: 'unsubscribed',
        payload: { all: true },
      });
      return;
    }

    if (processId) {
      const subs = this.subscriptions.get(processId);
      if (subs) {
        subs.delete(clientId);
        if (subs.size === 0) {
          this.subscriptions.delete(processId);
        }
      }
      client.subscriptions.processes.delete(processId);

      console.log(`[Gateway] Client ${clientId} unsubscribed from process ${processId}`);

      this.sendToClient(clientId, {
        type: 'unsubscribed',
        payload: { processId },
      });
    }

    if (provider) {
      const subs = this.providerSubscriptions.get(provider);
      if (subs) {
        subs.delete(clientId);
        if (subs.size === 0) {
          this.providerSubscriptions.delete(provider);
        }
      }
      client.subscriptions.providers.delete(provider);

      console.log(`[Gateway] Client ${clientId} unsubscribed from provider ${provider}`);

      this.sendToClient(clientId, {
        type: 'unsubscribed',
        payload: { provider },
      });
    }
  }

  /**
   * Remove all subscriptions for a client
   */
  removeAllSubscriptions(clientId) {
    const client = this.clients.get(clientId);
    if (!client?.subscriptions) return;

    // Remove from process subscriptions
    for (const processId of client.subscriptions.processes) {
      const subs = this.subscriptions.get(processId);
      if (subs) {
        subs.delete(clientId);
        if (subs.size === 0) {
          this.subscriptions.delete(processId);
        }
      }
    }

    // Remove from provider subscriptions
    for (const provider of client.subscriptions.providers) {
      const subs = this.providerSubscriptions.get(provider);
      if (subs) {
        subs.delete(clientId);
        if (subs.size === 0) {
          this.providerSubscriptions.delete(provider);
        }
      }
    }

    client.subscriptions = { processes: new Set(), providers: new Set() };
  }

  /**
   * Get subscriptions for a client
   */
  getClientSubscriptions(clientId) {
    const client = this.clients.get(clientId);
    if (!client?.subscriptions) {
      return { processes: [], providers: [] };
    }

    return {
      processes: Array.from(client.subscriptions.processes).map((id) => {
        const processInfo = this.containerManager.get(id);
        return {
          id,
          name: processInfo?.name,
          provider: processInfo?.provider,
          health: processInfo?.health,
        };
      }),
      providers: Array.from(client.subscriptions.providers),
    };
  }

  // ============ STATUS ============

  /**
   * Get providers info
   */
  getProvidersInfo() {
    const providers = {};

    for (const provider of ['gemini', 'claude', 'copilot']) {
      const processes = this.containerManager.getByProvider(provider);
      const healthy = processes.filter((p) => p.health === 'healthy');

      providers[provider] = {
        total: processes.length,
        healthy: healthy.length,
        processes: processes.map((p) => ({
          id: p.id,
          name: p.name,
          port: p.port,
          status: p.status,
          health: p.health,
          model: p.model,
        })),
      };
    }

    return providers;
  }

  /**
   * Get full status
   */
  async getFullStatus() {
    return {
      gateway: {
        sessionId: this.sessionId,
        uptime: process.uptime(),
        clients: this.clients.size,
      },
      containers: this.containerManager.getStatus(),
      providers: this.getProvidersInfo(),
    };
  }

  // ============ SERVERS ============

  setupWebSocket(server) {
    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws) => {
      const clientId = uuidv4().slice(0, 8);
      console.log(`[Gateway] Client connected: ${clientId}`);

      this.clients.set(clientId, {
        ws,
        currentProcessId: null,
        subscriptions: { processes: new Set(), providers: new Set() },
      });

      // Send connected event
      this.sendToClient(clientId, {
        type: 'connected',
        payload: {
          sessionId: this.sessionId,
          clientId,
          providers: this.getProvidersInfo(),
        },
      });

      ws.on('message', (data) => this.handleClientMessage(clientId, data));

      ws.on('close', () => {
        console.log(`[Gateway] Client disconnected: ${clientId}`);
        this.removeAllSubscriptions(clientId);
        this.clients.delete(clientId);
      });

      ws.on('error', (err) => {
        console.error(`[Gateway] Client error (${clientId}):`, err.message);
      });
    });

    return this.wss;
  }

  setupHttpServer() {
    this.httpServer = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host}`);

      // Serve UI
      if (url.pathname === '/' || url.pathname === '/ui' || url.pathname === '/ui/') {
        const uiPath = path.join(__dirname, 'ui', 'index.html');
        try {
          const content = fs.readFileSync(uiPath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(content);
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('UI not found');
        }
        return;
      }

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
        return;
      }

      if (url.pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(await this.getFullStatus()));
        return;
      }

      if (url.pathname === '/providers') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.getProvidersInfo()));
        return;
      }

      if (url.pathname === '/processes') {
        const provider = url.searchParams.get('provider');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.containerManager.list(provider)));
        return;
      }

      // Container logs
      if (url.pathname.startsWith('/logs/')) {
        const containerId = url.pathname.slice(6); // Remove '/logs/'
        const tail = parseInt(url.searchParams.get('tail') || '100', 10);

        try {
          const logs = this.containerManager.getLogs(containerId, { tail });
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(logs);
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Configuration endpoints
      // GET /config/:provider - Get current config
      // POST /config/:provider - Update config (restarts affected daemons)
      if (url.pathname.startsWith('/config/')) {
        const provider = url.pathname.slice(8); // Remove '/config/'

        if (req.method === 'GET') {
          try {
            const config = this.containerManager.getConfig(provider);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(config));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        if (req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const updates = JSON.parse(body);
              const affectedContainers = this.containerManager.updateConfig(provider, updates);

              // Optionally restart affected containers
              let restartedContainers = [];
              if (updates.restart !== false && affectedContainers.length > 0) {
                console.log(`[Gateway] Restarting ${affectedContainers.length} ${provider} containers for config update`);

                for (const containerId of affectedContainers) {
                  const containerInfo = this.containerManager.get(containerId);
                  if (containerInfo) {
                    try {
                      // Stop and respawn
                      await this.containerManager.stop(containerId);
                      const newContainer = await this.containerManager.spawn(provider, {
                        model: containerInfo.model,
                      });
                      restartedContainers.push(newContainer.id);
                    } catch (err) {
                      console.error(`[Gateway] Failed to restart ${containerId}:`, err.message);
                    }
                  }
                }
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: true,
                provider,
                affectedContainers,
                restartedContainers,
              }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }
      }

      // Static file server for workspace files
      // Serves files from the shared workspace at /serve/filename
      if (url.pathname.startsWith('/serve/')) {
        const filePath = url.pathname.slice(7); // Remove '/serve/'
        const workspaceBase = this.containerManager.workspaceBase;
        const fullPath = path.join(workspaceBase, 'shared', 'workspace', filePath);

        // Security: prevent path traversal
        const resolvedPath = path.resolve(fullPath);
        const allowedBase = path.resolve(path.join(workspaceBase, 'shared', 'workspace'));
        if (!resolvedPath.startsWith(allowedBase)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }

        try {
          const content = fs.readFileSync(resolvedPath);
          const ext = path.extname(filePath).toLowerCase();
          const mimeTypes = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.txt': 'text/plain',
          };
          const contentType = mimeTypes[ext] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(content);
        } catch (err) {
          if (err.code === 'ENOENT') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File not found');
          } else {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Server error');
          }
        }
        return;
      }

      // Root
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: 'Zeus AI Gateway',
        version: '1.0.0',
        websocket: `ws://localhost:${this.port}`,
        endpoints: [
          '/health',
          '/status',
          '/providers',
          '/processes',
          '/logs/:containerId',
          '/config/:provider (GET/POST)',
          '/serve/:filepath',
        ],
      }));
    });

    return this.httpServer;
  }

  // ============ LIFECYCLE ============

  async start() {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log('║     Zeus AI Gateway (Control Plane)    ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');

    // Clean up any orphaned containers from previous runs
    await this.containerManager.cleanupOrphanedContainers();

    // Start health checks
    this.containerManager.startHealthChecks();

    // Start servers
    this.setupHttpServer();
    this.setupWebSocket(this.httpServer);

    this.httpServer.listen(this.port, () => {
      console.log('');
      console.log('╔════════════════════════════════════════╗');
      console.log('║           Gateway Ready                ║');
      console.log('╚════════════════════════════════════════╝');
      console.log(`  HTTP:      http://localhost:${this.port}`);
      console.log(`  WebSocket: ws://localhost:${this.port}`);
      console.log(`  Session:   ${this.sessionId.slice(0, 8)}...`);
      console.log('');

      const status = this.containerManager.getStatus();
      console.log(`Containers: ${status.total} (healthy: ${status.byHealth.healthy})`);
      for (const [provider, info] of Object.entries(status.byProvider)) {
        console.log(`  - ${provider}: ${info.healthy}/${info.total} healthy`);
      }

      console.log('');
      console.log('Commands: spawn, stop, scale, chat, status');
      console.log('Waiting for connections... (Ctrl+C to stop)');
      console.log('');
    });
  }

  /**
   * Stop the gateway and cleanup all resources
   */
  async stop() {
    console.log('[Gateway] Stopping gateway...');

    // Close all client connections
    for (const client of this.clients.values()) {
      if (client.ws && client.ws.readyState === WebSocket.OPEN) {
        client.ws.close(1000, 'Gateway shutting down');
      }
    }

    // Close daemon connections
    for (const ws of this.daemonConnections.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }

    // Stop health checks and all containers
    await this.containerManager.cleanup();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise((resolve) => {
        this.httpServer.close(resolve);
      });
    }

    console.log('[Gateway] Goodbye!');
  }
}
