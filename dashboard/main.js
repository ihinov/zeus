const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Disable GPU acceleration to fix errors on some Linux systems
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

let mainWindow;
let isQuitting = false;

// Daemon configs directory (each provider has its own folder)
const daemonsDir = path.join(__dirname, '..', 'daemons');

// Gateway always runs in container mode
const GATEWAY_MODE = 'container';

// Check if Docker is available
function checkDocker() {
  try {
    execSync('docker version', { stdio: 'pipe' });
    return true;
  } catch (err) {
    return false;
  }
}

// ============ CLI DETECTION ============

function checkCliInstalled(command) {
  return new Promise((resolve) => {
    const proc = spawn(command, ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let version = '';
    proc.stdout.on('data', (data) => {
      version += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        installed: code === 0,
        version: version.trim(),
      });
    });

    proc.on('error', () => {
      resolve({ installed: false, version: '' });
    });
  });
}

// IPC: Check all CLI tools
ipcMain.handle('check-cli-tools', async () => {
  const [claude, gemini, copilot] = await Promise.all([
    checkCliInstalled('claude'),
    checkCliInstalled('gemini'),
    checkCliInstalled('gh'), // GitHub CLI for Copilot
  ]);

  return {
    claude,
    gemini,
    copilot,
  };
});

// IPC: Get model options from config.yaml
ipcMain.handle('get-model-options', (event, daemonType) => {
  const configPath = path.join(daemonsDir, daemonType, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    // Extract models section using simple parsing
    const models = [];
    const lines = content.split('\n');
    let inModels = false;
    let currentModel = null;

    for (const line of lines) {
      if (line.trim() === 'models:') {
        inModels = true;
        continue;
      }
      if (inModels) {
        if (line.match(/^[a-z]/i) && line.includes(':')) {
          // New top-level key, exit models section
          break;
        }
        if (line.trim().startsWith('- id:')) {
          if (currentModel) models.push(currentModel);
          currentModel = { id: line.split(':')[1].trim() };
        } else if (currentModel && line.includes(':')) {
          const [key, ...valueParts] = line.trim().split(':');
          const value = valueParts.join(':').trim();
          if (key.trim() === 'name') currentModel.name = value;
          if (key.trim() === 'description') currentModel.description = value;
        }
      }
    }
    if (currentModel) models.push(currentModel);

    return models;
  } catch (e) {
    console.error(`Error reading models for ${daemonType}:`, e);
    return [];
  }
});

// ============ TEMPLATE MANAGEMENT ============

// Simple YAML parser (matches TemplateLoader.js)
function parseYaml(content) {
  const result = {};
  const lines = content.split('\n');
  const stack = [{ obj: result, indent: -1 }];
  let currentKey = null;
  let multilineValue = null;
  let multilineIndent = 0;

  for (const line of lines) {
    if (multilineValue === null) {
      if (line.trim().startsWith('#') || line.trim() === '') continue;
    }

    const indent = line.search(/\S/);

    if (multilineValue !== null) {
      if (indent > multilineIndent || line.trim() === '') {
        multilineValue.push(line.slice(multilineIndent + 2) || '');
        continue;
      } else {
        const parent = stack[stack.length - 1].obj;
        parent[currentKey] = multilineValue.join('\n').trim();
        multilineValue = null;
      }
    }

    if (line.trim() === '') continue;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].obj;
    const trimmed = line.trim();

    if (trimmed.startsWith('- ')) {
      const value = trimmed.slice(2).trim();
      if (!Array.isArray(parent[currentKey])) {
        parent[currentKey] = [];
      }
      parent[currentKey].push(value);
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      let value = trimmed.slice(colonIdx + 1).trim();

      if (value === '|') {
        currentKey = key;
        multilineValue = [];
        multilineIndent = indent;
        continue;
      }

      if (value === '' || value === null) {
        parent[key] = {};
        stack.push({ obj: parent[key], indent });
        currentKey = key;
        continue;
      }

      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (/^-?\d+$/.test(value)) value = parseInt(value, 10);
      else if (/^-?\d+\.\d+$/.test(value)) value = parseFloat(value);

      parent[key] = value;
      currentKey = key;
    }
  }

  return result;
}

// IPC: List available daemon configs
ipcMain.handle('list-templates', () => {
  const providers = ['claude', 'gemini', 'copilot'];
  const configs = [];

  for (const provider of providers) {
    const configPath = path.join(daemonsDir, provider, 'config.yaml');
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const parsed = parseYaml(content);

        // Load system prompt from file if specified
        if (parsed.systemPromptFile) {
          const promptPath = path.join(daemonsDir, provider, parsed.systemPromptFile);
          if (fs.existsSync(promptPath)) {
            parsed.systemPrompt = fs.readFileSync(promptPath, 'utf-8');
          }
        }

        configs.push({
          id: provider,
          provider,
          name: parsed.name || provider,
          description: parsed.description || '',
          icon: parsed.icon || provider.charAt(0).toUpperCase(),
          model: parsed.model || 'default',
          systemPrompt: parsed.systemPrompt || '',
        });
      } catch (e) {
        console.error(`Error parsing config for ${provider}:`, e);
      }
    }
  }

  return configs;
});

// IPC: Load a specific daemon config
ipcMain.handle('load-template', (event, provider) => {
  const configPath = path.join(daemonsDir, provider, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    return null;
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(content);

  // Load system prompt from file if specified
  if (parsed.systemPromptFile) {
    const promptPath = path.join(daemonsDir, provider, parsed.systemPromptFile);
    if (fs.existsSync(promptPath)) {
      parsed.systemPrompt = fs.readFileSync(promptPath, 'utf-8');
    }
  }

  return parsed;
});

// IPC: Get default config for provider
ipcMain.handle('get-default-template', (event, provider = 'claude') => {
  const configPath = path.join(daemonsDir, provider, 'config.yaml');

  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const parsed = parseYaml(content);

      // Load system prompt from file if specified
      if (parsed.systemPromptFile) {
        const promptPath = path.join(daemonsDir, provider, parsed.systemPromptFile);
        if (fs.existsSync(promptPath)) {
          parsed.systemPrompt = fs.readFileSync(promptPath, 'utf-8');
        }
      }

      return parsed;
    } catch (e) {
      console.error(`Error loading config for ${provider}:`, e);
    }
  }

  // Return minimal default
  return {
    name: `${provider.charAt(0).toUpperCase() + provider.slice(1)} Assistant`,
    provider,
    model: provider === 'claude' ? 'sonnet' : 'default',
    systemPrompt: 'You are a helpful AI assistant.',
  };
});

// IPC: Save daemon configuration
ipcMain.handle('save-daemon-config', async (event, config) => {
  const configDir = path.join(app.getPath('userData'), 'daemons');

  // Ensure config directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const configPath = path.join(configDir, `${config.id}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  return { success: true, path: configPath };
});

// IPC: Load all daemon configurations
ipcMain.handle('load-daemon-configs', async () => {
  const configDir = path.join(app.getPath('userData'), 'daemons');

  if (!fs.existsSync(configDir)) {
    return [];
  }

  const files = fs.readdirSync(configDir).filter(f => f.endsWith('.json'));
  const configs = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(configDir, file), 'utf-8');
      configs.push(JSON.parse(content));
    } catch (e) {
      console.error(`Error loading config ${file}:`, e);
    }
  }

  return configs;
});

// ============ GATEWAY INTEGRATION ============

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3001';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://localhost:3001';
const GATEWAY_HTTP_URL = process.env.GATEWAY_HTTP_URL || 'http://localhost:3001';

// IPC: Check if gateway is running
ipcMain.handle('check-gateway', async () => {
  try {
    const response = await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      const data = await response.json();
      return { running: true, mode: GATEWAY_MODE, ...data };
    }
    return { running: false, mode: GATEWAY_MODE };
  } catch (err) {
    return { running: false, mode: GATEWAY_MODE, error: err.message };
  }
});

// IPC: Get gateway mode
ipcMain.handle('get-gateway-mode', () => {
  return GATEWAY_MODE;
});

// IPC: Check Docker availability
ipcMain.handle('check-docker', () => {
  return checkDocker();
});

// IPC: Get gateway status (includes running daemons)
ipcMain.handle('get-gateway-status', async () => {
  try {
    const response = await fetch(`${GATEWAY_URL}/status`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      return await response.json();
    }
    return null;
  } catch (err) {
    return null;
  }
});

// IPC: Get running processes from gateway
ipcMain.handle('get-running-daemons', async () => {
  try {
    const response = await fetch(`${GATEWAY_URL}/processes`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      return await response.json();
    }
    return [];
  } catch (err) {
    return [];
  }
});

// Gateway process reference (managed by app lifecycle)
let gatewayProcess = null;

// IPC: Start the gateway (manual trigger if needed)
ipcMain.handle('start-gateway', async () => {
  return await startGatewayProcess();
});

// ============ CLEANUP & SHUTDOWN ============

// Stop all running daemons via gateway
async function stopAllDaemons() {
  console.log('[App] Stopping all daemons...');
  try {
    const WebSocket = require('ws');
    const ws = new WebSocket(GATEWAY_WS_URL);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve();
      }, 5000);

      ws.on('open', () => {
        // Stop all providers
        ws.send(JSON.stringify({ type: 'stop', payload: { provider: 'claude' } }));
        ws.send(JSON.stringify({ type: 'stop', payload: { provider: 'gemini' } }));
        ws.send(JSON.stringify({ type: 'stop', payload: { provider: 'copilot' } }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'stopped') {
          console.log('[App] Stopped:', msg.payload);
        }
      });

      // Give it a moment to process stops
      setTimeout(() => {
        clearTimeout(timeout);
        ws.close();
        resolve();
      }, 2000);

      ws.on('error', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  } catch (err) {
    console.error('[App] Error stopping daemons:', err.message);
  }
}

// Force stop any orphaned Zeus containers (container mode)
function forceStopContainers() {
  if (GATEWAY_MODE !== 'container') return;

  console.log('[App] Force stopping Zeus containers...');
  try {
    // Find and stop all zeus-* containers
    const containers = execSync('docker ps -q --filter "name=zeus-"', { encoding: 'utf-8' }).trim();
    if (containers) {
      execSync(`docker stop ${containers.split('\n').join(' ')}`, { timeout: 10000 });
      console.log('[App] Containers stopped');
    }
  } catch (err) {
    // Ignore errors - containers might already be stopped
  }
}

// Send shutdown progress to renderer
function sendShutdownProgress(step, message) {
  console.log(`[App] ${message}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shutdown-progress', { step, message });
  }
}

// Full cleanup with progress reporting
async function cleanup(withProgress = false) {
  if (isQuitting) return;
  isQuitting = true;

  if (withProgress) {
    sendShutdownProgress(1, 'Shutting down...');
  }

  console.log('[App] Cleaning up...');

  // First try graceful shutdown via gateway
  if (withProgress) sendShutdownProgress(2, 'Stopping daemons...');
  await stopAllDaemons();

  // Force stop any remaining containers
  if (withProgress) sendShutdownProgress(3, 'Stopping containers...');
  forceStopContainers();

  // Stop gateway process
  if (gatewayProcess && !gatewayProcess.killed) {
    if (withProgress) sendShutdownProgress(4, 'Stopping gateway...');
    console.log('[App] Stopping gateway...');
    gatewayProcess.kill('SIGTERM');

    // Give it a moment, then force kill
    await new Promise(resolve => {
      setTimeout(() => {
        if (gatewayProcess && !gatewayProcess.killed) {
          gatewayProcess.kill('SIGKILL');
        }
        resolve();
      }, 1000);
    });
  }

  if (withProgress) sendShutdownProgress(5, 'Cleanup complete');
}

// Cleanup on app quit
app.on('before-quit', async (event) => {
  if (!isQuitting) {
    event.preventDefault();
    await cleanup();
    app.quit();
  }
});

app.on('will-quit', () => {
  // Final force cleanup
  forceStopContainers();
  if (gatewayProcess && !gatewayProcess.killed) {
    gatewayProcess.kill('SIGKILL');
  }
});

// IPC: Stop all daemons
ipcMain.handle('stop-all-daemons', async () => {
  await stopAllDaemons();
  return { success: true };
});

// IPC: Stop a daemon via gateway
ipcMain.handle('stop-daemon', async (event, { processId, provider }) => {
  try {
    const WebSocket = require('ws');
    const ws = new WebSocket(GATEWAY_WS_URL);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Stop timeout'));
      }, 10000);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'stop',
          payload: { processId, provider },
        }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'stopped') {
          clearTimeout(timeout);
          ws.close();
          resolve({ success: true });
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          ws.close();
          resolve({ success: false, error: msg.payload.message });
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: Update daemon config and restart
ipcMain.handle('update-daemon-config', async (event, config) => {
  const configDir = path.join(app.getPath('userData'), 'daemons');

  // Ensure config directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const configPath = path.join(configDir, `${config.id}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  return { success: true, path: configPath };
});

// IPC: Update Gateway config (system prompt) and restart daemon
ipcMain.handle('update-gateway-config', async (event, { provider, systemPrompt, restart = true }) => {
  try {
    const response = await fetch(`${GATEWAY_HTTP_URL}/config/${provider}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt, restart }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to update config');
    }

    return await response.json();
  } catch (err) {
    console.error('[IPC] Failed to update gateway config:', err);
    return { success: false, error: err.message };
  }
});

// IPC: Get Gateway config (current system prompt)
ipcMain.handle('get-gateway-config', async (event, provider) => {
  try {
    const response = await fetch(`${GATEWAY_HTTP_URL}/config/${provider}`);
    if (!response.ok) {
      throw new Error('Failed to get config');
    }
    return await response.json();
  } catch (err) {
    console.error('[IPC] Failed to get gateway config:', err);
    return { provider, systemPrompt: null, error: err.message };
  }
});

// IPC: Delete daemon config
ipcMain.handle('delete-daemon-config', async (event, configId) => {
  const configDir = path.join(app.getPath('userData'), 'daemons');
  const configPath = path.join(configDir, `${configId}.json`);

  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
    return { success: true };
  }
  return { success: false, error: 'Config not found' };
});

// IPC: Spawn a daemon via gateway
ipcMain.handle('spawn-daemon', async (event, { provider, model }) => {
  try {
    // Connect via WebSocket to spawn
    const WebSocket = require('ws');
    const ws = new WebSocket(GATEWAY_WS_URL);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Spawn timeout'));
      }, 30000);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'spawn',
          payload: { provider, model },
        }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'spawned') {
          clearTimeout(timeout);
          ws.close();
          resolve({ success: true, process: msg.payload });
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          ws.close();
          resolve({ success: false, error: msg.payload.message });
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    transparent: false,
    backgroundColor: '#0d0d14',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Track maximize state
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-maximized', true);
  });

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-maximized', false);
  });
}

// Window control handlers
ipcMain.on('window-minimize', () => {
  mainWindow?.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});

ipcMain.on('window-close', async () => {
  // Don't immediately close - show shutdown screen and cleanup first
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('show-shutdown-screen');
  }

  // Perform cleanup with progress
  await cleanup(true);

  // Now actually quit
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shutdown-complete');
  }

  // Small delay to show completion, then quit
  setTimeout(() => {
    app.quit();
  }, 500);
});

app.whenReady().then(async () => {
  createWindow();

  // Auto-start gateway when app starts
  console.log('[App] Starting gateway...');
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('app-starting');
  });

  await startGatewayProcess();
});

// Kill any process using a specific port
function killProcessOnPort(port) {
  try {
    // Find process using the port
    const result = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' }).trim();
    if (result) {
      const pids = result.split('\n');
      for (const pid of pids) {
        if (pid) {
          console.log(`[App] Killing process ${pid} on port ${port}`);
          try {
            execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
          } catch (e) {
            // Process might already be dead
          }
        }
      }
      return true;
    }
  } catch (err) {
    // No process on port
  }
  return false;
}

// Start gateway process
async function startGatewayProcess() {
  if (gatewayProcess && !gatewayProcess.killed) {
    return { success: true, pid: gatewayProcess.pid, mode: GATEWAY_MODE };
  }

  // Check if gateway is already running (from previous session)
  try {
    const response = await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      console.log('[App] Gateway already running, reusing existing instance');
      if (mainWindow) {
        mainWindow.webContents.send('gateway-ready', { mode: GATEWAY_MODE });
      }
      return { success: true, mode: GATEWAY_MODE, reused: true };
    }
  } catch (e) {
    // Gateway not responding, might be a stale process - kill it
    console.log('[App] Checking for stale gateway process...');
    if (killProcessOnPort(3001)) {
      console.log('[App] Killed stale process on port 3001');
      // Wait a moment for port to be released
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Check Docker availability for container mode
  if (GATEWAY_MODE === 'container' && !checkDocker()) {
    console.error('[App] Docker not available, falling back to process mode');
    // Could fall back to process mode here if needed
  }

  const gatewayPath = path.join(__dirname, '..', 'gateway', 'index.js');

  try {
    // Set environment for gateway
    const env = {
      ...process.env,
      GATEWAY_MODE: GATEWAY_MODE,
      DEBUG: process.env.DEBUG || 'false',
    };

    console.log(`[App] Starting gateway in ${GATEWAY_MODE} mode...`);

    gatewayProcess = spawn('node', [gatewayPath], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.dirname(gatewayPath),
      env,
    });

    gatewayProcess.stdout.on('data', (data) => {
      const output = data.toString().trim();
      if (process.env.DEBUG || output.includes('Ready') || output.includes('Error')) {
        console.log('[Gateway]', output);
      }
    });
    gatewayProcess.stderr.on('data', (data) => {
      console.error('[Gateway]', data.toString().trim());
    });

    gatewayProcess.on('close', (code) => {
      console.log(`[Gateway] Exited with code ${code}`);
      gatewayProcess = null;

      // If gateway crashes and we're not quitting, notify the UI
      if (!isQuitting && mainWindow) {
        mainWindow.webContents.send('gateway-failed');
      }
    });

    // Wait for gateway to be ready (longer timeout for container mode)
    const maxAttempts = GATEWAY_MODE === 'container' ? 30 : 15;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const response = await fetch(`${GATEWAY_URL}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          const data = await response.json();
          console.log(`[App] Gateway started successfully (mode: ${GATEWAY_MODE})`);
          if (mainWindow) {
            mainWindow.webContents.send('gateway-ready', { mode: GATEWAY_MODE });
          }
          return { success: true, pid: gatewayProcess.pid, mode: GATEWAY_MODE };
        }
      } catch (e) {
        // Keep waiting
      }
    }

    console.error('[App] Gateway failed to start in time');
    if (mainWindow) {
      mainWindow.webContents.send('gateway-failed');
    }
    return { success: false, error: 'Gateway did not start in time' };
  } catch (err) {
    console.error('[App] Gateway start error:', err);
    return { success: false, error: err.message };
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// ============ SESSIONS ============

// Sessions are stored in the user data directory
function getSessionsDir() {
  const sessionsDir = path.join(app.getPath('userData'), 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }
  return sessionsDir;
}

function getSessionPath(sessionId) {
  return path.join(getSessionsDir(), `${sessionId}.json`);
}

// IPC: Get all sessions
ipcMain.handle('get-sessions', async () => {
  const sessionsDir = getSessionsDir();
  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
  const sessions = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
      const session = JSON.parse(content);
      // Don't include messages in the list (just metadata)
      sessions.push({
        id: session.id,
        title: session.title,
        preview: session.preview,
        provider: session.provider,
        model: session.model,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages?.length || 0,
      });
    } catch (e) {
      console.error(`Error loading session ${file}:`, e);
    }
  }

  // Sort by updatedAt (most recent first)
  sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return sessions;
});

// IPC: Create a new session
ipcMain.handle('create-session', async (event, { provider, model }) => {
  const sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date().toISOString();

  const session = {
    id: sessionId,
    title: 'New conversation',
    preview: 'New conversation',
    provider,
    model,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };

  const sessionPath = getSessionPath(sessionId);
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));

  return {
    id: session.id,
    title: session.title,
    preview: session.preview,
    provider: session.provider,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: 0,
  };
});

// IPC: Get session history (messages)
ipcMain.handle('get-session-history', async (event, sessionId) => {
  const sessionPath = getSessionPath(sessionId);

  if (!fs.existsSync(sessionPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(sessionPath, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    console.error(`Error loading session ${sessionId}:`, e);
    return null;
  }
});

// IPC: Save a message to a session
ipcMain.handle('save-session-message', async (event, { sessionId, message }) => {
  const sessionPath = getSessionPath(sessionId);

  if (!fs.existsSync(sessionPath)) {
    return { success: false, error: 'Session not found' };
  }

  try {
    const content = fs.readFileSync(sessionPath, 'utf-8');
    const session = JSON.parse(content);

    // Add message
    session.messages.push({
      ...message,
      timestamp: new Date().toISOString(),
    });

    // Update preview (first user message or last message content)
    if (message.role === 'user' && session.messages.filter(m => m.role === 'user').length === 1) {
      session.title = message.content.slice(0, 50) + (message.content.length > 50 ? '...' : '');
      session.preview = session.title;
    }

    session.updatedAt = new Date().toISOString();

    fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
    return { success: true };
  } catch (e) {
    console.error(`Error saving message to session ${sessionId}:`, e);
    return { success: false, error: e.message };
  }
});

// IPC: Delete a session
ipcMain.handle('delete-session', async (event, sessionId) => {
  const sessionPath = getSessionPath(sessionId);

  if (fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
    return { success: true };
  }
  return { success: false, error: 'Session not found' };
});
