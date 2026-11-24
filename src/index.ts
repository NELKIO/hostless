/**
 * hostless — serverless multiplayer for static sites.
 *
 *   rooms     joinRoom, Room              (direct WebRTC + Nostr + MQTT, one reliable link per peer)
 *   sessions  TurnMatch, Replica, HostAuthority (+ create* one-call helpers)
 *   storage   openSeat, listSeats, pruneSeats
 *   sync      DeviceSync, crdt helpers, PublicStats
 *   diag      checkNetwork, netlog
 */
export { joinRoom, resolvePaths, createTurnMatch, createReplica, createHostAuthority, HostlessError, DEFAULT_PATHS } from './connect.js';
export type { ConnectOptions, PathName, PathSpec, SessionOptions, Hosted, TurnMatchSetup, ReplicaSetup, AuthoritySetup } from './connect.js';

export { Room, joinRoom as joinRoomWith } from './room/room.js';
export type { JoinOptions, PeerInfo, RoomEvents, RoomMessage, RoomStatus, LeaveReason, PeerState, Route } from './room/room.js';
export type { AppInfo } from './room/frames.js';
export { roomSecrets, type RoomSecrets } from './room/secrets.js';
export { Link, type LinkOptions } from './room/link.js';

export { ALPHABET, newRoomCode, parseRoomCode, newSyncKey, parseSyncKey, parseCode, formatCode, formatSyncKey, inviteLink, consumeLinkParam } from './code.js';
export { Identity, verifyValue, isPeerId, type PeerId } from './identity.js';

export type { Path, PathContext, PathEvents, PathFactory, PathKind } from './paths/types.js';
export { DirectPath, directPath, type DirectPathOptions, type TrysteroJoin, type TrysteroRoomLike } from './paths/direct.js';
export { NostrPath, nostrPath, EPHEMERAL_KIND, type NostrPathOptions } from './paths/nostr.js';
export { MqttPath, mqttPath, type MqttPathOptions } from './paths/mqtt.js';
export { MqttClient } from './paths/mqtt-client.js';
export { BroadcastPath, broadcastPath } from './paths/broadcast.js';
export { DEFAULT_NOSTR_RELAYS, DEFAULT_STORAGE_RELAYS, DEFAULT_SIGNALING_RELAYS, DEFAULT_MQTT_BROKERS, DEFAULT_STUN } from './paths/defaults.js';

export { TurnMatch, TURN_PROTOCOL } from './sessions/turn-match.js';
export type { TurnEngine, TurnMatchOptions, TurnMatchEvents, TurnJournal, MatchResult, MatchPhase, SeatStatus, StopReason, SetupContext, Entry } from './sessions/turn-match.js';
export { Replica, REPLICA_PROTOCOL } from './sessions/replica.js';
export type { Op, VersionVector, ReplicaOptions, ReplicaEvents, ReplicaJournal } from './sessions/replica.js';
export { HostAuthority, AUTHORITY_PROTOCOL } from './sessions/host-authority.js';
export type { AuthorityEngine, HostAuthorityOptions, AuthorityEvents, HostJournal } from './sessions/host-authority.js';

export { openSeat, listSeats, pruneSeats, Seat } from './storage/seats.js';
export type { SeatOptions, SeatRecord, SeatSummary, PrunePolicy } from './storage/seats.js';
export { SafeStore, MemoryStorage, defaultStorage, type StorageLike } from './storage/kv.js';
export { tryLock, MemoryLocks, defaultLocks, type LockManagerLike } from './storage/locks.js';

export { Mailbox, MAILBOX_KIND, type MailboxOptions } from './mailbox.js';

export { DeviceSync, createDeviceSync, accountOf, SYNC_KIND } from './sync/device-sync.js';
export type { DeviceSyncOptions, SyncStore, SyncStatus, SyncState, SyncedDoc } from './sync/device-sync.js';
export * as crdt from './sync/crdt.js';
export { ledger, deviceId, type Ledger, type Counters, type Merger } from './sync/crdt.js';
export { PublicStats, createPublicStats, totalOf, top, cleanReport, type Report, type Totals, type PublicStatsOptions } from './stats.js';

export { checkNetwork, checkNostrRelay, checkMqttBroker, classifyNat, type NetworkReport, type EndpointResult, type NatType } from './diag/check.js';
export { netlog, getNetLog, clearNetLog, setNetDebug, netDebugEnabled, type NetLogEntry } from './util/log.js';

export { signEvent, verifyEvent, type NostrEvent } from './nostr/event.js';
export { publishEvent, queryRelays } from './nostr/pool.js';
export type { WsFactory, WsLike } from './nostr/socket.js';

export { Emitter, type Unsubscribe } from './util/emitter.js';
export { realClock, ManualClock, type Clock } from './util/timers.js';
export { stableJson } from './util/stable-json.js';
