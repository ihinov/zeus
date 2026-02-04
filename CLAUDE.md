# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Zeus - Persistent daemon wrappers for AI CLI tools (Gemini, Claude, Copilot) with a unified Gateway for orchestration via Docker containers, and an Electron Dashboard for management.

## Git Workflow

- **New feature**: Always create a new branch and check it out before starting work
- **Finishing feature**: Commit and push the branch to GitHub
- **Merging**: NEVER merge to main/master unless the user explicitly says "merge with main/master"
- All feature branches must be pushed to GitHub

## Commands

```bash
# Install dependencies
cd daemons && npm install
cd gateway && npm install
cd dashboard && npm install

# Start individual daemons directly
node daemons/claude/index.js [port]    # Default port 3457
node daemons/gemini/index.js [port]    # Default port 3456
node daemons/copilot/index.js [port]   # Default port 3458

# Start with debug logging
DEBUG=true node daemons/claude/index.js

# Start the Gateway (Docker-based orchestration)
node gateway/index.js [port]           # Default port 3001

# Start the Dashboard (Electron app)
cd dashboard && npm start
```

**Environment Variables:**
- `GEMINI_MODEL`, `CLAUDE_MODEL`, `COPILOT_MODEL` - Default models
- `GEMINI_API_KEY` - API key auth (or use OAuth)
- `DEBUG=true` - Enable verbose logging
- `PORT` - Dynamic port override

**Testing:**
```bash
# From daemons/
npm test                # Daemon tests
npm run test:claude     # Claude daemon + session tests
npm run test:gemini     # Gemini daemon + session tests
npm run test:copilot    # Copilot daemon + session tests
npm run test:session    # Session persistence tests only
npm run test:debug      # All tests with DEBUG=true
```

**Skip specific daemons:** `SKIP_GEMINI=1`, `SKIP_CLAUDE=1`, `SKIP_COPILOT=1`

## Architecture

```
zeus/
├── daemons/                   # AI CLI daemon wrappers
│   ├── lib/
│   │   └── BaseDaemon.js      # Abstract base class (WebSocket/HTTP server)
│   ├── claude/
│   │   ├── index.js           # ClaudeDaemon (directly runnable)
│   │   ├── config.yaml        # Default config template
│   │   └── system-prompt.txt  # Default system prompt
│   ├── gemini/
│   │   ├── index.js           # GeminiDaemon
│   │   ├── config.yaml
│   │   └── system-prompt.txt
│   ├── copilot/
│   │   ├── index.js           # CopilotDaemon
│   │   ├── config.yaml
│   │   └── system-prompt.txt
│   └── test/                  # Daemon tests
│
├── gateway/                   # Docker-based orchestration
│   ├── index.js               # Gateway entry point
│   ├── Gateway.js             # Control plane: spawn/stop containers, route messages
│   └── ContainerManager.js    # Docker lifecycle: port allocation, health checks
│
└── dashboard/                 # Electron dashboard app
    ├── main.js                # Electron main process
    └── index.html             # UI
```

**BaseDaemon Pattern:**
Subclasses implement 4 abstract methods:
- `authenticate()` - Service-specific auth (OAuth, API key, CLI check)
- `initialize(authResult)` - Post-auth setup
- `chat(message, options, sendEvent)` - Stream response via `sendEvent(type, payload)`
- `switchModel(model)` - Model switching

**Daemon Config (config.yaml):**
```yaml
name: Claude Assistant
provider: claude
model: sonnet
models:
  - id: sonnet
    name: Claude Sonnet
    description: Fast and capable
systemPromptFile: system-prompt.txt
```

**WebSocket Protocol:**
```json
{ "type": "chat", "payload": { "text": "Hello", "model": "sonnet" } }
{ "type": "set_model", "model": "opus" }
{ "type": "set_system_prompt", "payload": { "prompt": "You are..." } }
{ "type": "list_models" }
{ "type": "status" }
{ "type": "ping" }
```

**Gateway Commands:**
- `spawn`, `stop`, `scale` - Container lifecycle
- `subscribe`/`unsubscribe` - Event streaming
- Provider-based routing with load balancing

**Port Ranges:**
- 3456-3458: Default daemon ports
- 3001: Gateway default
- 4000-4100: Dynamic allocation pool (ContainerManager)
