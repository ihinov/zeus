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
    this.isProcessing = false; // Track busy/idle state
    this.currentModel = options.defaultModel || null;
    this.availableModels = options.availableModels || [];

    // Orchestration configuration
    this.systemPrompt = options.systemPrompt || null;
    this.appendSystemPrompt = options.appendSystemPrompt || null;
    this.allowedTools = options.allowedTools || null;

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

  // ============ SESSION MANAGEMENT (can be overridden) ============

  /**
   * Get current session ID
   * @returns {string} Current session ID
   */
  getSessionId() {
    return this.sessionId;
  }

  /**
   * Set session ID (for resuming conversations)
   * @param {string} sessionId - Session ID to use
   */
  setSessionId(sessionId) {
    this.sessionId = sessionId;
    console.log(`[Config] Session ID changed to: ${this.sessionId}`);
  }

  /**
   * Create a new session
   * @returns {string} New session ID
   */
  newSession() {
    this.sessionId = uuidv4();
    console.log(`[Config] New session created: ${this.sessionId}`);
    return this.sessionId;
  }

  // ============ SYSTEM PROMPT CONFIGURATION ============

  /**
   * Set system prompt (replaces existing)
   * @param {string} prompt - System prompt text
   */
  setSystemPrompt(prompt) {
    this.systemPrompt = prompt;
    this.appendSystemPrompt = null; // Clear append when setting full prompt
    console.log(`[Config] System prompt set (${prompt?.length || 0} chars)`);
  }

  /**
   * Set append system prompt (adds to default)
   * @param {string} prompt - Text to append to system prompt
   */
  setAppendSystemPrompt(prompt) {
    this.appendSystemPrompt = prompt;
    this.systemPrompt = null; // Clear full prompt when setting append
    console.log(`[Config] Append system prompt set (${prompt?.length || 0} chars)`);
  }

  /**
   * Get current system prompt configuration
   * @returns {object} System prompt config
   */
  getSystemPromptConfig() {
    return {
      systemPrompt: this.systemPrompt,
      appendSystemPrompt: this.appendSystemPrompt,
    };
  }

  // ============ TOOLS CONFIGURATION ============

  /**
   * Set allowed tools for the agent
   * @param {string[]} tools - Array of tool names
   */
  setAllowedTools(tools) {
    this.allowedTools = tools;
    console.log(`[Config] Allowed tools set:`, tools);
  }

  /**
   * Get current allowed tools
   * @returns {string[]|null} Allowed tools or null for all
   */
  getAllowedTools() {
    return this.allowedTools;
  }

  // ============ AGENT STATE ============

  /**
   * Get comprehensive agent state
   * @returns {object} Full agent state
   */
  getAgentState() {
    return {
      name: this.name,
      sessionId: this.sessionId,
      model: this.currentModel,
      availableModels: this.availableModels,
      isProcessing: this.isProcessing,
      isReady: this.isReady,
      isAuthenticated: this.isAuthenticated,
      systemPrompt: this.systemPrompt,
      appendSystemPrompt: this.appendSystemPrompt,
      allowedTools: this.allowedTools,
      uptime: process.uptime(),
      ...this.getExtraStatus(),
    };
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

        // ============ SESSION MANAGEMENT ============
        case 'new_session':
          const newSessionId = this.newSession();
          sendEvent('session_created', { sessionId: newSessionId });
          break;

        case 'set_session':
          const targetSessionId = parsed.payload?.sessionId || parsed.sessionId;
          if (!targetSessionId) {
            sendEvent('error', { message: 'sessionId required for set_session' });
            return;
          }
          this.setSessionId(targetSessionId);
          sendEvent('session_changed', { sessionId: this.sessionId });
          break;

        case 'get_session':
          sendEvent('session', { sessionId: this.getSessionId() });
          break;

        // ============ SYSTEM PROMPT ============
        case 'set_system_prompt':
          // Use ?? to allow empty strings (|| would treat '' as falsy)
          const sysPrompt = parsed.payload?.prompt ?? parsed.prompt;
          if (sysPrompt === undefined) {
            sendEvent('error', { message: 'prompt required for set_system_prompt' });
            return;
          }
          this.setSystemPrompt(sysPrompt);
          sendEvent('system_prompt_changed', this.getSystemPromptConfig());
          break;

        case 'set_append_system_prompt':
          // Use ?? to allow empty strings (|| would treat '' as falsy)
          const appendPrompt = parsed.payload?.prompt ?? parsed.prompt;
          if (appendPrompt === undefined) {
            sendEvent('error', { message: 'prompt required for set_append_system_prompt' });
            return;
          }
          this.setAppendSystemPrompt(appendPrompt);
          sendEvent('system_prompt_changed', this.getSystemPromptConfig());
          break;

        case 'get_system_prompt':
          sendEvent('system_prompt', this.getSystemPromptConfig());
          break;

        // ============ TOOLS CONFIGURATION ============
        case 'set_allowed_tools':
          // Check if 'tools' property exists in payload (allows null values)
          const tools = parsed.payload && 'tools' in parsed.payload
            ? parsed.payload.tools
            : parsed.tools;
          if (!Array.isArray(tools) && tools !== null) {
            sendEvent('error', { message: 'tools must be an array or null for set_allowed_tools' });
            return;
          }
          this.setAllowedTools(tools);
          sendEvent('allowed_tools_changed', { tools: this.getAllowedTools() });
          break;

        case 'get_allowed_tools':
          sendEvent('allowed_tools', { tools: this.getAllowedTools() });
          break;

        // ============ AGENT STATE ============
        case 'get_agent_state':
          sendEvent('agent_state', this.getAgentState());
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
