// Which brain played a game whose save doesn't say.
//
// Save headers have carried `botVersion` on every bot seat since the day this
// file was added; the 59 games with a bot seat played before that say only
// `isBot: true`. What they do carry is when they were played, and the
// repository knows which `BOT_VERSION` was live on any given day — so the
// version is recoverable, as an inference rather than a record.
//
// The table is `[since, version]` pairs: the commit time at which each
// `BOT_VERSION` landed in `botBrain.js`, in order. Regenerated, should it ever
// need to be, by walking that file's history:
//
//   for h in $(git log --format='%H' --reverse -- server/botBrain.js); do
//     d=$(git show -s --format='%cI' "$h")
//     v=$(git cat-file -p "${h}:server/botBrain.js" |
//         grep -m1 'BOT_VERSION = ' | sed "s/.*'\([^']*\)'.*/\1/")
//     [ -n "$v" ] && echo "$d $v"
//   done | awk '$2 != prev {print; prev=$2}'
//
// It is a frozen historical fixture and does NOT want a new row at the next
// version bump: every save written from here on records its own version, so
// the table is only ever consulted for games that predate the header field.
//
// Two things make this an inference and not a fact, which is why the clients
// print it with a tilde — `🤖 Robo (~2.28)`:
//   - The host's server is long-running. A game started ten minutes after a
//     bump, on a process booted before it, ran the OLD brain; the table sees
//     commits, not boots.
//   - Games played before `BOT_VERSION` existed at all (anything earlier than
//     the first row) get no version, and render as a bare 🤖.
const BOT_VERSION_TIMELINE = [
  ['2026-07-17T23:28:16Z', '1.1'],
  ['2026-07-17T23:30:56Z', '1.2'],
  ['2026-07-17T23:45:56Z', '1.3'],
  ['2026-07-17T23:54:42Z', '1.4'],
  ['2026-07-18T00:04:16Z', '1.5'],
  ['2026-07-18T03:38:33Z', '1.6'],
  ['2026-07-18T09:27:53Z', '1.7'],
  ['2026-07-19T05:18:11Z', '1.8'],
  ['2026-07-19T05:25:48Z', '1.9'],
  ['2026-07-19T08:06:46Z', '2.0'],
  ['2026-07-19T11:00:30Z', '2.1'],
  ['2026-07-19T12:01:25Z', '2.2'],
  ['2026-07-19T13:45:50Z', '2.3'],
  ['2026-07-19T14:45:10Z', '2.4'],
  ['2026-07-20T08:48:40Z', '2.5'],
  ['2026-07-20T14:27:56Z', '2.6'],
  ['2026-07-20T15:34:07Z', '2.7'],
  ['2026-07-22T04:47:02Z', '2.8'],
  ['2026-07-22T04:50:57Z', '2.9'],
  ['2026-07-22T08:12:52Z', '2.10'],
  ['2026-07-22T08:51:26Z', '2.11'],
  ['2026-07-22T09:03:27Z', '2.12'],
  ['2026-07-22T09:25:18Z', '2.13'],
  ['2026-07-22T09:36:07Z', '2.14'],
  ['2026-07-25T11:24:17Z', '2.15'],
  ['2026-07-25T12:34:45Z', '2.16'],
  ['2026-07-26T13:19:33Z', '2.17'],
  ['2026-08-11T13:26:40Z', '2.18'],
  ['2026-08-11T15:15:29Z', '2.19'],
  ['2026-08-11T18:02:44Z', '2.20'],
  ['2026-08-11T19:04:58Z', '2.21'],
  ['2026-08-11T19:47:50Z', '2.22'],
  ['2026-08-12T05:25:42Z', '2.23'],
  ['2026-08-12T05:53:37Z', '2.24'],
  ['2026-08-12T14:40:16Z', '2.25'],
  ['2026-08-14T07:11:59Z', '2.26'],
  ['2026-08-15T05:49:30Z', '2.27'],
  ['2026-08-15T07:59:45Z', '2.28'],
  ['2026-08-22T11:31:30Z', '2.29'],
].map(([since, version]) => ({ since: Date.parse(since), version }));

// The brain live at `startedAt`, or null for a game older than versioning.
export function inferBotVersion(startedAt) {
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return null;
  let found = null;
  for (const row of BOT_VERSION_TIMELINE) {
    if (t < row.since) break;
    found = row.version;
  }
  return found;
}
