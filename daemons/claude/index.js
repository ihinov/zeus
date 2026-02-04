/**
 * ClaudeDaemon - Claude Code CLI implementation
 *
 * Wraps Claude Code CLI for persistent daemon operation.
 * Uses session IDs to maintain conversation history.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { BaseDaemon } from '../lib/BaseDaemon.js';

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
      systemPrompt: options.systemPrompt || null,
      appendSystemPrompt: options.appendSystemPrompt || null,
      allowedTools: options.allowedTools || null,
    });

    this.claudeVersion = '';
    this.currentProcess = null;

    // Session management - use provided session ID or use a deterministic one
    // Using a deterministic UUID allows sessions to persist across daemon restarts
    // Default UUID is a fixed value for Zeus Claude daemon
    this.sessionId = options.sessionId || process.env.CLAUDE_SESSION_ID || '00000000-0000-4000-8000-000000000001';
    this.sessionInitialized = false; // Track if first message has been sent
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
      // Set working directory - default to /workspace (user sandbox)
      const workingDir = options.cwd || process.env.WORKSPACE || '/workspace';

      const args = [
        '-p', message,
        '--output-format', 'stream-json',
        '--model', model,
        '--verbose',
      ];

      // Use --resume if session is initialized (we know it exists)
      // Otherwise use --session-id which creates a new session with that ID
      // After first successful message, sessionInitialized becomes true
      if (this.sessionInitialized) {
        args.push('--resume', this.sessionId);
      } else {
        // For persistent sessions, check if the session already exists
        // Session files are stored based on the working directory path
        // e.g., /workspace becomes -workspace, /app becomes -app
        const encodedPath = workingDir.replace(/\//g, '-');
        const sessionFile = `/home/zeus/.claude/projects/${encodedPath}/${this.sessionId}.jsonl`;
        const sessionExists = fs.existsSync(sessionFile);

        if (sessionExists) {
          args.push('--resume', this.sessionId);
          this.sessionInitialized = true; // Mark as initialized since session exists
        } else {
          args.push('--session-id', this.sessionId);
        }
      }

      // Skip permissions for daemon operation
      if (options.skipPermissions !== false) {
        args.push('--dangerously-skip-permissions');
      }

      // Add allowed tools if specified (from options or instance config)
      const toolsToUse = options.allowedTools || this.allowedTools;
      if (toolsToUse && Array.isArray(toolsToUse) && toolsToUse.length > 0) {
        args.push('--allowedTools', ...toolsToUse);
      }

      // Add working directory and public directory for web serving
      args.push('--add-dir', workingDir);

      // Add public directory for web serving if it exists
      const publicDir = process.env.PUBLIC_DIR || '/app/public';
      args.push('--add-dir', publicDir);

      // System prompt customization via file
      // Priority: 1) Dynamic config from gateway, 2) Options, 3) Instance config, 4) Default
      const promptsDir = process.env.PROMPTS_DIR || '/config/prompts';
      const dynamicPromptFile = `${promptsDir}/claude-system-prompt.txt`;
      const defaultPromptFile = '/app/claude/system-prompt.txt';

      let sysPromptFile = null;
      if (fs.existsSync(dynamicPromptFile)) {
        // Use dynamic prompt from gateway config
        sysPromptFile = dynamicPromptFile;
        console.log('[Chat] Using dynamic system prompt from gateway config');
      } else if (options.systemPromptFile) {
        sysPromptFile = options.systemPromptFile;
      } else if (this.systemPrompt) {
        sysPromptFile = this.systemPrompt;
      } else if (fs.existsSync(defaultPromptFile)) {
        // Fall back to baked-in default
        sysPromptFile = defaultPromptFile;
      }

      const appendSysPromptFile = options.appendSystemPromptFile || this.appendSystemPrompt;
      if (sysPromptFile) {
        args.push('--system-prompt-file', sysPromptFile);
      } else if (appendSysPromptFile) {
        args.push('--append-system-prompt-file', appendSysPromptFile);
      }

      if (process.env.DEBUG === 'true') {
        console.log('[Claude] Spawning:', CLAUDE_CMD, args.join(' '));
      }

      this.currentProcess = spawn(CLAUDE_CMD, args, {
        env: { ...process.env },
        cwd: workingDir,
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
            } else if (block.type === 'tool_use') {
              // Tool call - send to UI
              sendEvent('tool_call', {
                id: block.id,
                name: block.name,
                input: block.input,
              });
            }
          }
        }
        break;

      case 'user':
        // Tool result from previous tool call
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'tool_result') {
              sendEvent('tool_result', {
                id: block.tool_use_id,
                result: block.content,
                isError: block.is_error || false,
              });
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
        // Final result - text already accumulated from assistant event
        // Don't append again to avoid duplication
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

  // ============ SESSION MANAGEMENT (Override base class) ============

  /**
   * Set session ID (for resuming conversations)
   * Overrides base class to reset sessionInitialized flag
   */
  setSessionId(sessionId) {
    super.setSessionId(sessionId);
    this.sessionInitialized = false; // Reset so next message uses --session-id
  }

  /**
   * Create a new session (fork from current)
   * Overrides base class to reset sessionInitialized flag
   */
  newSession() {
    const newId = crypto.randomUUID();
    this.sessionId = newId;
    this.sessionInitialized = false; // New session needs --session-id
    console.log(`[Config] New session created: ${this.sessionId}`);
    return newId;
  }

  // ============ EXTRA STATUS ============

  getExtraStatus() {
    return {
      claudeVersion: this.claudeVersion,
      processing: this.isProcessing,
      sessionInitialized: this.sessionInitialized,
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

// ============ ENTRY POINT ============

// Run directly: node claude/index.js [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.argv[2]) || parseInt(process.env.PORT) || 3457;
  const daemon = new ClaudeDaemon({ port });
  daemon.start().catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
