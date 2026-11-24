/**
 * The batteries-included entry points: `joinRoom` with every default path, and one-call sessions
 * (`createTurnMatch`, `createReplica`, `createHostAuthority`) that open the seat, the room and the
 * mailbox for you.
 */
import { joinRoom as joinRoomCore, type JoinOptions, type Room } from './room/room.js';
import type { Path, PathFactory } from './paths/types.js';
import { directPath, type DirectPathOptions } from './paths/direct.js';
import { nostrPath, type NostrPathOptions } from './paths/nostr.js';
import { mqttPath, type MqttPathOptions } from './paths/mqtt.js';
import { broadcastPath } from './paths/broadcast.js';
import { openSeat, type Seat } from './storage/seats.js';
import type { StorageLike } from './storage/kv.js';
import type { LockManagerLike } from './storage/locks.js';
import { Mailbox } from './mailbox.js';
import { TurnMatch, type TurnEngine, type TurnJournal } from './sessions/turn-match.js';
import { Replica, type ReplicaJournal } from './sessions/replica.js';
import { HostAuthority, type AuthorityEngine, type HostJournal } from './sessions/host-authority.js';

export type PathName = 'direct' | 'nostr' | 'mqtt' | 'broadcast';
export type PathSpec = PathName | PathFactory | Path;

export const DEFAULT_PATHS: readonly PathName[] = Object.freeze(['broadcast', 'direct', 'nostr', 'mqtt']);

export interface ConnectOptions extends Omit<JoinOptions, 'paths'> {
  /** default: broadcast (same-browser tabs), direct (WebRTC), nostr, mqtt */
  paths?: PathSpec[];
  direct?: DirectPathOptions;
  nostr?: NostrPathOptions;
  mqtt?: MqttPathOptions;
}

export function resolvePaths(opts: Pick<ConnectOptions, 'paths' | 'direct' | 'nostr' | 'mqtt'>): Array<PathFactory | Path> {
  return (opts.paths ?? DEFAULT_PATHS).map((p) => {
    switch (p) {
      case 'direct':
        return directPath(opts.direct);
      case 'nostr':
        return nostrPath(opts.nostr);
      case 'mqtt':
        return mqttPath(opts.mqtt);
      case 'broadcast':
        return broadcastPath();
      default:
        return p;
    }
  });
}

/** Join a room over every default path (or the ones you list). */
export function joinRoom(opts: ConnectOptions): Promise<Room> {
  return joinRoomCore({ ...opts, paths: resolvePaths(opts) });
}

export class HostlessError extends Error {
  constructor(
    readonly code: 'seat-busy' | 'no-path',
    message: string,
  ) {
    super(message);
    this.name = 'HostlessError';
  }
}

export interface SessionOptions extends Omit<ConnectOptions, 'identity'> {
  /** keep the seat (identity + journal) in localStorage so a reload resumes; default true */
  persist?: boolean;
  storage?: StorageLike | null;
  locks?: LockManagerLike | null;
}

export type Hosted<T> = T & {
  readonly room: Room;
  readonly seat: Seat<unknown> | null;
  /** leave the session and the room, and release the seat */
  close(): Promise<void>;
};

async function seatAndRoom<J>(opts: SessionOptions, role: string): Promise<{ room: Room; seat: Seat<J> | null }> {
  let seat: Seat<J> | null = null;
  if (opts.persist !== false) {
    seat = await openSeat<J>({ app: opts.app.id, room: opts.code, role, storage: opts.storage, locks: opts.locks });
    if (!seat) throw new HostlessError('seat-busy', 'this seat is open in another tab');
  }
  try {
    const room = await joinRoom({ ...opts, identity: seat?.identity });
    return { room, seat };
  } catch (error) {
    await seat?.release();
    throw error;
  }
}

function host<T extends object>(session: T, room: Room, seat: Seat<unknown> | null, leave: () => void): Hosted<T> {
  return Object.assign(session, {
    room,
    seat,
    async close() {
      leave();
      await room.leave();
      await seat?.release();
    },
  });
}

export interface TurnMatchSetup<S, M, L> extends SessionOptions {
  engine: TurnEngine<S, M, L>;
  role: 'host' | 'guest';
  seats?: number;
  /** leave finished histories in the Nostr mailbox; default true */
  mailbox?: boolean;
  mailboxRelays?: readonly string[];
  /** guests: the host's peer id or invite-link hint (`parseHostHint(location.href)`) */
  host?: string | null;
}

/** Open the seat, join the room and start a TurnMatch in one call. */
export async function createTurnMatch<S, M = unknown, L = unknown>(o: TurnMatchSetup<S, M, L>): Promise<Hosted<TurnMatch<S, M, L>>> {
  const { room, seat } = await seatAndRoom<TurnJournal>(o, o.role);
  const mailbox = o.mailbox === false ? null : new Mailbox({ secrets: room.secrets, identity: room.identity, relays: o.mailboxRelays });
  const match = new TurnMatch<S, M, L>({ room, engine: o.engine, role: o.role, seats: o.seats, seat, mailbox, clock: o.clock, host: o.host });
  return host(match, room, seat as Seat<unknown> | null, () => match.leave());
}

export interface ReplicaSetup<T> extends SessionOptions {
  doc?: string;
  validate?: (op: unknown, author: string) => boolean;
}

export async function createReplica<T = unknown>(o: ReplicaSetup<T>): Promise<Hosted<Replica<T>>> {
  const { room, seat } = await seatAndRoom<ReplicaJournal<T>>(o, `replica:${o.doc ?? 'main'}`);
  const replica = new Replica<T>({ room, doc: o.doc, seat, validate: o.validate, clock: o.clock });
  return host(replica, room, seat as Seat<unknown> | null, () => replica.destroy());
}

export interface AuthoritySetup<S, A> extends SessionOptions {
  engine: AuthorityEngine<S, A>;
  role: 'host' | 'guest';
  maxSeats?: number;
  /** guests: the host's peer id or invite-link hint */
  host?: string | null;
}

export async function createHostAuthority<S, A = unknown>(o: AuthoritySetup<S, A>): Promise<Hosted<HostAuthority<S, A>>> {
  const { room, seat } = await seatAndRoom<HostJournal<S>>(o, `authority:${o.role}`);
  const session = new HostAuthority<S, A>({ room, engine: o.engine, role: o.role, seat, maxSeats: o.maxSeats, meta: o.meta, clock: o.clock, host: o.host ?? undefined });
  return host(session, room, seat as Seat<unknown> | null, () => session.destroy());
}
