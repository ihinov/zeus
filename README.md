# Zeus

Persistent daemon wrappers for AI CLI tools with a unified gateway for orchestration.

Zeus keeps AI assistants (Gemini, Claude, Copilot) running as long-lived processes, eliminating cold-start latency and enabling WebSocket-based streaming communication. The Gateway provides centralized control for spawning, scaling, and routing requests across multiple AI providers.

## Features

- **Persistent Sessions**: Maintain conversation context across requests
- **WebSocket Streaming**: Real-time token streaming with structured events
- **Multi-Provider Support**: Gemini, Claude Code, and GitHub Copilot
- **Unified Gateway**: Spawn, stop, and scale daemons dynamically
- **Load Balancing**: Route requests across multiple instances of the same provider
- **Health Monitoring**: Automatic health checks with configurable intervals

## Quick Start

```bash
cd daemons
npm install

# Start a single daemon
node daemon.js gemini

# Or start the gateway to manage all daemons
node gateway/index.js
```

## Daemons

Each daemon wraps a specific AI CLI tool and exposes it via HTTP and WebSocket.

| Daemon  | Default Port | CLI Dependency |
|---------|--------------|----------------|
| Gemini  | 3456 | `@google/gemini-cli-core` (bundled) |
| Claude  | 3457 | `claude` CLI installed globally |
| Copilot | 3458 | `copilot` CLI installed globally |

### Starting a Daemon

```bash
# Basic usage
node daemon.js <type> [port]

# Examples
node daemon.js gemini          # Start Gemini on port 3456
node daemon.js claude 4000     # Start Claude on port 4000
node daemon.js copilot         # Start Copilot on port 3458

# With environment variables
GEMINI_MODEL=gemini-3-pro-preview node daemon.js gemini
DEBUG=true node daemon.js copilot
```

### HTTP Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Service info and WebSocket URL |
| `GET /health` | Health check (ready, authenticated, uptime) |
| `GET /status` | Full daemon status |
| `GET /models` | Available models and current selection |

### WebSocket Protocol

Connect to `ws://localhost:<port>` and send JSON messages:

```javascript
// Send a chat message
{ "type": "chat", "payload": { "text": "Hello!", "model": "gpt-5" } }

// Switch models
{ "type": "set_model", "model": "gemini-3-pro-preview" }

// Query available models
{ "type": "list_models" }

// Get status
{ "type": "status" }

// Ping
{ "type": "ping" }
```

Response events streamed back:

| Event | Description |
|-------|-------------|
| `connected` | Initial connection with session info |
| `thinking` | Model is processing |
| `streaming` | Response stream started |
| `content_delta` | Incremental text chunk |
| `content` | Full response text |
| `done` | Response complete |
| `error` | Error occurred |
| `model_changed` | Model switch confirmed |
| `models` | List of available models |

## Gateway

The Gateway is a control plane for managing multiple daemon processes. It handles spawning, stopping, health monitoring, and request routing.

```bash
node gateway/index.js [port]   # Default: 3001
```

### Gateway WebSocket Commands

```javascript
// Spawn a new daemon
{ "type": "spawn", "payload": { "provider": "gemini", "model": "gemini-3-pro-preview" } }

// Stop a daemon
{ "type": "stop", "payload": { "processId": "gemini-4000" } }
{ "type": "stop", "payload": { "provider": "gemini" } }  // Stop all of a provider

// Scale to N instances
{ "type": "scale", "payload": { "provider": "copilot", "count": 3 } }

// Chat (auto-routes to healthy instance)
{ "type": "chat", "payload": { "provider": "gemini", "text": "Hello" } }

// List processes
{ "type": "list_processes" }
{ "type": "list_providers" }

// Subscribe to events from a process or provider
{ "type": "subscribe", "payload": { "processId": "gemini-4000" } }
{ "type": "subscribe", "payload": { "provider": "copilot" } }
```

### Gateway HTTP Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Gateway info |
| `GET /health` | Gateway health |
| `GET /status` | Full status including all processes |
| `GET /providers` | Provider summary with health counts |
| `GET /processes?provider=gemini` | List processes (optionally filtered) |

## Authentication

### Gemini

Gemini supports two authentication methods:

1. **Google OAuth** (recommended): Run the daemon and follow the browser login flow
2. **API Key**: Set `GEMINI_API_KEY` environment variable or save to `~/.gemini/api_key`

### Claude

Requires the Claude Code CLI to be installed and authenticated:

```bash
# Install Claude Code CLI from https://claude.ai/code
# Then authenticate by running it once
claude
```

### Copilot

Requires the GitHub Copilot CLI to be installed and authenticated:

```bash
npm install -g @github/copilot
copilot  # Complete GitHub login flow
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GEMINI_MODEL` | Default Gemini model |
| `CLAUDE_MODEL` | Default Claude model |
| `COPILOT_MODEL` | Default Copilot model |
| `GEMINI_API_KEY` | Gemini API key (alternative to OAuth) |
| `DEBUG` | Set to `true` for verbose logging |
| `PORT` | Override default port |
| `GATEWAY_PORT` | Gateway port (default: 3001) |

## Available Models

### Gemini
- `gemini-2.5-pro`, `gemini-2.5-flash`
- `gemini-3-pro-preview`, `gemini-3-flash-preview`

### Claude
- `opus`, `sonnet` (aliases)
- `claude-opus-4-5-20250514`, `claude-sonnet-4-5-20250514`

### Copilot
- `gpt-5`, `gpt-5.1`, `gpt-5.2`, `gpt-5-mini`
- `gpt-5.1-codex`, `gpt-5.2-codex`, `gpt-5.1-codex-max`
- `claude-sonnet-4`, `claude-sonnet-4.5`, `claude-opus-4.5`, `claude-haiku-4.5`
- `gemini-3-pro-preview`

## Testing

```bash
cd daemons

# Run gateway tests (fast, no auth required)
npm test

# Run tests for a specific daemon
npm run test:gemini
npm run test:claude
npm run test:copilot

# Run all daemon tests (requires all CLIs installed)
npm run test:daemon

# Run session persistence tests
npm run test:session

# Run with debug output
npm run test:debug

# Integration tests (spawns daemons via gateway)
npm run test:integration
```

**Test structure:**
- `test/daemon.test.js` - HTTP endpoints, WebSocket protocol, chat, model switching
- `test/gateway.test.js` - Process management, routing, subscriptions, multi-client
- `test/session.test.js` - Context retention within and across sessions
- `test/helpers.js` - Test utilities (startDaemon, WSClient, etc.)

## License

MIT
