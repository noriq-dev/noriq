/**
 * The runner release this Noriq instance considers current (RUN-36).
 *
 * ## Why the server, and not git or npm
 *
 * The task weighed four homes for this number. Three of them do not work *today*:
 *
 *  - **A committed version.json via raw.githubusercontent** — the runner repo is private
 *    (RUN-39 is deferred, so there is no LICENSE yet and it cannot go public), so a raw fetch
 *    needs a token. "Curl-able" and "bring your own GitHub credential" are not the same thing.
 *  - **Git tags / the Releases API** — same privacy problem, and nothing cuts tags yet.
 *  - **The npm registry** — canonical *once published*, and `npx @noriq-dev/runner` is the
 *    documented install path, so this is where it should end up. Nothing is published yet.
 *
 * The server works now, needs no new trust root (the daemon already holds an authenticated
 * channel to it, and this route is public so a human can curl it), and has no third-party rate
 * limit. RUN-37 (auto-update) can consume it immediately.
 *
 * ## The cost, stated plainly
 *
 * It couples runner releases to server deploys: publishing a runner means editing this constant
 * and redeploying the Worker. That is real friction and it is the reason to move to the npm
 * registry the moment the package is published — at which point this endpoint should proxy
 * `registry.npmjs.org/@noriq-dev/runner/latest` (cached) rather than hardcode, and this comment
 * should be deleted. Until then a stale constant here means runners think they are current when
 * they are not, which is a quieter failure than it looks: keep it in the release checklist.
 */
export const LATEST_RUNNER_VERSION = '0.1.0';

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

/** Is `version` behind the current release? Unknown (null) is NOT outdated — a runner that
 *  predates version reporting is unknown, and saying "outdated" would be inventing a fact. */
export const isOutdated = (version: string | null): boolean =>
  version != null && compareVersions(version, LATEST_RUNNER_VERSION) < 0;
