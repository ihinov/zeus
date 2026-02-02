/**
 * Orchestration Tests - Tests for agent orchestration capabilities
 *
 * Tests session management, system prompts, tools configuration,
 * and agent state queries through both direct daemon and gateway routing.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { startDaemon, startGateway, stopProcess, WSClient, getPort, sleep } from './helpers.js';

// ============================================================================
// DIRECT DAEMON TESTS - Test orchestration features directly on daemons
// ============================================================================

describe('Orchestration: Direct Daemon Tests', () => {
  // Skip if specific daemon auth is not available
  const SKIP_CLAUDE = process.env.SKIP_CLAUDE === '1';
  const SKIP_GEMINI = process.env.SKIP_GEMINI === '1';

  describe('Session Management', () => {
    let daemon;
    let client;
    const port = getPort();

    before(async function() {
      if (SKIP_CLAUDE) {
        this.skip();
        return;
      }
      daemon = await startDaemon('claude', port, { timeout: 60000 });
      client = new WSClient(`ws://localhost:${port}`);
      await client.connect();
      // Wait for connected message
      await client.waitForType('connected');
    });

    after(async () => {
      client?.close();
      await stopProcess(daemon?.proc);
    });

    beforeEach(() => {
      client?.clearMessages();
    });

    it('should get current session ID', async () => {
      client.send({ type: 'get_session' });
      const response = await client.waitForType('session');

      assert.ok(response.payload.sessionId, 'Should have sessionId');
      assert.strictEqual(typeof response.payload.sessionId, 'string');
      assert.ok(response.payload.sessionId.length > 0);
    });

    it('should create new session', async () => {
      // Get original session ID
      client.send({ type: 'get_session' });
      const original = await client.waitForType('session');
      const originalId = original.payload.sessionId;

      client.clearMessages();

      // Create new session
      client.send({ type: 'new_session' });
      const response = await client.waitForType('session_created');

      assert.ok(response.payload.sessionId, 'Should have new sessionId');
      assert.notStrictEqual(response.payload.sessionId, originalId, 'New session should be different');
    });

    it('should set specific session ID', async () => {
      const targetSessionId = 'test-session-' + Date.now();

      client.send({
        type: 'set_session',
        payload: { sessionId: targetSessionId },
      });
      const response = await client.waitForType('session_changed');

      assert.strictEqual(response.payload.sessionId, targetSessionId);

      // Verify it was set
      client.clearMessages();
      client.send({ type: 'get_session' });
      const verify = await client.waitForType('session');
      assert.strictEqual(verify.payload.sessionId, targetSessionId);
    });

    it('should return error for set_session without sessionId', async () => {
      client.send({ type: 'set_session', payload: {} });
      const response = await client.waitForType('error');

      assert.ok(response.payload.message.includes('sessionId required'));
    });
  });

  describe('System Prompt Configuration', () => {
    let daemon;
    let client;
    const port = getPort();

    before(async function() {
      if (SKIP_CLAUDE) {
        this.skip();
        return;
      }
      daemon = await startDaemon('claude', port, { timeout: 60000 });
      client = new WSClient(`ws://localhost:${port}`);
      await client.connect();
      await client.waitForType('connected');
    });

    after(async () => {
      client?.close();
      await stopProcess(daemon?.proc);
    });

    beforeEach(() => {
      client?.clearMessages();
    });

    it('should get system prompt config (initially null)', async () => {
      client.send({ type: 'get_system_prompt' });
      const response = await client.waitForType('system_prompt');

      assert.strictEqual(response.payload.systemPrompt, null);
      assert.strictEqual(response.payload.appendSystemPrompt, null);
    });

    it('should set system prompt', async () => {
      const prompt = 'You are a helpful coding assistant specialized in JavaScript.';

      client.send({
        type: 'set_system_prompt',
        payload: { prompt },
      });
      const response = await client.waitForType('system_prompt_changed');

      assert.strictEqual(response.payload.systemPrompt, prompt);
      assert.strictEqual(response.payload.appendSystemPrompt, null);
    });

    it('should set append system prompt', async () => {
      const prompt = 'Always include code examples in your responses.';

      client.send({
        type: 'set_append_system_prompt',
        payload: { prompt },
      });
      const response = await client.waitForType('system_prompt_changed');

      assert.strictEqual(response.payload.appendSystemPrompt, prompt);
      assert.strictEqual(response.payload.systemPrompt, null, 'Full prompt should be cleared when append is set');
    });

    it('should clear system prompt when set to empty string', async () => {
      // First set a prompt
      client.send({
        type: 'set_system_prompt',
        payload: { prompt: 'Test prompt' },
      });
      await client.waitForType('system_prompt_changed');

      client.clearMessages();

      // Now clear it
      client.send({
        type: 'set_system_prompt',
        payload: { prompt: '' },
      });
      const response = await client.waitForType('system_prompt_changed');

      assert.strictEqual(response.payload.systemPrompt, '');
    });

    it('should return error for set_system_prompt without prompt', async () => {
      client.send({ type: 'set_system_prompt', payload: {} });
      const response = await client.waitForType('error');

      assert.ok(response.payload.message.includes('prompt required'));
    });
  });

  describe('Tools Configuration', () => {
    let daemon;
    let client;
    const port = getPort();

    before(async function() {
      if (SKIP_CLAUDE) {
        this.skip();
        return;
      }
      daemon = await startDaemon('claude', port, { timeout: 60000 });
      client = new WSClient(`ws://localhost:${port}`);
      await client.connect();
      await client.waitForType('connected');
    });

    after(async () => {
      client?.close();
      await stopProcess(daemon?.proc);
    });

    beforeEach(() => {
      client?.clearMessages();
    });

    it('should get allowed tools (initially null)', async () => {
      client.send({ type: 'get_allowed_tools' });
      const response = await client.waitForType('allowed_tools');

      assert.strictEqual(response.payload.tools, null);
    });

    it('should set allowed tools', async () => {
      const tools = ['Read', 'Write', 'Bash'];

      client.send({
        type: 'set_allowed_tools',
        payload: { tools },
      });
      const response = await client.waitForType('allowed_tools_changed');

      assert.deepStrictEqual(response.payload.tools, tools);
    });

    it('should set allowed tools to empty array (no tools)', async () => {
      client.send({
        type: 'set_allowed_tools',
        payload: { tools: [] },
      });
      const response = await client.waitForType('allowed_tools_changed');

      assert.deepStrictEqual(response.payload.tools, []);
    });

    it('should set allowed tools to null (all tools)', async () => {
      client.send({
        type: 'set_allowed_tools',
        payload: { tools: null },
      });
      const response = await client.waitForType('allowed_tools_changed');

      assert.strictEqual(response.payload.tools, null);
    });

    it('should return error for invalid tools type', async () => {
      client.send({
        type: 'set_allowed_tools',
        payload: { tools: 'not-an-array' },
      });
      const response = await client.waitForType('error');

      assert.ok(response.payload.message.includes('tools must be an array'));
    });
  });

  describe('Agent State', () => {
    let daemon;
    let client;
    const port = getPort();

    before(async function() {
      if (SKIP_CLAUDE) {
        this.skip();
        return;
      }
      daemon = await startDaemon('claude', port, { timeout: 60000 });
      client = new WSClient(`ws://localhost:${port}`);
      await client.connect();
      await client.waitForType('connected');
    });

    after(async () => {
      client?.close();
      await stopProcess(daemon?.proc);
    });

    beforeEach(() => {
      client?.clearMessages();
    });

    it('should get comprehensive agent state', async () => {
      // First configure some state
      client.send({
        type: 'set_system_prompt',
        payload: { prompt: 'Test prompt' },
      });
      await client.waitForType('system_prompt_changed');

      client.send({
        type: 'set_allowed_tools',
        payload: { tools: ['Read'] },
      });
      await client.waitForType('allowed_tools_changed');

      client.clearMessages();

      // Get agent state
      client.send({ type: 'get_agent_state' });
      const response = await client.waitForType('agent_state');

      // Verify all fields
      const state = response.payload;
      assert.ok(state.name, 'Should have name');
      assert.ok(state.sessionId, 'Should have sessionId');
      assert.ok(state.model, 'Should have model');
      assert.ok(Array.isArray(state.availableModels), 'Should have availableModels');
      assert.strictEqual(typeof state.isProcessing, 'boolean', 'Should have isProcessing');
      assert.strictEqual(typeof state.isReady, 'boolean', 'Should have isReady');
      assert.strictEqual(typeof state.isAuthenticated, 'boolean', 'Should have isAuthenticated');
      assert.strictEqual(state.systemPrompt, 'Test prompt', 'Should have systemPrompt we set');
      assert.deepStrictEqual(state.allowedTools, ['Read'], 'Should have allowedTools we set');
      assert.strictEqual(typeof state.uptime, 'number', 'Should have uptime');
    });

    it('should show isProcessing=false when idle', async () => {
      client.send({ type: 'get_agent_state' });
      const response = await client.waitForType('agent_state');

      assert.strictEqual(response.payload.isProcessing, false);
    });
  });
});

// ============================================================================
// GATEWAY ROUTING TESTS - Test orchestration through the Gateway
// ============================================================================

describe('Orchestration: Gateway Routing Tests', { skip: process.env.INTEGRATION !== '1' }, () => {
  let gateway;
  let daemon;
  let client;
  const gatewayPort = getPort();
  const daemonPort = getPort();

  before(async function() {
    // Start gateway
    gateway = await startGateway(gatewayPort, { timeout: 10000 });

    // Start a claude daemon
    if (process.env.SKIP_CLAUDE !== '1') {
      daemon = await startDaemon('claude', daemonPort, { timeout: 60000 });
    }

    // Connect client to gateway
    client = new WSClient(`ws://localhost:${gatewayPort}`);
    await client.connect();
    await client.waitForType('connected');
  });

  after(async () => {
    client?.close();
    await stopProcess(daemon?.proc);
    await stopProcess(gateway?.proc);
  });

  describe('Gateway spawns daemon and routes orchestration commands', () => {
    let processId;

    it('should spawn a daemon through gateway', async function() {
      if (process.env.SKIP_CLAUDE === '1') {
        this.skip();
        return;
      }

      client.send({
        type: 'spawn',
        payload: { provider: 'claude' },
      });

      // Wait for spawned response
      const spawned = await client.waitForType('spawned', 30000);
      processId = spawned.payload.id;

      assert.ok(processId, 'Should have process ID');
      assert.strictEqual(spawned.payload.provider, 'claude');
    });

    it('should route get_session to daemon via gateway', async function() {
      if (!processId) {
        this.skip();
        return;
      }

      client.clearMessages();
      client.send({
        type: 'get_session',
        payload: { processId },
      });

      const response = await client.waitForType('session', 5000);
      assert.ok(response.payload.sessionId);
    });

    it('should route new_session to daemon via gateway', async function() {
      if (!processId) {
        this.skip();
        return;
      }

      client.clearMessages();
      client.send({
        type: 'new_session',
        payload: { processId },
      });

      const response = await client.waitForType('session_created', 5000);
      assert.ok(response.payload.sessionId);
    });

    it('should route set_system_prompt to daemon via gateway', async function() {
      if (!processId) {
        this.skip();
        return;
      }

      client.clearMessages();
      client.send({
        type: 'set_system_prompt',
        payload: {
          processId,
          prompt: 'You are a test assistant.',
        },
      });

      const response = await client.waitForType('system_prompt_changed', 5000);
      assert.strictEqual(response.payload.systemPrompt, 'You are a test assistant.');
    });

    it('should route get_agent_state to daemon via gateway', async function() {
      if (!processId) {
        this.skip();
        return;
      }

      client.clearMessages();
      client.send({
        type: 'get_agent_state',
        payload: { processId },
      });

      const response = await client.waitForType('agent_state', 5000);

      assert.ok(response.payload.name);
      assert.ok(response.payload.sessionId);
      assert.strictEqual(response.payload.systemPrompt, 'You are a test assistant.');
    });

    it('should route by provider if no processId given', async function() {
      if (!processId) {
        this.skip();
        return;
      }

      client.clearMessages();
      client.send({
        type: 'get_agent_state',
        payload: { provider: 'claude' },
      });

      const response = await client.waitForType('agent_state', 5000);
      assert.ok(response.payload.name);
    });

    it('should return error for unknown processId', async () => {
      client.clearMessages();
      client.send({
        type: 'get_session',
        payload: { processId: 'nonexistent-process' },
      });

      const response = await client.waitForType('error', 5000);
      assert.ok(response.payload.message.includes('not found'));
    });

    it('should return error for missing processId and provider', async () => {
      client.clearMessages();
      client.send({
        type: 'get_session',
        payload: {},
      });

      const response = await client.waitForType('error', 5000);
      assert.ok(response.payload.message.includes('processId or provider required'));
    });
  });
});

// ============================================================================
// GEMINI DAEMON ORCHESTRATION TESTS
// ============================================================================

describe('Orchestration: Gemini Daemon', { skip: process.env.SKIP_GEMINI === '1' }, () => {
  let daemon;
  let client;
  const port = getPort();

  before(async function() {
    try {
      daemon = await startDaemon('gemini', port, { timeout: 60000 });
      client = new WSClient(`ws://localhost:${port}`);
      await client.connect();
      await client.waitForType('connected');
    } catch (err) {
      console.log('Gemini daemon not available, skipping tests');
      this.skip();
    }
  });

  after(async () => {
    client?.close();
    await stopProcess(daemon?.proc);
  });

  it('should support session management', async () => {
    client.send({ type: 'get_session' });
    const response = await client.waitForType('session');
    assert.ok(response.payload.sessionId);
  });

  it('should support get_agent_state', async () => {
    client.send({ type: 'get_agent_state' });
    const response = await client.waitForType('agent_state');

    assert.ok(response.payload.name.includes('Gemini'));
    assert.strictEqual(typeof response.payload.isProcessing, 'boolean');
    assert.ok(response.payload.model);
  });
});

// ============================================================================
// COPILOT DAEMON ORCHESTRATION TESTS
// ============================================================================

describe('Orchestration: Copilot Daemon', { skip: process.env.SKIP_COPILOT === '1' }, () => {
  let daemon;
  let client;
  const port = getPort();

  before(async function() {
    try {
      daemon = await startDaemon('copilot', port, { timeout: 60000 });
      client = new WSClient(`ws://localhost:${port}`);
      await client.connect();
      await client.waitForType('connected');
    } catch (err) {
      console.log('Copilot daemon not available, skipping tests');
      this.skip();
    }
  });

  after(async () => {
    client?.close();
    await stopProcess(daemon?.proc);
  });

  it('should support session management', async () => {
    client.send({ type: 'get_session' });
    const response = await client.waitForType('session');
    assert.ok(response.payload.sessionId);
  });

  it('should support get_agent_state', async () => {
    client.send({ type: 'get_agent_state' });
    const response = await client.waitForType('agent_state');

    assert.ok(response.payload.name.includes('Copilot'));
    assert.strictEqual(typeof response.payload.isProcessing, 'boolean');
    assert.ok(response.payload.model);
  });
});

// ============================================================================
// ERROR HANDLING TESTS
// ============================================================================

describe('Orchestration: Error Handling', { skip: process.env.SKIP_CLAUDE === '1' }, () => {
  let daemon;
  let client;
  const port = getPort();

  before(async function() {
    daemon = await startDaemon('claude', port, { timeout: 60000 });
    client = new WSClient(`ws://localhost:${port}`);
    await client.connect();
    await client.waitForType('connected');
  });

  after(async () => {
    client?.close();
    await stopProcess(daemon?.proc);
  });

  beforeEach(() => {
    client?.clearMessages();
  });

  it('should handle set_session with missing sessionId', async () => {
    client.send({ type: 'set_session' });
    const response = await client.waitForType('error');
    assert.ok(response.payload.message.includes('sessionId required'));
  });

  it('should handle set_system_prompt with missing prompt', async () => {
    client.send({ type: 'set_system_prompt' });
    const response = await client.waitForType('error');
    assert.ok(response.payload.message.includes('prompt required'));
  });

  it('should handle set_append_system_prompt with missing prompt', async () => {
    client.send({ type: 'set_append_system_prompt' });
    const response = await client.waitForType('error');
    assert.ok(response.payload.message.includes('prompt required'));
  });

  it('should handle set_allowed_tools with invalid type', async () => {
    client.send({ type: 'set_allowed_tools', payload: { tools: 123 } });
    const response = await client.waitForType('error');
    assert.ok(response.payload.message.includes('tools must be an array'));
  });

  it('should handle set_allowed_tools with string instead of array', async () => {
    client.send({ type: 'set_allowed_tools', payload: { tools: 'Read,Write' } });
    const response = await client.waitForType('error');
    assert.ok(response.payload.message.includes('tools must be an array'));
  });
});

// ============================================================================
// MULTIPLE CLIENTS TESTS
// ============================================================================

describe('Orchestration: Multiple Clients', { skip: process.env.SKIP_CLAUDE === '1' }, () => {
  let daemon;
  let client1;
  let client2;
  const port = getPort();

  before(async function() {
    daemon = await startDaemon('claude', port, { timeout: 60000 });

    client1 = new WSClient(`ws://localhost:${port}`);
    await client1.connect();
    await client1.waitForType('connected');

    client2 = new WSClient(`ws://localhost:${port}`);
    await client2.connect();
    await client2.waitForType('connected');
  });

  after(async () => {
    client1?.close();
    client2?.close();
    await stopProcess(daemon?.proc);
  });

  it('should maintain shared state across clients', async () => {
    const testPrompt = 'Shared test prompt ' + Date.now();

    // Client 1 sets system prompt
    client1.send({
      type: 'set_system_prompt',
      payload: { prompt: testPrompt },
    });
    await client1.waitForType('system_prompt_changed');

    // Client 2 should see the same prompt
    client2.clearMessages();
    client2.send({ type: 'get_system_prompt' });
    const response = await client2.waitForType('system_prompt');

    assert.strictEqual(response.payload.systemPrompt, testPrompt);
  });

  it('should maintain shared session across clients', async () => {
    // Client 1 creates new session
    client1.clearMessages();
    client1.send({ type: 'new_session' });
    const newSession = await client1.waitForType('session_created');
    const newSessionId = newSession.payload.sessionId;

    // Client 2 should see the same session
    client2.clearMessages();
    client2.send({ type: 'get_session' });
    const response = await client2.waitForType('session');

    assert.strictEqual(response.payload.sessionId, newSessionId);
  });
});
