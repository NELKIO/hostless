import type { Emitter } from '../util/emitter.js';
import type { Clock } from '../util/timers.js';
import type { RandomBytes } from '../util/bytes.js';
import type { PeerId } from '../identity.js';
import type { RoomSecrets } from '../room/secrets.js';

export type PathKind = 'direct' | 'nostr' | 'mqtt' | 'broadcast' | 'memory';

export interface PathEvents {
  [event: string]: unknown[];
  /** a frame arrived; `via` identifies the transport-level sender where the path has one */
  frame: [frame: Uint8Array, via: unknown];
  /** the path can send to the room */
  up: [];
  down: [];
  /** a transport-level peer appeared (direct path): it should get our hello now */
  'via-join': [via: unknown];
  /** a transport-level peer went away (direct path); bound identities on it are no longer reachable */
  'via-gone': [via: unknown];
  /** a path-level problem worth showing in diagnostics */
  error: [code: string, detail: string];
}

/**
 * A datagram path into the room. Frames are opaque bytes (already encrypted); a path only moves
 * them. Delivery may be lossy, duplicated and reordered: the link layer above repairs that.
 */
export interface Path {
  readonly kind: PathKind;
  /** unique within a room (e.g. 'direct', 'nostr', 'mqtt', 'relay-a') */
  readonly name: string;
  /** true: a direct peer-to-peer channel (preferred while healthy); false: a relay */
  readonly direct: boolean;
  /** largest frame `send` accepts, in bytes */
  readonly maxFrame: number;
  /** can send to the room right now */
  readonly up: boolean;
  readonly events: Emitter<PathEvents>;
  /** can address `peer` right now */
  reachable(peer: PeerId): boolean;
  /** `to === null`: everyone in the room. false when it could not even be queued */
  send(to: PeerId | null, frame: Uint8Array): boolean;
  /** an authenticated frame from `peer` arrived with this `via`: address that peer through it */
  bind(peer: PeerId, via: unknown): void;
  /** small JSON hint the peer gets in our hello (e.g. which relays we listen on) */
  hint?(): unknown;
  setPeerHint?(peer: PeerId, hint: unknown): void;
  /** diagnostics */
  status?(): Record<string, unknown>;
  close(): void;
}

export interface PathContext {
  appId: string;
  secrets: RoomSecrets;
  /** own peer id */
  self: PeerId;
  clock: Clock;
  random: RandomBytes;
  /** max peers in the room (for transports that enforce it) */
  maxPeers: number;
}

export type PathFactory = (ctx: PathContext) => Path | Promise<Path>;
