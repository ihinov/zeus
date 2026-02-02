/**
 * ClaudeDaemon - Claude Code CLI implementation
 *
 * Wraps Claude Code CLI for persistent daemon operation.
 * Uses session IDs to maintain conversation history.
 */

import { spawn } from 'node:child_process';
import { BaseDaemon } from './BaseDaemon.js';

const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';

// Available models
const AVAILABLE_MODELS = [
  'claude-opus-4-5-20250514',
  'claude-sonnet-4-5-20250514',
  'opus',
  'sonnet',
];

export class ClaudeDaemon extends BaseDaemon {
  constructor(options = {}) {
    const port = options.port || 3457;
    super({
      ...options,
      name: 'Claude Daemon v1.0.0',
      port,
      defaultModel: process.env.CLAUDE_MODEL || 'sonnet',
      availableModels: AVAILABLE_MODELS,
    });

    this.claudeVersion = '';
    this.isProcessing = false;
    this.currentProcess = null;

    // Session management - use provided session ID or generate one
    this.sessionId = options.sessionId || crypto.randomUUID();
    this.sessionInitialized = false; // Track if first message has been sent

    // System prompt customization
    this.systemPrompt = options.systemPrompt || null;
    this.appendSystemPrompt = options.appendSystemPrompt || null;
  }

  // ============ AUTHENTICATION ============

  async checkClaudeCli() {
    return new Promise((resolve) => {
      const proc = spawn(CLAUDE_CMD, ['--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          this.claudeVersion = output.trim();
          resolve(true);
        } else {
          resolve(false);
        }
      });

      proc.on('error', () => resolve(false));
    });
  }

  async authenticate() {
    // Check if Claude CLI is available
    console.log('[Auth] Checking for Claude Code CLI...');
    const cliAvailable = await this.checkClaudeCli();

    if (!cliAvailable) {
      console.error('[Error] Claude Code CLI not found!');
      console.error('Install from: https://claude.ai/code');
      throw new Error('Claude Code CLI not found');
    }

    console.log(`[Auth] Claude Code CLI found: ${this.claudeVersion}`);
    console.log(`[Auth] Using session ID: ${this.sessionId}`);

    return { authenticated: true };
  }

  // ============ INITIALIZATION ============

  async initialize(authResult) {
    console.log('[Config] Claude ready');
    console.log(`[Config] Default model: ${this.currentModel}`);
    console.log(`[Config] Session: ${this.sessionId}`);
  }

  // ============ CHAT ============

  async chat(message, options, sendEvent) {
    if (this.isProcessing) {
      throw new Error('Already processing a message');
    }

    this.isProcessing = true;
    const model = options.model || this.currentModel;

    console.log(`[Chat] Using model: ${model}`);
    console.log(`[Chat] Session: ${this.sessionId}`);

    return new Promise((resolve, reject) => {
      const args = [
        '-p', message,
        '--output-format', 'stream-json',
        '--model', model,
        '--verbose',
      ];

      // First message creates session, subsequent messages resume it
      if (!this.sessionInitialized) {
        args.push('--session-id', this.sessionId);
      } else {
        args.push('--resume', this.sessionId);
      }

      // Skip permissions for daemon operation
      if (options.skipPermissions !== false) {
        args.push('--dangerously-skip-permissions');
      }

      // Add allowed tools if specified
      if (options.allowedTools) {
        args.push('--allowedTools', ...options.allowedTools);
      }

      // Add working directory
      if (options.cwd) {
        args.push('--add-dir', options.cwd);
      }

      // System prompt customization
      if (options.systemPrompt || this.systemPrompt) {
        args.push('--system-prompt', options.systemPrompt || this.systemPrompt);
      } else if (options.appendSystemPrompt || this.appendSystemPrompt) {
        args.push('--append-system-prompt', options.appendSystemPrompt || this.appendSystemPrompt);
      }

      if (process.env.DEBUG === 'true') {
        console.log('[Claude] Spawning:', CLAUDE_CMD, args.join(' '));
      }

      this.currentProcess = spawn(CLAUDE_CMD, args, {
        env: { ...process.env },
        cwd: options.cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Close stdin immediately - Claude CLI doesn't need it with -p flag
      this.currentProcess.stdin.end();

      if (process.env.DEBUG === 'true') {
        console.log('[Claude] Process started, PID:', this.currentProcess.pid);
      }

      let fullText = '';
      let buffer = '';

      this.currentProcess.stdout.on('data', (data) => {
        const chunk = data.toString();
        if (process.env.DEBUG === 'true') {
          console.log('[Claude stdout chunk]', chunk.slice(0, 200));
        }
        buffer += chunk;

        // Process complete JSON lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const event = JSON.parse(line);
            if (process.env.DEBUG === 'true') {
              console.log('[Claude event]', event.type);
            }
            this.handleStreamEvent(event, sendEvent, (text) => {
              fullText += text;
            });
          } catch (err) {
            // Not JSON, might be raw output
            if (process.env.DEBUG === 'true') {
              console.log('[Claude raw]', line);
            }
          }
        }
      });

      this.currentProcess.stderr.on('data', (data) => {
        if (process.env.DEBUG === 'true') {
          console.log('[Claude stderr]', data.toString());
        }
      });

      this.currentProcess.on('close', (code) => {
        this.isProcessing = false;
        this.currentProcess = null;

        // Process any remaining buffer
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer);
            this.handleStreamEvent(event, sendEvent, (text) => {
              fullText += text;
            });
          } catch (err) {
            // Ignore
          }
        }

        if (code === 0) {
          this.sessionInitialized = true; // Mark session as active for --resume
          sendEvent('content', { text: fullText });
          sendEvent('done', {});
          resolve(fullText);
        } else {
          const error = new Error(`Claude exited with code ${code}`);
          sendEvent('error', { message: error.message });
          reject(error);
        }
      });

      this.currentProcess.on('error', (err) => {
        this.isProcessing = false;
        this.currentProcess = null;
        sendEvent('error', { message: err.message });
        reject(err);
      });
    });
  }

  /**
   * Handle stream-json events from Claude CLI
   */
  handleStreamEvent(event, sendEvent, appendText) {
    // Claude CLI stream-json format
    let type = event.type;

    // Unwrap stream_event wrapper
    if (type === 'stream_event' && event.event) {
      event = event.event;
      type = event.type;
    }

    switch (type) {
      case 'system':
        // System message, session info
        if (event.session_id) {
          this.sessionId = event.session_id;
        }
        break;

      case 'assistant':
        // Assistant message with embedded content
        sendEvent('streaming', {});
        // Extract content from the message object
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              appendText(block.text);
              sendEvent('content_delta', { text: block.text });
            }
          }
        }
        break;

      case 'content_block_start':
        // Content block started
        if (event.content_block?.type === 'thinking') {
          sendEvent('thinking', {});
        }
        break;

      case 'content_block_delta':
        // Incremental content
        const delta = event.delta;
        if (delta?.type === 'thinking_delta') {
          sendEvent('thought', { text: { subject: 'Thinking', description: delta.thinking } });
        } else if (delta?.type === 'text_delta') {
          const text = delta.text || '';
          appendText(text);
          sendEvent('content_delta', { text });
        }
        break;

      case 'content_block_stop':
        // Content block finished
        break;

      case 'message_start':
        sendEvent('streaming', {});
        break;

      case 'message_delta':
        // Message metadata update
        break;

      case 'message_stop':
        // Message complete
        break;

      case 'result':
        // Final result
        if (event.result) {
          appendText(event.result);
          sendEvent('content', { text: event.result });
        }
        break;

      default:
        if (process.env.DEBUG === 'true') {
          console.log('[Claude event]', type, event);
        }
    }
  }

  // ============ MODEL SWITCHING ============

  async switchModel(model) {
    // Accept both aliases and full model names
    const validModels = [...this.availableModels];

    if (!validModels.includes(model) && !model.startsWith('claude-')) {
      throw new Error(`Invalid model. Available: ${this.availableModels.join(', ')}`);
    }

    this.currentModel = model;
    console.log(`[Config] Model changed to: ${this.currentModel}`);
  }

  // ============ SESSION MANAGEMENT ============

  /**
   * Get current session ID
   */
  getSessionId() {
    return this.sessionId;
  }

  /**
   * Set session ID (for resuming conversations)
   */
  setSessionId(sessionId) {
    this.sessionId = sessionId;
    this.sessionInitialized = false; // Reset so next message creates the session
    console.log(`[Config] Session ID changed to: ${this.sessionId}`);
  }

  /**
   * Create a new session (fork from current)
   */
  newSession() {
    this.sessionId = crypto.randomUUID();
    this.sessionInitialized = false; // New session needs to be initialized
    console.log(`[Config] New session created: ${this.sessionId}`);
    return this.sessionId;
  }

  // ============ EXTRA STATUS ============

  getExtraStatus() {
    return {
      claudeVersion: this.claudeVersion,
      processing: this.isProcessing,
      sessionId: this.sessionId,
    };
  }

  // ============ ABORT ============

  abort() {
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
      this.isProcessing = false;
    }
  }
}
