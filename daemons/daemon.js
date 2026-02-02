#!/usr/bin/env node
/**
 * Zeus AI Daemon - Unified entry point
 *
 * Usage:
 *   node daemon.js gemini [port]    # Start Gemini daemon (default port 3456)
 *   node daemon.js copilot [port]   # Start Copilot daemon (default port 3458)
 *   node daemon.js --help           # Show help
 *
 * Environment variables:
 *   GEMINI_MODEL   - Default model for Gemini (e.g., gemini-2.5-pro)
 *   COPILOT_MODEL  - Default model for Copilot (e.g., gpt-5)
 *   DEBUG=true     - Enable debug logging
 */

import { GeminiDaemon } from './lib/GeminiDaemon.js';
import { CopilotDaemon } from './lib/CopilotDaemon.js';
import { ClaudeDaemon } from './lib/ClaudeDaemon.js';

const args = process.argv.slice(2);

// Support PORT environment variable for dynamic port assignment
const envPort = parseInt(process.env.PORT) || undefined;

function showHelp() {
  console.log(`
Zeus AI Daemon - Unified entry point for AI CLI daemons

Usage:
  node daemon.js <type> [port]

Types:
  gemini    Start Gemini daemon (Google OAuth, default port 3456)
  claude    Start Claude daemon (Claude Code CLI, default port 3457)
  copilot   Start Copilot daemon (GitHub OAuth, default port 3458)

Options:
  --help    Show this help message

Environment Variables:
  GEMINI_MODEL    Default model for Gemini (e.g., gemini-2.5-pro, gemini-3-pro-preview)
  CLAUDE_MODEL    Default model for Claude (e.g., sonnet, opus)
  COPILOT_MODEL   Default model for Copilot (e.g., gpt-5, claude-sonnet-4)
  DEBUG=true      Enable debug logging

Examples:
  node daemon.js gemini           # Start Gemini on port 3456
  node daemon.js copilot 4000     # Start Copilot on port 4000
  GEMINI_MODEL=gemini-3-pro-preview node daemon.js gemini

WebSocket Protocol:
  { type: 'chat', payload: { text: 'Hello', model: 'gpt-5' } }
  { type: 'set_model', model: 'gpt-5' }
  { type: 'list_models' }
  { type: 'status' }
  { type: 'ping' }

HTTP Endpoints:
  GET /health   - Health check
  GET /status   - Daemon status
  GET /models   - Available models
`);
}

async function main() {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    showHelp();
    process.exit(0);
  }

  const daemonType = args[0]?.toLowerCase();
  // Priority: command line arg > PORT env var > default
  const port = parseInt(args[1]) || envPort;

  let daemon;

  switch (daemonType) {
    case 'gemini':
      daemon = new GeminiDaemon({ port });
      break;

    case 'claude':
      daemon = new ClaudeDaemon({ port });
      break;

    case 'copilot':
      daemon = new CopilotDaemon({ port });
      break;

    default:
      console.error(`Unknown daemon type: ${daemonType}`);
      console.error('Use "gemini", "claude", or "copilot"');
      process.exit(1);
  }

  await daemon.start();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
