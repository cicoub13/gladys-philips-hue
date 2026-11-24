// Test helper: stands in for `node:https`, so HTTPS requests to a bridge never
// leave the test process (a real one waits for its timeout on an absent host).

import { EventEmitter } from 'node:events';
import https from 'node:https';
import { mock } from 'node:test';

/**
 * Replace `https.request` with a per-URL responder.
 * @param {(url: string, options: object) => { status?: number, body?: any, cn?: string, cert?: string } | undefined}
 * responder - Answer to serve; `undefined` refuses the connection like a closed port 443.
 * @returns {{ calls: Array<{ url: string, method: string, body: string }> }} Recorded calls.
 */
export function stubHttps(responder = () => undefined) {
  const calls = [];
  mock.method(https, 'request', (target, options, callback) => {
    const request = new EventEmitter();
    let sent = '';
    request.write = (chunk) => {
      sent += chunk;
    };
    request.destroy = () => {};
    request.end = () => {
      const url = String(target);
      calls.push({ url, method: options.method, body: sent });
      setImmediate(() => {
        const answer = responder(url, options);
        if (!answer) {
          const error = new Error(`connect ECONNREFUSED ${target.hostname}:443`);
          error.code = 'ECONNREFUSED';
          request.emit('error', error);
          return;
        }
        const response = new EventEmitter();
        response.statusCode = answer.status || 200;
        response.complete = true;
        response.destroy = () => {};
        response.socket = {
          getPeerCertificate: () => ({ subject: { CN: answer.cn || '' }, raw: Buffer.from(answer.cert || 'cert') }),
        };
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
