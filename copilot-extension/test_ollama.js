const http = require('http');

const body = JSON.stringify({
    model: 'qwen2.5-coder:3b',
    messages: [{ role: 'user', content: 'say hi in one word' }],
    stream: true
});

// Force IPv4 by using 127.0.0.1 instead of localhost
const options = {
    hostname: '127.0.0.1',
    port: 11434,
    path: '/api/chat',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString()
    }
};

console.log('Sending request to Ollama at 127.0.0.1:11434...');
console.log('Body length:', Buffer.byteLength(body));

const req = http.request(options, (res) => {
    console.log('Status:', res.statusCode);
    
    let data = '';
    let lineCount = 0;
    res.setEncoding('utf-8');
    
    res.on('data', (chunk) => {
        data += chunk;
        lineCount++;
        // Show first few lines
        if (lineCount <= 3) {
            console.log('Chunk:', chunk.substring(0, 120));
        }
    });
    
    res.on('end', () => {
        console.log('Total lines received:', lineCount);
        console.log('Full response preview:', data.substring(0, 300));
        console.log('TEST PASSED: Ollama API responded successfully');
    });
});

req.on('error', (e) => {
    console.error('TEST FAILED:', e.message);
});

req.setTimeout(15000, () => {
    req.destroy(new Error('Timeout'));
    console.error('TEST FAILED: Request timed out');
});

req.write(body);
req.end();