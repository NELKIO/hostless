// Local endpoints for browser tests: a NIP-01 relay and an MQTT-over-WebSocket broker on 127.0.0.1,
// built on the same in-memory relay/broker logic the unit tests use (from dist/), over real sockets.
import { WebSocketServer } from 'ws';
import { FakeNostrRelay } from '../../dist/testing/fake-nostr-relay.js';
import { FakeMqttBroker } from '../../dist/testing/fake-mqtt-broker.js';

function listen(wss) {
  return new Promise((resolve) => wss.on('listening', () => resolve(wss.address().port)));
}

export async function startNostrRelay(behaviour = {}) {
  const relay = new FakeNostrRelay('local', { latency: 0, ...behaviour });
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (ws) => {
    const socket = {
      deliverFromServer: (text) => ws.readyState === 1 && ws.send(text),
      serverClose: () => ws.terminate(),
    };
    const conn = relay.connect(socket);
    if (!conn) return ws.terminate();
    ws.on('message', (data) => relay.receive(conn, data.toString()));
    ws.on('close', () => {
      conn.closed = true;
      relay.connections.delete(conn);
    });
  });
  const port = await listen(wss);
  return { relay, url: `ws://127.0.0.1:${port}`, close: () => new Promise((r) => (wss.clients.forEach((c) => c.terminate()), wss.close(r))) };
}

export async function startMqttBroker(behaviour = {}) {
  const broker = new FakeMqttBroker('local', { latency: 0, ...behaviour });
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, handleProtocols: (protocols) => (protocols.has('mqtt') ? 'mqtt' : false) });
  wss.on('connection', (ws) => {
    const socket = {
      deliverFromServer: (bytes) => ws.readyState === 1 && ws.send(bytes),
      serverClose: () => ws.terminate(),
    };
    const conn = broker.attach(socket);
    if (!conn) return ws.terminate();
    ws.on('message', (data) => broker.receive(conn, new Uint8Array(data)));
    ws.on('close', () => {
      conn.closed = true;
      broker.connections.delete(conn);
    });
  });
  const port = await listen(wss);
  return { broker, url: `ws://127.0.0.1:${port}/mqtt`, close: () => new Promise((r) => (wss.clients.forEach((c) => c.terminate()), wss.close(r))) };
}
