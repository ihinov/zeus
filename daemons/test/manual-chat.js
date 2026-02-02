#!/usr/bin/env node
/**
 * Manual chat test - useful for debugging
 *
 * Usage:
 *   node test/manual-chat.js gemini 3456
 *   node test/manual-chat.js claude 3457
 *   node test/manual-chat.js copilot 3458
 */

import WebSocket from 'ws';

const [,, type = 'gemini', port = '3456'] = process.argv;

console.log(`Connecting to ${type} daemon on port ${port}...`);

const ws = new WebSocket(`ws://localhost:${port}`);

ws.on('open', () => {
  console.log('Connected!\n');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  switch (msg.type) {
    case 'connected':
      console.log('✓ Received connected event');
      console.log(`  Session: ${msg.payload.sessionId}`);
      console.log(`  Model: ${msg.payload.model}`);
      console.log(`  Ready: ${msg.payload.ready}\n`);

      // Send a simple chat message
      console.log('Sending chat message: "Say hello"...\n');
      ws.send(JSON.stringify({
        type: 'chat',
        payload: { text: 'Say "hello" and nothing else.' }
      }));
      break;

    case 'thinking':
      console.log('⏳ Thinking...');
      break;

    case 'streaming':
      console.log('📡 Streaming started...');
      break;

    case 'content_delta':
      process.stdout.write(msg.payload.text || '');
      break;

    case 'content':
      console.log('\n\n📄 Full content:', msg.payload.text?.slice(0, 100) + '...');
      break;

    case 'done':
      console.log('\n✅ Done!');
      ws.close();
      process.exit(0);
      break;

    case 'error':
      console.error('\n❌ Error:', msg.payload.message);
      ws.close();
      process.exit(1);
      break;

    case 'thought':
      console.log('💭 Thought:', JSON.stringify(msg.payload).slice(0, 100));
      break;

    default:
      console.log(`📨 ${msg.type}:`, JSON.stringify(msg.payload).slice(0, 100));
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log('Connection closed');
});

// Timeout after 2 minutes
setTimeout(() => {
  console.error('\n⏰ Timeout after 2 minutes');
  ws.close();
  process.exit(1);
}, 120000);
