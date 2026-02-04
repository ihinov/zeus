const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3001');

ws.on('open', () => {
  console.log('Connected');
  ws.send(JSON.stringify({
    type: 'chat',
    payload: {
      text: 'Say hello in 5 words or less',
      provider: 'claude'
    }
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type !== 'connected') {
    console.log(msg.type + ':', msg.payload ? JSON.stringify(msg.payload).slice(0, 150) : '');
  }
  if (msg.type === 'done' || msg.type === 'error') {
    setTimeout(() => { ws.close(); process.exit(0); }, 500);
  }
});

ws.on('error', console.error);
setTimeout(() => { console.log('Timeout'); ws.close(); process.exit(1); }, 60000);
