# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Zeus - Persistent daemon wrappers for AI CLI tools (Gemini, Claude, Copilot) with a unified Gateway for orchestration.

## Git Workflow

- **New feature**: Always create a new branch and check it out before starting work
- **Finishing feature**: Commit and push the branch to GitHub
- **Merging**: NEVER merge to main/master unless the user explicitly says "merge with main/master"
- All feature branches must be pushed to GitHub

## Commands

```bash
# Install dependencies
cd daemons && npm install

# Start individual daemons
node daemons/daemon.js gemini [port]    # Default port 3456
node daemons/daemon.js claude [port]    # Default port 3457
node daemons/daemon.js copilot [port]   # Default port 3458

# Start with debug logging
DEBUG=true node daemons/daemon.js gemini

# Start the Gateway (orchestrates all daemons)
node daemons/gateway/index.js [port]    # Default port 3001

# NPM scripts (from daemons/)
npm run start:gemini
npm run start:copilot
npm run start:gateway
npm run dev:gemini      # With DEBUG=true
npm run dev:copilot
npm run dev:gateway
```

**Environment Variables:**
- `GEMINI_MODEL`, `CLAUDE_MODEL`, `COPILOT_MODEL` - Default models
- `GEMINI_API_KEY` - API key auth (or use OAuth)
- `DEBUG=true` - Enable verbose logging
- `PORT` - Dynamic port override

**Testing:**
```bash
npm test                # Gateway tests (fast, no auth required)
npm run test:claude     # Claude daemon + session tests
npm run test:gemini     # Gemini daemon + session tests
npm run test:copilot    # Copilot daemon + session tests
npm run test:session    # Session persistence tests only
npm run test:debug      # All tests with DEBUG=true
npm run test:integration # Gateway integration (spawns real daemons)
```

**Test Structure:**
- `test/helpers.js` - Utilities: startDaemon, startGateway, WSClient, httpGet
- `test/daemon.test.js` - HTTP endpoints, WebSocket protocol, chat, model switching
- `test/gateway.test.js` - Process management, routing, subscriptions, multi-client
- `test/session.test.js` - Context retention within sessions and across restarts

**Skip specific daemons:** `SKIP_GEMINI=1`, `SKIP_CLAUDE=1`, `SKIP_COPILOT=1`

## Architecture

```
daemons/
├── daemon.js              # Unified entry point - routes to specific daemon
├── lib/
│   ├── BaseDaemon.js      # Abstract base class (WebSocket/HTTP server, message routing)
│   ├── GeminiDaemon.js    # @google/gemini-cli-core wrapper
│   ├── ClaudeDaemon.js    # Claude Code CLI wrapper (spawn with --output-format stream-json)
│   └── CopilotDaemon.js   # GitHub Copilot CLI wrapper
└── gateway/
    ├── index.js           # Gateway entry point
    ├── Gateway.js         # Control plane: spawn/stop/scale daemons, route messages
    └── ProcessManager.js  # Lifecycle: port allocation, health checks, process spawning
```

**BaseDaemon Pattern:**
Subclasses implement 4 abstract methods:
- `authenticate()` - Service-specific auth (OAuth, API key, CLI check)
- `initialize(authResult)` - Post-auth setup
- `chat(message, options, sendEvent)` - Stream response via `sendEvent(type, payload)`
- `switchModel(model)` - Model switching

**WebSocket Protocol:**
```json
{ "type": "chat", "payload": { "text": "Hello", "model": "gpt-5" } }
{ "type": "set_model", "model": "gemini-3-pro-preview" }
{ "type": "list_models" }
{ "type": "status" }
{ "type": "ping" }
```

**Gateway extends this with:**
- `spawn`, `stop`, `scale` - Process lifecycle
- `subscribe`/`unsubscribe` - Event streaming
- Provider-based routing with load balancing

**Port Ranges:**
- 3456-3458: Default daemon ports
- 3001: Gateway default
- 4000-4100: Dynamic allocation pool (ProcessManager)
