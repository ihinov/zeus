#!/usr/bin/env node
/**
 * Manual session test - sends two messages to check context retention
 */

import WebSocket from 'ws';

const [,, type = 'claude', port = '3457'] = process.argv;
const SECRET = `SECRET_${Date.now()}`;

console.log(`Testing ${type} daemon on port ${port}...`);
console.log(`Secret: ${SECRET}\n`);

const ws = new WebSocket(`ws://localhost:${port}`);
let messageCount = 0;
let fullText = '';

function sendMessage(text) {
  console.log(`\n>>> Sending: "${text.slice(0, 50)}..."\n`);
  fullText = '';
  ws.send(JSON.stringify({
    type: 'chat',
    payload: { text }
  }));
}

ws.on('open', () => {
  console.log('Connected!');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  switch (msg.type) {
    case 'connected':
      console.log(`Session: ${msg.payload.sessionId}`);
      // Send first message
      sendMessage(`Remember this secret: ${SECRET}. Say "OK, remembered ${SECRET}" only.`);
      break;

    case 'content_delta':
      process.stdout.write(msg.payload.text || '');
      fullText += msg.payload.text || '';
      break;

    case 'content':
      fullText = msg.payload.text || fullText;
      break;

    case 'done':
      messageCount++;
      console.log(`\n\n<<< Response ${messageCount}: "${fullText.slice(0, 100)}..."`);

      if (messageCount === 1) {
        // Send second message asking for the secret
        setTimeout(() => {
          sendMessage('What was the secret I just told you? Reply with just the secret code.');
        }, 1000);
      } else if (messageCount === 2) {
        // Check if it remembered
        console.log('\n--- RESULT ---');
        if (fullText.includes(SECRET)) {
          console.log('✅ SUCCESS: Daemon remembered the secret!');
        } else {
          console.log('❌ FAILED: Daemon did not remember the secret');
          console.log(`   Expected to find: ${SECRET}`);
          console.log(`   Got: ${fullText}`);
        }
        ws.close();
        process.exit(fullText.includes(SECRET) ? 0 : 1);
      }
      break;

    case 'error':
      console.error('\n❌ Error:', msg.payload.message);
      ws.close();
      process.exit(1);
      break;

    case 'thinking':
    case 'streaming':
      // Ignore these
      break;

    default:
      console.log(`[${msg.type}]`);
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log('\nConnection closed');
});

// Timeout after 3 minutes
setTimeout(() => {
  console.error('\n⏰ Timeout');
  ws.close();
  process.exit(1);
}, 180000);
