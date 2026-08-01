(function () {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(proto + '//' + location.host + '/ws');
    var connected = false;
    var queue = [];

    function send(msg) {
        if (connected) {
            try { ws.send(JSON.stringify(msg)); } catch (e) {}
        } else {
            queue.push(msg);
        }
    }

    ws.onopen = function () {
        connected = true;
        for (var i = 0; i < queue.length; i++) {
            try { ws.send(JSON.stringify(queue[i])); } catch (e) {}
        }
        queue = [];
        var dbg = document.getElementById('debug-status');
        if (dbg) dbg.textContent = 'Connected to Maggot webUI';
    };

    ws.onmessage = function (e) {
        var data;
        try { data = JSON.parse(e.data); } catch (err) { return; }
        window.dispatchEvent(new MessageEvent('message', { data: data }));
    };

    ws.onclose = function () {
        connected = false;
        var dbg = document.getElementById('debug-status');
        if (dbg) dbg.textContent = 'Disconnected from Maggot webUI';
    };

    ws.onerror = function () {
        var dbg = document.getElementById('debug-status');
        if (dbg) dbg.textContent = 'WebSocket error - is the Maggot server running?';
    };

    window.acquireVsCodeApi = function () {
        return {
            postMessage: send,
            getState: function () {
                try { return JSON.parse(localStorage.getItem('maggot.webui.state') || 'null'); } catch (e) { return null; }
            },
            setState: function (s) {
                localStorage.setItem('maggot.webui.state', JSON.stringify(s));
            }
        };
    };

    window.__maggotWebUI = true;
})();
