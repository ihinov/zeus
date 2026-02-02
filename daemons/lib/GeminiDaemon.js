/**
 * GeminiDaemon - Gemini CLI implementation
 *
 * Wraps @google/gemini-cli-core for persistent daemon operation.
 * Uses Google OAuth or API key for authentication.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import {
  Config,
  AuthType,
  getOauthClient,
  GeminiEventType,
  DEFAULT_GEMINI_MODEL,
} from '@google/gemini-cli-core';
import { BaseDaemon } from './BaseDaemon.js';

// Paths for credentials
const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const OAUTH_CREDS_PATH = path.join(GEMINI_DIR, 'oauth_creds.json');
const API_KEY_PATH = path.join(GEMINI_DIR, 'api_key');

// Available models
const AVAILABLE_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
];

export class GeminiDaemon extends BaseDaemon {
  constructor(options = {}) {
    const port = options.port || 3456;
    super({
      ...options,
      name: 'Gemini Daemon v1.0.0',
      port,
      defaultModel: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
      availableModels: AVAILABLE_MODELS,
    });

    this.config = null;
    this.authResult = null;
  }

  // ============ AUTHENTICATION ============

  hasExistingCredentials() {
    if (process.env.GEMINI_API_KEY) {
      return { type: 'api_key', source: 'environment' };
    }

    if (fs.existsSync(API_KEY_PATH)) {
      try {
        const key = fs.readFileSync(API_KEY_PATH, 'utf8').trim();
        if (key) return { type: 'api_key', source: 'file' };
      } catch {}
    }

    if (fs.existsSync(OAUTH_CREDS_PATH)) {
      try {
        const creds = JSON.parse(fs.readFileSync(OAUTH_CREDS_PATH, 'utf8'));
        if (creds.refresh_token || creds.access_token) {
          return { type: 'oauth', source: 'file' };
        }
      } catch {}
    }

    return null;
  }

  prompt(question) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  async promptForAuthMethod() {
    console.log('');
    console.log('┌─────────────────────────────────────────┐');
    console.log('│         Authentication Required         │');
    console.log('├─────────────────────────────────────────┤');
    console.log('│  1. Login with Google (recommended)    │');
    console.log('│  2. Use Gemini API Key                 │');
    console.log('└─────────────────────────────────────────┘');
    console.log('');

    const choice = await this.prompt('Select option (1 or 2): ');
    return choice === '2' ? 'api_key' : 'oauth';
  }

  async promptForApiKey() {
    console.log('');
    console.log('Get your API key from: https://aistudio.google.com/apikey');
    console.log('');

    const apiKey = await this.prompt('Enter your Gemini API Key: ');
    if (!apiKey) throw new Error('API key is required');

    if (!fs.existsSync(GEMINI_DIR)) {
      fs.mkdirSync(GEMINI_DIR, { recursive: true });
    }
    fs.writeFileSync(API_KEY_PATH, apiKey, { mode: 0o600 });
    console.log('[Auth] API key saved to ~/.gemini/api_key');

    process.env.GEMINI_API_KEY = apiKey;
    return apiKey;
  }

  async authenticate() {
    const existing = this.hasExistingCredentials();

    if (existing) {
      if (existing.type === 'api_key') {
        if (existing.source === 'file' && !process.env.GEMINI_API_KEY) {
          process.env.GEMINI_API_KEY = fs.readFileSync(API_KEY_PATH, 'utf8').trim();
        }
        console.log(`[Auth] Using API key (from ${existing.source})`);
        return { type: AuthType.USE_GEMINI };
      }

      if (existing.type === 'oauth') {
        console.log('[Auth] Using saved Google credentials');
        try {
          const authConfig = {
            getProxy: () => process.env.HTTPS_PROXY || process.env.HTTP_PROXY || undefined,
            isBrowserLaunchSuppressed: () => process.env.NO_BROWSER === 'true',
          };

          const oauthClient = await getOauthClient(AuthType.LOGIN_WITH_GOOGLE, authConfig);
          if (oauthClient) {
            console.log('[Auth] OAuth authentication successful');
            return { type: AuthType.LOGIN_WITH_GOOGLE, client: oauthClient };
          }
        } catch (err) {
          console.log('[Auth] Saved credentials invalid, need to re-authenticate');
        }
      }
    }

    const authMethod = await this.promptForAuthMethod();

    if (authMethod === 'api_key') {
      await this.promptForApiKey();
      return { type: AuthType.USE_GEMINI };
    }

    console.log('');
    console.log('[Auth] Opening browser for Google login...');

    const authConfig = {
      getProxy: () => process.env.HTTPS_PROXY || process.env.HTTP_PROXY || undefined,
      isBrowserLaunchSuppressed: () => process.env.NO_BROWSER === 'true',
    };

    try {
      const oauthClient = await getOauthClient(AuthType.LOGIN_WITH_GOOGLE, authConfig);
      if (oauthClient) {
        console.log('[Auth] Google login successful!');
        return { type: AuthType.LOGIN_WITH_GOOGLE, client: oauthClient };
      }
    } catch (err) {
      console.error('[Auth] OAuth failed:', err.message);
      throw new Error('Authentication failed');
    }

    throw new Error('Authentication failed');
  }

  // ============ INITIALIZATION ============

  async initialize(authResult) {
    this.authResult = authResult;

    this.config = new Config({
      sessionId: this.sessionId,
      targetDir: process.cwd(),
      model: this.currentModel,
      interactive: false,
      debugMode: process.env.DEBUG === 'true',
      sandbox: undefined,
      checkpointing: false,
      mcpEnabled: false,
      extensionsEnabled: false,
      usageStatisticsEnabled: false,
      folderTrust: true,
    });

    await this.config.initialize();
    this.currentModel = this.config.getModel();
    console.log(`[Config] Initialized with model: ${this.currentModel}`);

    await this.config.refreshAuth(authResult.type);
    console.log('[Config] Auth refreshed, content generator ready');
  }

  // ============ CHAT ============

  async chat(message, options, sendEvent) {
    const client = this.config.getGeminiClient();

    if (!client || !client.isInitialized()) {
      throw new Error('Gemini client not initialized');
    }

    sendEvent('streaming', {});

    const abortController = new AbortController();
    const request = [{ text: message }];
    const promptId = `prompt-${Date.now()}`;

    const stream = client.sendMessageStream(request, abortController.signal, promptId);
    let fullText = '';

    for await (const event of stream) {
      switch (event.type) {
        case GeminiEventType.Content:
          const chunk = event.value || '';
          fullText += chunk;
          sendEvent('content_delta', { text: chunk });
          break;

        case GeminiEventType.Thought:
          sendEvent('thought', { text: event.value });
          break;

        case GeminiEventType.ToolCallRequest:
          sendEvent('tool_call', {
            id: event.value?.id,
            name: event.value?.name,
            args: event.value?.args,
          });
          break;

        case GeminiEventType.ToolCallResponse:
          sendEvent('tool_result', {
            id: event.value?.id,
            name: event.value?.name,
            result: event.value?.result,
          });
          break;

        case GeminiEventType.Error:
          sendEvent('error', {
            message: event.value?.message || String(event.value) || 'Unknown error',
          });
          break;

        case GeminiEventType.ChatCompressed:
          sendEvent('chat_compressed', {});
          break;

        case GeminiEventType.LoopDetected:
          sendEvent('warning', { message: 'Loop detected in conversation' });
          break;
      }
    }

    if (fullText) {
      sendEvent('content', { text: fullText });
    }

    sendEvent('done', {});
    return fullText;
  }

  // ============ MODEL SWITCHING ============

  async switchModel(model) {
    if (!this.availableModels.includes(model)) {
      throw new Error(`Invalid model. Available: ${this.availableModels.join(', ')}`);
    }

    console.log(`[Config] Switching model to: ${model}`);
    this.currentModel = model;

    // Reinitialize config with new model
    this.config = new Config({
      sessionId: this.sessionId,
      targetDir: process.cwd(),
      model: this.currentModel,
      interactive: false,
      debugMode: process.env.DEBUG === 'true',
      sandbox: undefined,
      checkpointing: false,
      mcpEnabled: false,
      extensionsEnabled: false,
      usageStatisticsEnabled: false,
      folderTrust: true,
    });

    await this.config.initialize();
    await this.config.refreshAuth(this.authResult.type);
    console.log(`[Config] Model switched to: ${this.currentModel}`);
  }
}
