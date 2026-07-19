const http = require('http');

// Simulate exactly what the extension does
const endpoint = 'http://127.0.0.1:11434';
const model = 'qwen2.5-coder:3b';

const messages = [
    { role: 'system', content: 'You are a helpful AI assistant integrated into VS Code.' },
    { role: 'user', content: 'say hello in one word' }
];

const body = JSON.stringify({
    model: model,
    messages: messages,
    stream: true
});

const parsedUrl = new URL(endpoint + '/api/chat');

const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || 80,
    path: parsedUrl.pathname,
    method: 'POST',
    family: 4,
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString()
    }
};

console.log('=== Integration Test ===');
console.log('URL:', endpoint + '/api/chat');
console.log('Model:', model);
console.log('Body length:', Buffer.byteLength(body));
console.log('');

const req = http.request(options, (res) => {
    let fullContent = '';
    let buffer = '';
    
    res.setEncoding('utf-8');
    
    res.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed.message?.content) {
                    fullContent += parsed.message.content;
                }
                if (parsed.done) {
                    console.log('Stream done signal received');
                }
            } catch (e) {
                // skip
            }
        }
    });
    
    res.on('end', () => {
        if (buffer.trim()) {
            try {
                const parsed = JSON.parse(buffer.trim());
                if (parsed.message?.content) {
                    fullContent += parsed.message.content;
                }
            } catch (e) {}
        }
        console.log('Full response:', fullContent);
        console.log('');
        console.log('Response length:', fullContent.length);
        console.log('Response has content:', fullContent.length > 0);
        console.log('');
        console.log('TEST ' + (fullContent.length > 0 ? 'PASSED' : 'FAILED'));
    });
    
    res.on('error', (e) => {
        console.error('TEST FAILED - Stream error:', e.message);
    });
});

req.setTimeout(15000, () => {
    req.destroy(new Error('Timeout'));
    console.error('TEST FAILED - Request timed out');
});

req.on('error', (e) => {
    console.error('TEST FAILED - Request error:', e.message);
});

req.write(body);
req.end();