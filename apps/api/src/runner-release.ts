/**
 * The runner release this Noriq instance considers current (RUN-36).
 *
 * ## Where the number comes from: the repo
 *
 * `https://raw.githubusercontent.com/noriq-dev/runner/main/package.json`.
 *
 * Not a dedicated version.json, deliberately: package.json is ALREADY the single source of
 * truth (RUN-36 made the build inject from it, killing the hand-typed literal that could lie).
 * A second file would be a second thing to bump — and the failure mode of forgetting is a
 * version feed that disagrees with the thing it describes, which is the exact class of bug
 * RUN-36 existed to remove. One file, one number.
 *
 * This endpoint proxies rather than the daemon fetching GitHub directly, which buys three
 * things: the daemon keeps one trust root (the server it already authenticates to) instead of
 * gaining github.com; the answer is cached here rather than hammering raw.githubusercontent from
 * every runner on every interval; and `curl <noriq>/api/runner/latest` stays the one place a
 * human or a script asks, whatever we point it at next.
 *
 * It also removes the cost this file used to carry: the version was a CONSTANT, so publishing a
 * runner meant editing it and redeploying the Worker, and a stale constant told every runner it
 * was current when it wasn't. That coupling is gone — cutting a release is now a commit to the
 * runner repo.
 *
 * ## The caveat worth knowing
 *
 * main's package.json can be AHEAD of npm: bump + commit, publish later, and this reports a
 * version `npm i -g @noriq-dev/runner@latest` will not install. The window is a release
 * procedure problem (publish and push together), not a code one, but it is why the fallback
 * below is null rather than a guess — reporting a version nobody can install is worse than
 * admitting we do not know.
 */

const VERSION_SOURCE = 'https://raw.githubusercontent.com/noriq-dev/runner/main/package.json';

/** Cache at the edge. Five minutes is short enough that a release propagates while you are
 *  still looking at the terminal, and long enough that a fleet of runners on a 24h interval
 *  never meaningfully touches GitHub. */
const CACHE_TTL_S = 300;

/**
 * The current release, or null if we could not determine it.
 *
 * Never throws: this endpoint is polled by every runner, and a GitHub blip must not turn into a
 * 500 that a daemon interprets as anything at all. Null is honest — the runner treats "unknown"
 * as "not outdated", which is the only safe reading.
 */
export async function fetchLatestRunnerVersion(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(VERSION_SOURCE, {
      // Workers-native edge caching — no KV, no Durable Object, no cron to keep warm.
      cf: { cacheTtl: CACHE_TTL_S, cacheEverything: true },
      headers: { 'User-Agent': 'noriq' },
    } as RequestInit);
    if (!res.ok) return null;
    const pkg = (await res.json()) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Below this, a runner is too old for this server to trust — reserved for a real protocol or
 *  security break, NOT mere staleness. Nothing enforces it yet; it exists so the wire shape is
 *  ready and the dashboard can warn. Bumping it locks out every runner beneath it. */
export const MIN_RUNNER_VERSION: string | null = null;

/** Compare dotted numeric versions. Returns <0, 0, >0. Pre-release suffixes (-dev, -rc.1) sort
 *  before their release, which is what "0.2.0-rc.1 is older than 0.2.0" should mean. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre && !y.pre) return -1; // 1.0.0-rc < 1.0.0
  if (!x.pre && y.pre) return 1;
  if (x.pre && y.pre) return x.pre === y.pre ? 0 : x.pre < y.pre ? -1 : 1;
  return 0;
}

/** Is `version` behind `latest`? Unknown on EITHER side is NOT outdated — a runner that predates
 *  version reporting is unknown, and a version feed we could not reach tells us nothing. Saying
 *  "outdated" in either case would be inventing a fact. */
export const isOutdated = (version: string | null, latest: string | null): boolean =>
  version != null && latest != null && compareVersions(version, latest) < 0;
