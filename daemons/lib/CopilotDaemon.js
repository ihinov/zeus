/**
 * CopilotDaemon - GitHub Copilot CLI implementation
 *
 * Wraps Copilot CLI for persistent daemon operation.
 * Uses GitHub OAuth for authentication.
 */

import { spawn } from 'node:child_process';
import { BaseDaemon } from './BaseDaemon.js';

const COPILOT_CMD = process.env.COPILOT_CMD || 'copilot';

// Available models (from copilot --help)
const AVAILABLE_MODELS = [
  'claude-sonnet-4.5',
  'claude-haiku-4.5',
  'claude-opus-4.5',
  'claude-sonnet-4',
  'gemini-3-pro-preview',
  'gpt-5.2-codex',
  'gpt-5.2',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex',
  'gpt-5.1',
  'gpt-5',
  'gpt-5.1-codex-mini',
  'gpt-5-mini',
  'gpt-4.1',
];

export class CopilotDaemon extends BaseDaemon {
  constructor(options = {}) {
    const port = options.port || 3458;
    super({
      ...options,
      name: 'Copilot Daemon v1.0.0',
      port,
      defaultModel: process.env.COPILOT_MODEL || 'gpt-5',
      availableModels: AVAILABLE_MODELS,
    });

    this.copilotVersion = '';
    this.currentProcess = null;
  }

  // ============ AUTHENTICATION ============

  async checkCopilotCli() {
    return new Promise((resolve) => {
      const proc = spawn(COPILOT_CMD, ['--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          this.copilotVersion = output.trim();
          resolve(true);
        } else {
          resolve(false);
        }
      });

      proc.on('error', () => resolve(false));
    });
  }

  async checkAuth() {
    return new Promise((resolve) => {
      const proc = spawn(COPILOT_CMD, ['-p', 'hi', '-s', '--allow-all-tools'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      });

      let hasOutput = false;
      proc.stdout.on('data', () => {
        hasOutput = true;
      });

      proc.on('close', (code) => {
        resolve(code === 0 && hasOutput);
      });

      proc.on('error', () => resolve(false));

      setTimeout(() => {
        proc.kill();
        resolve(false);
      }, 10000);
    });
  }

  async authenticate() {
    // Check if Copilot CLI is available
    console.log('[Auth] Checking for Copilot CLI...');
    const cliAvailable = await this.checkCopilotCli();

    if (!cliAvailable) {
      console.error('[Error] Copilot CLI not found!');
      console.error('Install with: npm install -g @github/copilot');
      throw new Error('Copilot CLI not found');
    }

    console.log(`[Auth] Copilot CLI found: ${this.copilotVersion}`);

    // Check authentication
    console.log('[Auth] Checking GitHub authentication...');
    const authOk = await this.checkAuth();

    if (!authOk) {
      console.error('[Error] Copilot authentication failed!');
      console.error('Please run: copilot');
      console.error('And complete the GitHub login flow.');
      throw new Error('Copilot authentication failed');
    }

    return { authenticated: true };
  }

  // ============ INITIALIZATION ============

  async initialize(authResult) {
    console.log('[Config] Copilot ready');
    console.log(`[Config] Default model: ${this.currentModel}`);
  }

  // ============ CHAT ============

  async chat(message, options, sendEvent) {
    if (this.isProcessing) {
      throw new Error('Already processing a message');
    }

    this.isProcessing = true;
    const model = options.model || this.currentModel;

    console.log(`[Chat] Using model: ${model}`);

    return new Promise((resolve, reject) => {
      const args = [
        '-p', message,
        '-s',
        '--allow-all-tools',
        '--no-color',
        '--model', model,
      ];

      if (options.cwd) {
        args.push('--add-dir', options.cwd);
      }

      this.currentProcess = spawn(COPILOT_CMD, args, {
        env: { ...process.env },
        cwd: options.cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      sendEvent('streaming', {});

      let fullText = '';

      this.currentProcess.stdout.on('data', (data) => {
        const text = data.toString();
        fullText += text;
        sendEvent('content_delta', { text });
      });

      this.currentProcess.stderr.on('data', (data) => {
        if (process.env.DEBUG === 'true') {
          console.log('[Copilot stderr]', data.toString());
        }
      });

      this.currentProcess.on('close', (code) => {
        this.isProcessing = false;
        this.currentProcess = null;

        if (code === 0) {
          sendEvent('content', { text: fullText });
          sendEvent('done', {});
          resolve(fullText);
        } else {
          const error = new Error(`Copilot exited with code ${code}`);
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

  // ============ MODEL SWITCHING ============

  async switchModel(model) {
    if (!this.availableModels.includes(model)) {
      throw new Error(`Invalid model. Available: ${this.availableModels.join(', ')}`);
    }

    this.currentModel = model;
    console.log(`[Config] Model changed to: ${this.currentModel}`);
  }

  // ============ EXTRA STATUS ============

  getExtraStatus() {
    return {
      copilotVersion: this.copilotVersion,
      processing: this.isProcessing,
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
