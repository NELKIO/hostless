/** The part of a WebSocket the library uses, so tests can inject in-memory sockets. */
export interface WsLike {
  readonly readyState: number;
  binaryType?: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export type WsFactory = (url: string, protocols?: string | string[]) => WsLike;

export const WS_OPEN = 1;

export const defaultWsFactory: WsFactory = (url, protocols) => {
  const Ctor = (globalThis as { WebSocket?: new (u: string, p?: string | string[]) => WsLike }).WebSocket;
  if (!Ctor) throw new Error('hostless: no WebSocket in this environment');
  return new Ctor(url, protocols);
};
