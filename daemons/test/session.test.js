/**
 * Session Persistence Tests
 *
 * Tests whether daemons maintain conversation context across restarts.
 * Run with: node --test test/session.test.js
 *
 * Note: This test takes a while as it involves multiple chat interactions
 * and daemon restarts.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import {
  startDaemon,
  stopProcess,
  WSClient,
  getPort,
  sleep,
} from './helpers.js';

// Test configuration
const TEST_TIMEOUT = 120000; // 2 minutes per test

/**
 * Helper to send a chat message and wait for response
 */
async function chat(client, message, timeout = 60000) {
  client.clearMessages();
  client.send({
    type: 'chat',
    payload: { text: message },
  });

  const events = await client.collectChatResponse(timeout);
  const contentEvents = events.filter(
    (e) => e.type === 'content' || e.type === 'content_delta'
  );

  let fullText = '';
  for (const event of contentEvents) {
    if (event.type === 'content') {
      fullText = event.payload.text;
    } else if (event.type === 'content_delta') {
      fullText += event.payload.text;
    }
  }

  return fullText.trim();
}

// ==================== GEMINI SESSION TESTS ====================

if (!process.env.SKIP_GEMINI) {
  describe('Gemini session persistence', { timeout: TEST_TIMEOUT * 3 }, () => {
    const SECRET = `SECRET_${Date.now()}_GEMINI`;
    let port;

    it('remembers context within a session', async () => {
      port = getPort();
      const daemon = await startDaemon('gemini', port, { timeout: 60000 });

      try {
        const client = new WSClient(`ws://localhost:${port}`);
        await client.connect();
        await client.waitForType('connected');

        // Tell it a secret
        const response1 = await chat(
          client,
          `Remember this secret code: ${SECRET}. Just say "OK, I'll remember ${SECRET}" and nothing else.`
        );
        console.log('[Gemini] Response 1:', response1.slice(0, 100));

        // Ask for the secret (same session)
        const response2 = await chat(
          client,
          'What was the secret code I just told you? Reply with just the code.'
        );
        console.log('[Gemini] Response 2:', response2.slice(0, 100));

        assert.ok(
          response2.includes(SECRET),
          `Should remember secret within session. Got: ${response2}`
        );

        client.close();
      } finally {
        await stopProcess(daemon.proc);
      }
    });

    it('loses context after restart (no built-in persistence)', async () => {
      // Start daemon
      let daemon = await startDaemon('gemini', port, { timeout: 60000 });

      try {
        let client = new WSClient(`ws://localhost:${port}`);
        await client.connect();
        await client.waitForType('connected');

        // Tell it a secret
        await chat(
          client,
          `Remember this secret code: ${SECRET}. Just say "OK" and nothing else.`
        );

        client.close();

        // Kill and restart
        console.log('[Gemini] Restarting daemon...');
        await stopProcess(daemon.proc);
        await sleep(1000);
        daemon = await startDaemon('gemini', port, { timeout: 60000 });

        // Reconnect
        client = new WSClient(`ws://localhost:${port}`);
        await client.connect();
        await client.waitForType('connected');

        // Ask for the secret
        const response = await chat(
          client,
          'What was the secret code I told you earlier? If you don\'t know, just say "I don\'t know".'
        );
        console.log('[Gemini] After restart:', response.slice(0, 100));

        // Gemini doesn't have built-in session persistence, so it should NOT remember
        assert.ok(
          !response.includes(SECRET),
          `Should NOT remember secret after restart (no persistence). Got: ${response}`
        );

        client.close();
      } finally {
        await stopProcess(daemon.proc);
      }
    });
  });
}

// ==================== CLAUDE SESSION TESTS ====================

if (!process.env.SKIP_CLAUDE) {
  describe('Claude session persistence', { timeout: TEST_TIMEOUT * 3 }, () => {
    const SECRET = `SECRET_${Date.now()}_CLAUDE`;
    let port;
    let sessionId;

    it('remembers context within a session', async () => {
      port = getPort();
      const daemon = await startDaemon('claude', port, { timeout: 60000 });

      try {
        const client = new WSClient(`ws://localhost:${port}`);
        await client.connect();
        const connected = await client.waitForType('connected');
        sessionId = connected.payload.sessionId;
        console.log('[Claude] Session ID:', sessionId);

        // Tell it a secret
        const response1 = await chat(
          client,
          `Remember this secret code: ${SECRET}. Just say "OK, I'll remember ${SECRET}" and nothing else.`
        );
        console.log('[Claude] Response 1:', response1.slice(0, 100));

        // Ask for the secret (same session)
        const response2 = await chat(
          client,
          'What was the secret code I just told you? Reply with just the code.'
        );
        console.log('[Claude] Response 2:', response2.slice(0, 100));

        assert.ok(
          response2.includes(SECRET),
          `Should remember secret within session. Got: ${response2}`
        );

        client.close();
      } finally {
        await stopProcess(daemon.proc);
      }
    });

    it('preserves context with same session ID after restart', async () => {
      // This test checks if Claude's --session-id flag actually persists across restarts
      // The daemon passes session ID to the CLI, which may store conversation history

      // Start daemon
      let daemon = await startDaemon('claude', port, { timeout: 60000 });

      try {
        let client = new WSClient(`ws://localhost:${port}`);
        await client.connect();
        const connected = await client.waitForType('connected');
        const testSessionId = connected.payload.sessionId;
        console.log('[Claude] Testing with session ID:', testSessionId);

        // Tell it a secret
        await chat(
          client,
          `Remember this secret code: ${SECRET}. Just say "OK" and nothing else.`
        );

        client.close();

        // Kill and restart
        console.log('[Claude] Restarting daemon...');
        await stopProcess(daemon.proc);
        await sleep(1000);

        // Restart with same session ID via environment
        daemon = await startDaemon('claude', port, {
          timeout: 60000,
          env: { CLAUDE_SESSION_ID: testSessionId },
        });

        // Reconnect
        client = new WSClient(`ws://localhost:${port}`);
        await client.connect();
        await client.waitForType('connected');

        // Ask for the secret
        const response = await chat(
          client,
          'What was the secret code I told you earlier? If you don\'t know, just say "I don\'t know".'
        );
        console.log('[Claude] After restart:', response.slice(0, 100));

        // Claude CLI with session-id SHOULD remember (if it persists sessions)
        // This might fail if Claude CLI doesn't persist sessions to disk
        if (response.includes(SECRET)) {
          console.log('[Claude] Session persistence WORKS!');
        } else {
          console.log('[Claude] Session persistence does NOT work (CLI may not persist sessions)');
        }

        // We don't assert here because it depends on Claude CLI behavior
        // Just log the result

        client.close();
      } finally {
        await stopProcess(daemon.proc);
      }
    });
  });
}

// ==================== COPILOT SESSION TESTS ====================

if (!process.env.SKIP_COPILOT) {
  describe('Copilot session persistence', { timeout: TEST_TIMEOUT * 3 }, () => {
    const SECRET = `SECRET_${Date.now()}_COPILOT`;
    let port;

    it('remembers context within a session', async () => {
      port = getPort();
      const daemon = await startDaemon('copilot', port, { timeout: 60000 });

      try {
        const client = new WSClient(`ws://localhost:${port}`);
        await client.connect();
        await client.waitForType('connected');

        // Tell it a secret
        const response1 = await chat(
          client,
          `Remember this secret code: ${SECRET}. Just say "OK, I'll remember ${SECRET}" and nothing else.`
        );
        console.log('[Copilot] Response 1:', response1.slice(0, 100));

        // Ask for the secret (same session)
        const response2 = await chat(
          client,
          'What was the secret code I just told you? Reply with just the code.'
        );
        console.log('[Copilot] Response 2:', response2.slice(0, 100));

        // Note: Copilot CLI runs each prompt as a separate invocation,
        // so it may NOT remember within the same "session" unless it has its own persistence
        if (response2.includes(SECRET)) {
          console.log('[Copilot] Within-session memory WORKS!');
        } else {
          console.log('[Copilot] No within-session memory (each prompt is independent)');
        }

        client.close();
      } finally {
        await stopProcess(daemon.proc);
      }
    });

    it('loses context after restart', async () => {
      // Start daemon
      let daemon = await startDaemon('copilot', port, { timeout: 60000 });

      try {
        let client = new WSClient(`ws://localhost:${port}`);
        await client.connect();
        await client.waitForType('connected');

        // Tell it a secret
        await chat(
          client,
          `Remember this secret code: ${SECRET}. Just say "OK" and nothing else.`
        );

        client.close();

        // Kill and restart
        console.log('[Copilot] Restarting daemon...');
        await stopProcess(daemon.proc);
        await sleep(1000);
        daemon = await startDaemon('copilot', port, { timeout: 60000 });

        // Reconnect
        client = new WSClient(`ws://localhost:${port}`);
        await client.connect();
        await client.waitForType('connected');

        // Ask for the secret
        const response = await chat(
          client,
          'What was the secret code I told you earlier? If you don\'t know, just say "I don\'t know".'
        );
        console.log('[Copilot] After restart:', response.slice(0, 100));

        // Copilot doesn't have session persistence
        assert.ok(
          !response.includes(SECRET),
          `Should NOT remember secret after restart. Got: ${response}`
        );

        client.close();
      } finally {
        await stopProcess(daemon.proc);
      }
    });
  });
}

// ==================== SUMMARY ====================

describe('Session persistence summary', () => {
  it('documents expected behavior', () => {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║                 Session Persistence Summary                     ║
╠════════════════════════════════════════════════════════════════╣
║  Daemon    │ Within Session │ After Restart │ Notes            ║
╠════════════════════════════════════════════════════════════════╣
║  Gemini    │ ✓ Yes          │ ✗ No          │ Uses in-memory   ║
║            │                │               │ conversation     ║
╠════════════════════════════════════════════════════════════════╣
║  Claude    │ ✓ Yes          │ ? Maybe       │ Uses --session-id║
║            │                │               │ CLI may persist  ║
╠════════════════════════════════════════════════════════════════╣
║  Copilot   │ ? Maybe        │ ✗ No          │ Each prompt is   ║
║            │                │               │ independent      ║
╚════════════════════════════════════════════════════════════════╝
    `);
    assert.ok(true);
  });
});
