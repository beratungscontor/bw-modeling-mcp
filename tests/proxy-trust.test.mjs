import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { trustedProxyHops } from '../dist/proxy-trust.js';

// On SAP BTP Cloud Foundry X-Forwarded-For arrives as "client, load balancer" and the socket is
// the CF router. The rate limiter keys on req.ip, so that must come out as the client.

async function ipSeen(hops, forwardedFor) {
  const app = express();
  if (hops > 0) app.set('trust proxy', hops);
  app.get('/', (req, res) => res.send(req.ip));
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'X-Forwarded-For': forwardedFor } });
    return await res.text();
  } finally {
    server.close();
  }
}

test('on Cloud Foundry two hops are trusted, elsewhere none', () => {
  assert.equal(trustedProxyHops({ VCAP_APPLICATION: '{}' }), 2);
  assert.equal(trustedProxyHops({}), 0);
  assert.equal(trustedProxyHops({ VCAP_APPLICATION: '{}', BW_TRUST_PROXY_HOPS: '1' }), 1);
  assert.equal(trustedProxyHops({ BW_TRUST_PROXY_HOPS: '0', VCAP_APPLICATION: '{}' }), 0);
  assert.throws(() => trustedProxyHops({ BW_TRUST_PROXY_HOPS: 'yes' }), /whole number/);
});

test('with the Cloud Foundry hops req.ip is the client, not the load balancer', async () => {
  assert.equal(await ipSeen(2, '203.0.113.7, 10.0.200.0'), '203.0.113.7');
  assert.equal(await ipSeen(1, '203.0.113.7, 10.0.200.0'), '10.0.200.0');
});

test('a client cannot choose its own key by sending X-Forwarded-For', async () => {
  // The load balancer appends the real client after whatever the client sent.
  assert.equal(await ipSeen(2, '198.51.100.1, 203.0.113.7, 10.0.200.0'), '203.0.113.7');
  // Without a trusted proxy the header is ignored altogether.
  assert.match(await ipSeen(0, '198.51.100.1'), /127\.0\.0\.1/);
});
