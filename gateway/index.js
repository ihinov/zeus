#!/usr/bin/env node
/**
 * Zeus AI Gateway - Entry point
 * Interaction layer between clients and AI daemons
 *
 * Usage:
 *   node index.js [port]
 *
 * Environment variables:
 *   GATEWAY_PORT      - Gateway port (default: 3000)
 *   GEMINI_HOST       - Gemini daemon host (default: gemini-daemon)
 *   GEMINI_PORT       - Gemini daemon port (default: 3456)
 *   COPILOT_HOST      - Copilot daemon host (default: copilot-daemon)
 *   COPILOT_PORT      - Copilot daemon port (default: 3458)
 */

import { Gateway } from './Gateway.js';

const port = parseInt(process.argv[2]) || parseInt(process.env.GATEWAY_PORT) || 3001;

const daemons = {
  gemini: {
    host: process.env.GEMINI_HOST || 'gemini-daemon',
    port: parseInt(process.env.GEMINI_PORT) || 3456,
  },
  copilot: {
    host: process.env.COPILOT_HOST || 'copilot-daemon',
    port: parseInt(process.env.COPILOT_PORT) || 3458,
  },
};

const gateway = new Gateway({ port, daemons });

// Graceful shutdown handler
let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Gateway] Received ${signal}, shutting down...`);

  try {
    await gateway.stop();
    console.log('[Gateway] Cleanup complete');
    process.exit(0);
  } catch (err) {
    console.error('[Gateway] Error during shutdown:', err.message);
    process.exit(1);
  }
}

// Handle termination signals (terminal ctrl+c, kill, etc.)
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

// Handle uncaught exceptions
process.on('uncaughtException', async (err) => {
  console.error('[Gateway] Uncaught exception:', err);
  await shutdown('uncaughtException');
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('[Gateway] Unhandled rejection at:', promise, 'reason:', reason);
});

gateway.start().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
