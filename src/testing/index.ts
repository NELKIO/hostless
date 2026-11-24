/**
 * Test doubles for apps built on hostless: simulate networks, relays and brokers in one process,
 * deterministically, with a manual clock.
 *
 *   const clock = new ManualClock();
 *   const net = new MemoryNetwork(clock).medium('relay', { latency: 150, loss: 0.2 });
 *   const a = await joinRoomWith({ app, code, clock, paths: [net.path('relay')] });
 */
export { MemoryNetwork, MemoryPath, seededRandom, seededBytes, type MediumOptions, type MediumStats } from './memory-network.js';
export { FakeNostrNetwork, FakeNostrRelay, FakeSocket, matches as nostrFilterMatches, type RelayBehaviour } from './fake-nostr-relay.js';
export { FakeMqttNetwork, FakeMqttBroker, topicMatches, type BrokerBehaviour } from './fake-mqtt-broker.js';
export { FakeTrystero } from './fake-trystero.js';
export { ManualClock, flushMicrotasks } from '../util/timers.js';
export { MemoryStorage } from '../storage/kv.js';
export { MemoryLocks } from '../storage/locks.js';
