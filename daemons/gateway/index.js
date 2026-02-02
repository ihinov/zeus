#!/usr/bin/env node
/**
 * Zeus AI Gateway - Entry point
 *
 * Usage:
 *   node gateway/index.js [port]
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
gateway.start().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
