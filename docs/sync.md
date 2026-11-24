# Device sync and public statistics

## DeviceSync

One document per player, encrypted, compressed and stored on Nostr relays as a replaceable event.
The sync key (32 symbols, 160 bits) is the account: the first device creates it, the next ones get
it as a link `…#sync=KEY` or by typing it.

```ts
const sync = createDeviceSync<Save>({
  app: 'my-game',
  store: { read: () => save, write: (next) => persist(next), subscribe: (f) => onLocalChange(f) },
  merge: (local, remotes) => remotes.reduce(join, local),   // MUST be a join (see below)
  version: 1,                                               // bump when the format changes
});
sync.start();                          // periodic sync (90 s), on visibility, after local changes (2.5 s)
await sync.link(DeviceSync.newKey());  // first device
await sync.link(text);                 // next devices: a key or a #sync= link
sync.status;                           // off | syncing | ok | offline | unreadable | outdated | error | paused
```

Guards (from a game that shipped this): an authentic document that cannot be read blocks
publishing (`unreadable`); a document written by a newer version is neither merged nor overwritten
(`outdated`, ask the user to refresh); a device whose clock runs ahead is followed by at most ten
minutes; relays that refuse future timestamps get the time of the newest event they hold; one sync
runs at a time and every request during a run gets one more run after it.

## Writing `merge`

The merge must be commutative, associative and idempotent, or devices will disagree. Build it from
`crdt`:

| need | use |
|---|---|
| counters that only grow (xp, wins, cards collected) | `ledger.record(l, device, totals)` locally, `ledger.merge` to join, `ledger.total` to show |
| "latest choice wins" (selected team, settings) | `lww({ at, value })` with `setLww(value)` |
| collections | `union` |
| best score | `max` |
| a record of the above | `object({ field: merger, ... })` (unknown fields: deterministic `pickMax`) |
| per-key maps | `mapOf(inner)` |

Property tests check the laws for every merger (`tests/unit/crdt.test.ts`); run your own composite
through the same `laws()` helper.

## PublicStats

```ts
const stats = createPublicStats({ app: 'my-game', report: () => ({ games, wins, byHero: { … } }) });
stats.schedule();              // after changes; publishes after 20 s of quiet
const t = await stats.totals(); // { players, sums, maps }
top(t.maps.byHero, 3);
```

Each browser keeps a key and replaces its own report, so nothing is counted twice. With DeviceSync,
report only this device's part: `ledger.of(save.xp, [deviceId('my-game')])`. Totals are indicative:
anyone can publish reports.
