/**
 * BaseDaemon - Common interface for AI daemon implementations
 *
 * Provides WebSocket/HTTP server, message routing, and lifecycle management.
 * Subclasses implement the AI-specific logic.
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';

export class BaseDaemon {
  constructor(options = {}) {
    this.name = options.name || 'ai-daemon';
    this.port = options.port || 3456;
    this.sessionId = uuidv4();

    this.isReady = false;
    this.isAuthenticated = false;
    this.currentModel = options.defaultModel || null;
    this.availableModels = options.availableModels || [];

    this.httpServer = null;
    this.wss = null;
    this.sessions = new Map(); // clientId -> session state
  }

  // ============ ABSTRACT METHODS (must be implemented by subclasses) ============

  /**
   * Authenticate with the AI service
   * @returns {Promise<any>} Auth result to be stored
   */
  async authenticate() {
    throw new Error('authenticate() must be implemented');
  }

  /**
   * Initialize the AI client after authentication
   * @param {any} authResult - Result from authenticate()
   */
  async initialize(authResult) {
    throw new Error('initialize() must be implemented');
  }

  /**
   * Send a chat message and stream the response
   * @param {string} message - User message
   * @param {object} options - Options (model, cwd, etc.)
   * @param {function} sendEvent - Callback to send events
   * @returns {Promise<string>} Full response text
   */
  async chat(message, options, sendEvent) {
    throw new Error('chat() must be implemented');
  }

  /**
   * Switch to a different model
   * @param {string} model - Model name
   */
  async switchModel(model) {
    throw new Error('switchModel() must be implemented');
  }

  /**
   * Get daemon-specific info for status
   * @returns {object} Additional status fields
   */
  getExtraStatus() {
    return {};
  }

  // ============ COMMON IMPLEMENTATION ============

  /**
   * Send a WebSocket event
   */
  sendEvent(ws, type, payload) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type, payload }));
    }
  }

  /**
   * Handle incoming WebSocket message
   */
  async handleMessage(ws, message, clientId) {
    const sendEvent = (type, payload) => this.sendEvent(ws, type, payload);

    try {
      const parsed = JSON.parse(message.toString());

      switch (parsed.type) {
        case 'chat':
          const userMessage = parsed.payload?.text || parsed.payload || parsed.text || parsed.message;
          if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
            sendEvent('error', { message: 'Invalid or empty message' });
            return;
          }

          console.log(`[Chat] Received: "${userMessage.slice(0, 60)}${userMessage.length > 60 ? '...' : ''}"`);
          sendEvent('thinking', {});

          try {
            await this.chat(userMessage, {
              model: parsed.payload?.model || parsed.model,
              cwd: parsed.payload?.cwd || parsed.cwd,
            }, sendEvent);
            console.log('[Chat] Response complete');
          } catch (err) {
            console.error('[Chat] Error:', err.message);
            sendEvent('error', { message: err.message });
          }
          break;

        case 'set_model':
          const newModel = parsed.payload?.model || parsed.model;
          try {
            await this.switchModel(newModel);
            sendEvent('model_changed', { model: this.currentModel });
          } catch (err) {
            sendEvent('error', { message: err.message });
          }
          break;

        case 'list_models':
          sendEvent('models', {
            models: this.availableModels,
            current: this.currentModel,
          });
          break;

        case 'ping':
          sendEvent('pong', { timestamp: Date.now() });
          break;

        case 'status':
          sendEvent('status', {
            name: this.name,
            ready: this.isReady,
            authenticated: this.isAuthenticated,
            model: this.currentModel,
            availableModels: this.availableModels,
            sessionId: this.sessionId,
            uptime: process.uptime(),
            ...this.getExtraStatus(),
          });
          break;

        default:
          console.log(`[WS] Unknown message type: ${parsed.type}`);
          sendEvent('error', { message: `Unknown message type: ${parsed.type}` });
      }
    } catch (err) {
      console.error('[WS] Message parse error:', err.message);
      sendEvent('error', { message: 'Invalid JSON message' });
    }
  }

  /**
   * Set up WebSocket server
   */
  setupWebSocket(server) {
    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws) => {
      const clientId = uuidv4().slice(0, 8);
      console.log(`[WS] Client connected: ${clientId}`);

      // Send connected event
      this.sendEvent(ws, 'connected', {
        name: this.name,
        sessionId: this.sessionId,
        model: this.currentModel,
        availableModels: this.availableModels,
        ready: this.isReady,
        authenticated: this.isAuthenticated,
      });

      ws.on('message', (data) => this.handleMessage(ws, data, clientId));

      ws.on('close', () => {
        console.log(`[WS] Client disconnected: ${clientId}`);
        this.sessions.delete(clientId);
      });

      ws.on('error', (err) => {
        console.error(`[WS] Error (${clientId}):`, err.message);
      });
    });

    return this.wss;
  }

  /**
   * Set up HTTP server
   */
  setupHttpServer() {
    this.httpServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          ready: this.isReady,
          authenticated: this.isAuthenticated,
          uptime: process.uptime(),
        }));
        return;
      }

      if (url.pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name: this.name,
          version: '1.0.0',
          sessionId: this.sessionId,
          model: this.currentModel,
          ready: this.isReady,
          authenticated: this.isAuthenticated,
          uptime: process.uptime(),
          port: this.port,
          ...this.getExtraStatus(),
        }));
        return;
      }

      if (url.pathname === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: this.availableModels,
          current: this.currentModel,
        }));
        return;
      }

      // Root
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: this.name,
        websocket: `ws://localhost:${this.port}`,
        endpoints: ['/health', '/status', '/models'],
      }));
    });

    return this.httpServer;
  }

  /**
   * Start the daemon
   */
  async start() {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log(`║  ${this.name.padEnd(36)}  ║`);
    console.log('╚════════════════════════════════════════╝');
    console.log('');

    try {
      // Step 1: Authenticate
      console.log('[Startup] Authenticating...');
      const authResult = await this.authenticate();
      this.isAuthenticated = true;
      console.log('[Startup] ✓ Authenticated');

      // Step 2: Initialize
      console.log('[Startup] Initializing...');
      await this.initialize(authResult);
      this.isReady = true;
      console.log('[Startup] ✓ Initialized');

      // Set up servers
      this.setupHttpServer();
      this.setupWebSocket(this.httpServer);

      // Start listening
      this.httpServer.listen(this.port, () => {
        console.log('');
        console.log('╔════════════════════════════════════════╗');
        console.log('║            Daemon Ready                ║');
        console.log('╚════════════════════════════════════════╝');
        console.log(`  HTTP:      http://localhost:${this.port}`);
        console.log(`  WebSocket: ws://localhost:${this.port}`);
        console.log(`  Model:     ${this.currentModel}`);
        console.log(`  Session:   ${this.sessionId.slice(0, 8)}...`);
        console.log('');
        console.log('Waiting for connections... (Ctrl+C to stop)');
        console.log('');
      });

      // Graceful shutdown
      const shutdown = () => {
        console.log('\n[Shutdown] Stopping daemon...');
        this.wss.close();
        this.httpServer.close(() => {
          console.log('[Shutdown] Goodbye!');
          process.exit(0);
        });
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

    } catch (err) {
      console.error('');
      console.error('[Fatal Error]', err.message);
      if (process.env.DEBUG === 'true') {
        console.error(err.stack);
      }
      console.error('');
      process.exit(1);
    }
  }
}
