// Test helper: stands in for `node:https` and `node:tls`, so HTTPS requests to a
// bridge never leave the test process (a real one waits for its timeout on an
// absent host). The certificate check of `src/hue/https.js` still runs for real:
// the fake hands the request's own `createConnection` a fake TLS socket.

import { EventEmitter } from 'node:events';
import https from 'node:https';
import tls from 'node:tls';
import { mock } from 'node:test';

/**
 * Replace `https.request` with a per-URL responder.
 * @param {(url: string, options: object) => { status?: number, body?: any, cn?: string, cert?: string } | undefined}
 * responder - Answer to serve, with the certificate CN; `undefined` refuses the connection like a closed port 443.
 * @returns {{ calls: Array<{ url: string, method: string, body: string }> }} Requests actually written, i.e.
 * sent to a peer whose certificate passed the check.
 */
export function stubHttps(responder = () => undefined) {
  const calls = [];
  // The answer of the request being connected: `tls.connect` is called
  // synchronously by its `createConnection`.
  let connecting;
  mock.method(tls, 'connect', () => {
    const answer = connecting;
    const socket = new EventEmitter();
    socket.destroy = () => {};
    socket.getPeerCertificate = () => ({ subject: { CN: answer.cn || '' }, raw: Buffer.from(answer.cert || 'cert') });
    setImmediate(() => socket.emit('secureConnect'));
    return socket;
  });
  mock.method(https, 'request', (target, options, callback) => {
    const request = new EventEmitter();
    let sent = '';
    request.write = (chunk) => {
      sent += chunk;
    };
    request.destroy = () => {};
    request.end = () => {
      const url = String(target);
      const answer = responder(url, options);
      if (!answer) {
        setImmediate(() => {
          const error = new Error(`connect ECONNREFUSED ${target.hostname}:443`);
          error.code = 'ECONNREFUSED';
          request.emit('error', error);
        });
        return;
      }
      connecting = answer;
      options.createConnection(options, (error) => {
        if (error) {
          request.emit('error', error);
          return;
        }
        calls.push({ url, method: options.method, body: sent });
        const response = new EventEmitter();
        response.statusCode = answer.status || 200;
        response.complete = true;
        response.destroy = () => {};
        callback(response);
        response.emit('data', Buffer.from(JSON.stringify(answer.body)));
        response.emit('end');
        response.emit('close');
      });
    };
    return request;
  });
  return { calls };
}
