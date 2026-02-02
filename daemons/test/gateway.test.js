/**
 * Gateway Tests
 *
 * Tests the Gateway control plane functionality.
 * Run with: node --test test/gateway.test.js
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  startGateway,
  stopProcess,
  WSClient,
  httpGet,
  getPort,
  sleep,
} from './helpers.js';

describe('Gateway', () => {
  let gateway;
  let gatewayPort;

  before(async () => {
    gatewayPort = getPort();
    console.log(`Starting gateway on port ${gatewayPort}...`);
    gateway = await startGateway(gatewayPort, {
      debug: process.env.DEBUG === 'true',
    });
    console.log('Gateway started');
  });

  after(async () => {
    if (gateway?.proc) {
      await stopProcess(gateway.proc);
      console.log('Gateway stopped');
    }
  });

  // ==================== HTTP ENDPOINT TESTS ====================

  describe('HTTP endpoints', () => {
    it('GET / returns UI or gateway info', async () => {
      const res = await fetch(`http://localhost:${gatewayPort}/`);
      assert.strictEqual(res.status, 200);
      const contentType = res.headers.get('content-type');
      // Gateway serves HTML UI at root, or JSON fallback if no UI
      assert.ok(
        contentType.includes('text/html') || contentType.includes('application/json'),
        `Should return HTML or JSON, got: ${contentType}`
      );
    });

    it('GET /health returns health status', async () => {
      const { status, data } = await httpGet(`http://localhost:${gatewayPort}/health`);
      assert.strictEqual(status, 200);
      assert.strictEqual(data.status, 'ok');
      assert.ok(typeof data.uptime === 'number', 'Should have uptime');
    });

    it('GET /status returns full status', async () => {
      const { status, data } = await httpGet(`http://localhost:${gatewayPort}/status`);
      assert.strictEqual(status, 200);
      assert.ok(data.gateway, 'Should have gateway info');
      assert.ok(data.gateway.sessionId, 'Should have sessionId');
      assert.ok(data.processes, 'Should have processes info');
      assert.ok(data.providers, 'Should have providers info');
    });

    it('GET /providers returns provider summary', async () => {
      const { status, data } = await httpGet(`http://localhost:${gatewayPort}/providers`);
      assert.strictEqual(status, 200);
      assert.ok(data.gemini !== undefined, 'Should have gemini provider');
      assert.ok(data.claude !== undefined, 'Should have claude provider');
      assert.ok(data.copilot !== undefined, 'Should have copilot provider');
    });

    it('GET /processes returns empty list initially', async () => {
      const { status, data } = await httpGet(`http://localhost:${gatewayPort}/processes`);
      assert.strictEqual(status, 200);
      assert.ok(Array.isArray(data), 'Should be an array');
    });
  });

  // ==================== WEBSOCKET TESTS ====================

  describe('WebSocket connection', () => {
    let client;

    afterEach(() => {
      if (client) client.close();
    });

    it('connects and receives connected event', async () => {
      client = new WSClient(`ws://localhost:${gatewayPort}`);
      await client.connect();

      const msg = await client.waitForType('connected', 2000);
      assert.ok(msg.payload, 'Should have payload');
      assert.ok(msg.payload.sessionId, 'Should have sessionId');
      assert.ok(msg.payload.clientId, 'Should have clientId');
      assert.ok(msg.payload.providers, 'Should have providers');
    });

    it('ping returns pong', async () => {
      client = new WSClient(`ws://localhost:${gatewayPort}`);
      await client.connect();
      await client.waitForType('connected');

      client.send({ type: 'ping' });
      const msg = await client.waitForType('pong', 2000);

      assert.ok(msg.payload.timestamp, 'Should have timestamp');
    });

    it('status returns full gateway status', async () => {
      client = new WSClient(`ws://localhost:${gatewayPort}`);
      await client.connect();
      await client.waitForType('connected');
      client.clearMessages();

      client.send({ type: 'status' });
      const msg = await client.waitForType('status', 2000);

      assert.ok(msg.payload.gateway, 'Should have gateway info');
      assert.ok(msg.payload.processes, 'Should have processes');
      assert.ok(msg.payload.providers, 'Should have providers');
    });

    it('list_processes returns process list', async () => {
      client = new WSClient(`ws://localhost:${gatewayPort}`);
      await client.connect();
      await client.waitForType('connected');
      client.clearMessages();

      client.send({ type: 'list_processes' });
      const msg = await client.waitForType('processes', 2000);

      assert.ok(Array.isArray(msg.payload), 'Should be an array');
    });

    it('list_providers returns provider info', async () => {
      client = new WSClient(`ws://localhost:${gatewayPort}`);
      await client.connect();
      await client.waitForType('connected');
      client.clearMessages();

      client.send({ type: 'list_providers' });
      const msg = await client.waitForType('providers', 2000);

      assert.ok(msg.payload.gemini !== undefined, 'Should have gemini');
      assert.ok(msg.payload.claude !== undefined, 'Should have claude');
      assert.ok(msg.payload.copilot !== undefined, 'Should have copilot');
    });

    it('unknown message type returns error', async () => {
      client = new WSClient(`ws://localhost:${gatewayPort}`);
      await client.connect();
      await client.waitForType('connected');
      client.clearMessages();

      client.send({ type: 'invalid_message_type' });
      const msg = await client.waitForType('error', 2000);

      assert.ok(msg.payload.message.includes('Unknown'), 'Should mention unknown type');
    });
  });

  // ==================== SPAWN/STOP TESTS ====================

  describe('process management', () => {
    let client;

    beforeEach(async () => {
      client = new WSClient(`ws://localhost:${gatewayPort}`);
      await client.connect();
      await client.waitForType('connected');
      client.clearMessages();
    });

    afterEach(async () => {
      // Cleanup: stop any spawned processes
      client.send({ type: 'stop', payload: { provider: 'gemini' } });
      client.send({ type: 'stop', payload: { provider: 'claude' } });
      client.send({ type: 'stop', payload: { provider: 'copilot' } });
      await sleep(1000);
      client.close();
    });

    it('spawn with invalid provider returns error', async () => {
      client.send({
        type: 'spawn',
        payload: { provider: 'invalid_provider' },
      });

      const msg = await client.waitForType('error', 5000);
      assert.ok(msg.payload.message.includes('Unknown provider') || msg.payload.message.includes('Spawn failed'));
    });

    it('stop with no processId or provider returns error', async () => {
      client.send({
        type: 'stop',
        payload: {},
      });

      const msg = await client.waitForType('error', 2000);
      assert.ok(msg.payload.message.includes('processId or provider required'));
    });

    it('scale with missing parameters returns error', async () => {
      client.send({
        type: 'scale',
        payload: { provider: 'gemini' }, // missing count
      });

      const msg = await client.waitForType('error', 2000);
      assert.ok(msg.payload.message.includes('provider and count required'));
    });

    it('set_model with missing parameters returns error', async () => {
      client.send({
        type: 'set_model',
        payload: { model: 'gpt-5' }, // missing processId
      });

      const msg = await client.waitForType('error', 2000);
      assert.ok(msg.payload.message.includes('processId and model required'));
    });

    it('chat with no healthy process returns error', async () => {
      client.send({
        type: 'chat',
        payload: { provider: 'gemini', text: 'Hello' },
      });

      const msg = await client.waitForType('error', 5000);
      assert.ok(msg.payload.message.includes('No healthy'));
    });
  });

  // ==================== SUBSCRIPTION TESTS ====================

  describe('subscriptions', () => {
    let client;

    beforeEach(async () => {
      client = new WSClient(`ws://localhost:${gatewayPort}`);
      await client.connect();
      await client.waitForType('connected');
      client.clearMessages();
    });

    afterEach(() => {
      if (client) client.close();
    });

    it('subscribe with no processId or provider returns error', async () => {
      client.send({
        type: 'subscribe',
        payload: {},
      });

      const msg = await client.waitForType('error', 2000);
      assert.ok(msg.payload.message.includes('processId or provider required'));
    });

    it('subscribe to provider works', async () => {
      client.send({
        type: 'subscribe',
        payload: { provider: 'gemini' },
      });

      const msg = await client.waitForType('subscribed', 2000);
      assert.strictEqual(msg.payload.provider, 'gemini');
    });

    it('list_subscriptions returns empty initially', async () => {
      client.send({ type: 'list_subscriptions' });
      const msg = await client.waitForType('subscriptions', 2000);

      assert.ok(Array.isArray(msg.payload.processes), 'Should have processes array');
      assert.ok(Array.isArray(msg.payload.providers), 'Should have providers array');
    });

    it('unsubscribe from provider works', async () => {
      // First subscribe
      client.send({ type: 'subscribe', payload: { provider: 'copilot' } });
      await client.waitForType('subscribed', 2000);
      client.clearMessages();

      // Then unsubscribe
      client.send({ type: 'unsubscribe', payload: { provider: 'copilot' } });
      const msg = await client.waitForType('unsubscribed', 2000);

      assert.strictEqual(msg.payload.provider, 'copilot');
    });

    it('unsubscribe all works', async () => {
      // Subscribe to multiple
      client.send({ type: 'subscribe', payload: { provider: 'gemini' } });
      client.send({ type: 'subscribe', payload: { provider: 'copilot' } });
      await sleep(500);
      client.clearMessages();

      // Unsubscribe all
      client.send({ type: 'unsubscribe', payload: { all: true } });
      const msg = await client.waitForType('unsubscribed', 2000);

      assert.strictEqual(msg.payload.all, true);
    });
  });

  // ==================== MULTI-CLIENT TESTS ====================

  describe('multi-client', () => {
    it('multiple clients can connect', async () => {
      const client1 = new WSClient(`ws://localhost:${gatewayPort}`);
      const client2 = new WSClient(`ws://localhost:${gatewayPort}`);

      await client1.connect();
      await client2.connect();

      const msg1 = await client1.waitForType('connected', 2000);
      const msg2 = await client2.waitForType('connected', 2000);

      // Each client gets unique clientId
      assert.ok(msg1.payload.clientId, 'Client 1 should have clientId');
      assert.ok(msg2.payload.clientId, 'Client 2 should have clientId');
      assert.notStrictEqual(msg1.payload.clientId, msg2.payload.clientId, 'Client IDs should be different');

      client1.close();
      client2.close();
    });

    it('clients receive independent responses', async () => {
      const client1 = new WSClient(`ws://localhost:${gatewayPort}`);
      const client2 = new WSClient(`ws://localhost:${gatewayPort}`);

      await client1.connect();
      await client2.connect();
      await client1.waitForType('connected');
      await client2.waitForType('connected');

      client1.clearMessages();
      client2.clearMessages();

      // Each client sends ping
      client1.send({ type: 'ping' });
      client2.send({ type: 'ping' });

      // Each should get their own pong
      const pong1 = await client1.waitForType('pong', 2000);
      const pong2 = await client2.waitForType('pong', 2000);

      assert.ok(pong1.payload.timestamp, 'Client 1 should get pong');
      assert.ok(pong2.payload.timestamp, 'Client 2 should get pong');

      client1.close();
      client2.close();
    });
  });
});

// ==================== INTEGRATION TESTS (require running daemons) ====================

// These tests spawn actual daemons and test the full flow
// They take longer and require the CLI tools to be available
// Run with: INTEGRATION=1 node --test test/gateway.test.js

if (process.env.INTEGRATION) {
  describe('Gateway Integration', () => {
    let gateway;
    let gatewayPort;
    let client;

    // Choose which provider to test based on availability
    const testProvider = process.env.TEST_PROVIDER || 'gemini';

    before(async () => {
      gatewayPort = getPort();
      gateway = await startGateway(gatewayPort, {
        debug: process.env.DEBUG === 'true',
      });
    });

    after(async () => {
      if (client) client.close();
      if (gateway?.proc) await stopProcess(gateway.proc, 10000);
    });

    beforeEach(async () => {
      client = new WSClient(`ws://localhost:${gatewayPort}`);
      await client.connect();
      await client.waitForType('connected');
      client.clearMessages();
    });

    afterEach(async () => {
      // Cleanup spawned processes
      client.send({ type: 'stop', payload: { provider: testProvider } });
      await sleep(2000);
      client.close();
    });

    it(`spawns a ${testProvider} daemon`, async () => {
      client.send({
        type: 'spawn',
        payload: { provider: testProvider },
      });

      // Should receive spawning event
      const spawning = await client.waitForType('spawning', 5000);
      assert.strictEqual(spawning.payload.provider, testProvider);

      // Should receive spawned event (may take a while for auth)
      const spawned = await client.waitForType('spawned', 90000);
      assert.ok(spawned.payload.id, 'Should have process id');
      assert.ok(spawned.payload.port, 'Should have port');
      assert.strictEqual(spawned.payload.provider, testProvider);
    });

    it(`routes chat to spawned ${testProvider} daemon`, async () => {
      // First spawn
      client.send({ type: 'spawn', payload: { provider: testProvider } });
      await client.waitForType('spawned', 90000);
      client.clearMessages();

      // Then chat
      client.send({
        type: 'chat',
        payload: {
          provider: testProvider,
          text: 'Say "test" and nothing else.',
        },
      });

      // Should receive response events
      const events = await client.collectChatResponse(60000);
      const types = events.map((e) => e.type);

      assert.ok(
        types.includes('content_delta') || types.includes('content'),
        `Should receive content, got: ${types.join(', ')}`
      );
      assert.ok(types.includes('done'), 'Should receive done');
    });

    it('stops a spawned daemon', async () => {
      // Spawn first
      client.send({ type: 'spawn', payload: { provider: testProvider } });
      const spawned = await client.waitForType('spawned', 90000);
      client.clearMessages();

      // Stop by processId
      client.send({
        type: 'stop',
        payload: { processId: spawned.payload.id },
      });

      const stopped = await client.waitForType('stopped', 10000);
      assert.strictEqual(stopped.payload.processId, spawned.payload.id);

      // Verify process is gone
      client.send({ type: 'list_processes' });
      const processes = await client.waitForType('processes', 2000);
      const found = processes.payload.find((p) => p.id === spawned.payload.id);
      assert.ok(!found, 'Process should be removed');
    });

    it('scales daemon instances', async () => {
      // Scale to 2 instances
      client.send({
        type: 'scale',
        payload: { provider: testProvider, count: 2 },
      });

      const scaled = await client.waitForType('scaled', 120000);
      assert.strictEqual(scaled.payload.provider, testProvider);
      assert.strictEqual(scaled.payload.current, 2);

      // Verify 2 processes
      client.send({ type: 'list_processes', provider: testProvider });
      const processes = await client.waitForType('processes', 2000);
      const providerProcesses = processes.payload.filter((p) => p.provider === testProvider);
      assert.strictEqual(providerProcesses.length, 2, 'Should have 2 processes');

      // Scale down to 1
      client.clearMessages();
      client.send({
        type: 'scale',
        payload: { provider: testProvider, count: 1 },
      });

      const scaledDown = await client.waitForType('scaled', 10000);
      assert.strictEqual(scaledDown.payload.current, 1);
    });
  });
}
