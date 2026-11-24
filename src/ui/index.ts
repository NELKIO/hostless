/**
 * hostless/ui — optional, framework-free Web Components (Shadow DOM, no dependencies).
 *
 *   <hostless-lobby>     create / join a room, live player list   (.room)
 *   <hostless-link>      connection pill: status, route and rtt per peer   (.room)
 *   <hostless-sync>      link devices for DeviceSync   (.sync)
 *   <hostless-netcheck>  "Check connection" report   (.options, .check)
 *
 * Importing this module registers nothing; call defineHostlessElements() (or import
 * 'hostless/ui/register' as a side-effect module).
 */
import { HostlessLobby } from './lobby.js';
import { HostlessLink } from './link-badge.js';
import { HostlessSync } from './sync-panel.js';
import { HostlessNetcheck } from './netcheck.js';
import { report } from './base.js';

export { HostlessLobby, type HostlessRoomDetail } from './lobby.js';
export { HostlessLink } from './link-badge.js';
export { HostlessSync } from './sync-panel.js';
export { HostlessNetcheck } from './netcheck.js';
export { HostlessElement, type RoomLike, type SyncLike } from './base.js';
export { STRINGS, resolveLang, translate, type Lang, type StringKey } from './i18n.js';
export { BASE_CSS } from './styles.js';

export const HOSTLESS_ELEMENTS = {
  lobby: HostlessLobby,
  link: HostlessLink,
  sync: HostlessSync,
  netcheck: HostlessNetcheck,
} as const;

/**
 * Register the elements as `<prefix>-lobby`, `<prefix>-link`, `<prefix>-sync`, `<prefix>-netcheck`.
 * Idempotent: names that are already defined are skipped. Returns the tag names now defined
 * (an empty object outside a browser).
 */
export function defineHostlessElements(prefix = 'hostless'): Partial<Record<keyof typeof HOSTLESS_ELEMENTS, string>> {
  const registry = typeof globalThis.customElements === 'object' && globalThis.customElements ? globalThis.customElements : null;
  const defined: Partial<Record<keyof typeof HOSTLESS_ELEMENTS, string>> = {};
  if (!registry) return defined;
  const base = String(prefix || 'hostless').trim().toLowerCase() || 'hostless';
  for (const [suffix, ctor] of Object.entries(HOSTLESS_ELEMENTS) as Array<[keyof typeof HOSTLESS_ELEMENTS, CustomElementConstructor]>) {
    const name = `${base}-${suffix}`;
    try {
      if (!registry.get(name)) {
        try {
          registry.define(name, ctor);
        } catch (error) {
          // a constructor can back only one name: under a second prefix, register a subclass
          if (registry.get(name)) {
            /* defined concurrently */
          } else if (error instanceof Error && error.name === 'SyntaxError') {
            throw error;
          } else {
            registry.define(name, class extends (ctor as typeof HTMLElement) {});
          }
        }
      }
      defined[suffix] = name;
    } catch (error) {
      report(error);
    }
  }
  return defined;
}
