/**
 * Daemon Tests
 *
 * Tests common daemon functionality across all daemon types.
 * Run with: node --test test/daemon.test.js
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  startDaemon,
  stopProcess,
  WSClient,
  httpGet,
  getPort,
  sleep,
} from './helpers.js';

// Test configuration - which daemons to test
// Set environment variable to skip unavailable daemons
// e.g., SKIP_GEMINI=1 SKIP_COPILOT=1 node --test test/daemon.test.js
const DAEMON_TYPES = ['gemini', 'claude', 'copilot'].filter((type) => {
  return !process.env[`SKIP_${type.toUpperCase()}`];
});

for (const daemonType of DAEMON_TYPES) {
  describe(`${daemonType} daemon`, () => {
    let daemon;
    let port;

    before(async () => {
      port = getPort();
      console.log(`Starting ${daemonType} daemon on port ${port}...`);
      try {
        daemon = await startDaemon(daemonType, port, {
          timeout: 60000, // Auth can take time
          debug: process.env.DEBUG === 'true',
        });
        console.log(`${daemonType} daemon started`);
      } catch (err) {
        console.error(`Failed to start ${daemonType}:`, err.message);
        throw err;
      }
    });

    after(async () => {
      if (daemon?.proc) {
        await stopProcess(daemon.proc);
        console.log(`${daemonType} daemon stopped`);
      }
    });

    // ==================== HTTP ENDPOINT TESTS ====================

    describe('HTTP endpoints', () => {
      it('GET / returns service info', async () => {
        const { status, data } = await httpGet(`http://localhost:${port}/`);
        assert.strictEqual(status, 200);
        assert.ok(data.name, 'Should have name');
        assert.ok(data.websocket, 'Should have websocket URL');
        assert.ok(Array.isArray(data.endpoints), 'Should have endpoints array');
      });

      it('GET /health returns health status', async () => {
        const { status, data } = await httpGet(`http://localhost:${port}/health`);
        assert.strictEqual(status, 200);
        assert.strictEqual(data.status, 'ok');
        assert.strictEqual(data.ready, true);
        assert.strictEqual(data.authenticated, true);
        assert.ok(typeof data.uptime === 'number', 'Should have uptime');
      });

      it('GET /status returns full status', async () => {
        const { status, data } = await httpGet(`http://localhost:${port}/status`);
        assert.strictEqual(status, 200);
        assert.ok(data.name, 'Should have name');
        assert.ok(data.sessionId, 'Should have sessionId');
        assert.ok(data.model, 'Should have model');
        assert.strictEqual(data.ready, true);
        assert.strictEqual(data.authenticated, true);
        assert.ok(typeof data.uptime === 'number', 'Should have uptime');
      });

      it('GET /models returns available models', async () => {
        const { status, data } = await httpGet(`http://localhost:${port}/models`);
        assert.strictEqual(status, 200);
        assert.ok(Array.isArray(data.models), 'Should have models array');
        assert.ok(data.models.length > 0, 'Should have at least one model');
        assert.ok(data.current, 'Should have current model');
      });
    });

    // ==================== WEBSOCKET TESTS ====================

    describe('WebSocket connection', () => {
      let client;

      beforeEach(() => {
        client = new WSClient(`ws://localhost:${port}`);
      });

      after(() => {
        if (client) client.close();
      });

      it('connects and receives connected event', async () => {
        await client.connect();
        const msg = await client.waitForType('connected', 2000);

        assert.ok(msg.payload, 'Should have payload');
        assert.ok(msg.payload.name, 'Should have name');
        assert.ok(msg.payload.sessionId, 'Should have sessionId');
        assert.ok(msg.payload.model, 'Should have model');
        assert.ok(Array.isArray(msg.payload.availableModels), 'Should have availableModels');

        client.close();
      });

      it('ping returns pong', async () => {
        await client.connect();
        await client.waitForType('connected');

        client.send({ type: 'ping' });
        const msg = await client.waitForType('pong', 2000);

        assert.ok(msg.payload.timestamp, 'Should have timestamp');

        client.close();
      });

      it('status returns daemon status', async () => {
        await client.connect();
        await client.waitForType('connected');

        client.send({ type: 'status' });
        const msg = await client.waitForType('status', 2000);

        assert.ok(msg.payload.name, 'Should have name');
        assert.strictEqual(msg.payload.ready, true);
        assert.strictEqual(msg.payload.authenticated, true);
        assert.ok(msg.payload.model, 'Should have model');

        client.close();
      });

      it('list_models returns models', async () => {
        await client.connect();
        await client.waitForType('connected');

        client.send({ type: 'list_models' });
        const msg = await client.waitForType('models', 2000);

        assert.ok(Array.isArray(msg.payload.models), 'Should have models array');
        assert.ok(msg.payload.current, 'Should have current model');

        client.close();
      });

      it('unknown message type returns error', async () => {
        await client.connect();
        await client.waitForType('connected');

        client.send({ type: 'invalid_type_xyz' });
        const msg = await client.waitForType('error', 2000);

        assert.ok(msg.payload.message.includes('Unknown'), 'Should mention unknown type');

        client.close();
      });

      it('invalid JSON returns error', async () => {
        await client.connect();
        await client.waitForType('connected');

        client.ws.send('not valid json {{{');
        const msg = await client.waitForType('error', 2000);

        assert.ok(msg.payload.message.includes('Invalid JSON'), 'Should mention invalid JSON');

        client.close();
      });
    });

    // ==================== CHAT TESTS ====================

    describe('chat', () => {
      let client;

      beforeEach(async () => {
        client = new WSClient(`ws://localhost:${port}`);
        await client.connect();
        await client.waitForType('connected');
        client.clearMessages();
      });

      afterEach(() => {
        if (client) client.close();
      });

      it('sends a message and receives streaming response', async () => {
        client.send({
          type: 'chat',
          payload: { text: 'Say "hello" and nothing else.' },
        });

        const events = await client.collectChatResponse(60000);
        const types = events.map((e) => e.type);

        // Should have thinking or streaming event
        assert.ok(
          types.includes('thinking') || types.includes('streaming'),
          `Should have thinking or streaming event, got: ${types.join(', ')}`
        );

        // Should have content_delta or content
        assert.ok(
          types.includes('content_delta') || types.includes('content'),
          `Should have content_delta or content, got: ${types.join(', ')}`
        );

        // Should end with done
        assert.strictEqual(types[types.length - 1], 'done', 'Should end with done');
      });

      it('empty message returns error', async () => {
        client.send({
          type: 'chat',
          payload: { text: '' },
        });

        const msg = await client.waitForType('error', 5000);
        assert.ok(msg.payload.message, 'Should have error message');
      });

      it('missing text returns error', async () => {
        client.send({
          type: 'chat',
          payload: {},
        });

        const msg = await client.waitForType('error', 5000);
        assert.ok(msg.payload.message, 'Should have error message');
      });
    });

    // ==================== MODEL SWITCHING TESTS ====================

    describe('model switching', () => {
      let client;

      beforeEach(async () => {
        client = new WSClient(`ws://localhost:${port}`);
        await client.connect();
        await client.waitForType('connected');
        client.clearMessages();
      });

      afterEach(() => {
        if (client) client.close();
      });

      it('set_model with invalid model returns error', async () => {
        client.send({
          type: 'set_model',
          model: 'invalid-model-that-does-not-exist',
        });

        const msg = await client.waitForType('error', 5000);
        assert.ok(msg.payload.message.includes('Invalid'), 'Should mention invalid model');
      });

      // Valid model test is daemon-specific (different available models)
    });
  });
}

// ==================== DAEMON-SPECIFIC TESTS ====================

if (!process.env.SKIP_GEMINI) {
  describe('gemini-specific', () => {
    let daemon;
    let port;
    let client;

    before(async () => {
      port = getPort();
      daemon = await startDaemon('gemini', port, { timeout: 60000 });
    });

    after(async () => {
      if (client) client.close();
      if (daemon?.proc) await stopProcess(daemon.proc);
    });

    it('can switch to a valid Gemini model', async () => {
      client = new WSClient(`ws://localhost:${port}`);
      await client.connect();
      await client.waitForType('connected');
      client.clearMessages();

      client.send({ type: 'set_model', model: 'gemini-2.5-flash' });
      const msg = await client.waitForType('model_changed', 10000);

      assert.strictEqual(msg.payload.model, 'gemini-2.5-flash');
    });
  });
}

if (!process.env.SKIP_CLAUDE) {
  describe('claude-specific', () => {
    let daemon;
    let port;
    let client;

    before(async () => {
      port = getPort();
      daemon = await startDaemon('claude', port, { timeout: 60000 });
    });

    after(async () => {
      if (client) client.close();
      if (daemon?.proc) await stopProcess(daemon.proc);
    });

    it('can switch to a valid Claude model', async () => {
      client = new WSClient(`ws://localhost:${port}`);
      await client.connect();
      await client.waitForType('connected');
      client.clearMessages();

      client.send({ type: 'set_model', model: 'sonnet' });
      const msg = await client.waitForType('model_changed', 10000);

      assert.ok(msg.payload.model.includes('sonnet') || msg.payload.model === 'sonnet');
    });

    it('status includes sessionId', async () => {
      client = new WSClient(`ws://localhost:${port}`);
      await client.connect();
      await client.waitForType('connected');
      client.clearMessages();

      client.send({ type: 'status' });
      const msg = await client.waitForType('status', 2000);

      assert.ok(msg.payload.sessionId, 'Should have sessionId');
    });
  });
}

if (!process.env.SKIP_COPILOT) {
  describe('copilot-specific', () => {
    let daemon;
    let port;
    let client;

    before(async () => {
      port = getPort();
      daemon = await startDaemon('copilot', port, { timeout: 60000 });
    });

    after(async () => {
      if (client) client.close();
      if (daemon?.proc) await stopProcess(daemon.proc);
    });

    it('can switch to a valid Copilot model', async () => {
      client = new WSClient(`ws://localhost:${port}`);
      await client.connect();
      await client.waitForType('connected');
      client.clearMessages();

      client.send({ type: 'set_model', model: 'gpt-5' });
      const msg = await client.waitForType('model_changed', 10000);

      assert.strictEqual(msg.payload.model, 'gpt-5');
    });

    it('status includes copilotVersion', async () => {
      client = new WSClient(`ws://localhost:${port}`);
      await client.connect();
      await client.waitForType('connected');
      client.clearMessages();

      client.send({ type: 'status' });
      const msg = await client.waitForType('status', 2000);

      assert.ok(msg.payload.copilotVersion, 'Should have copilotVersion');
    });
  });
}
