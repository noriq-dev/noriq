// Runner execution plane kill-switch (drop-runner Phase 1). When RUNNER_DISABLED is set,
// registration, dispatch, daemon WebSockets, and runner ingest are refused with 410 while
// coordination (MCP copilots, claims, plans, docs) stays live.

export const RUNNER_DISABLED_MESSAGE =
  'runner execution is disabled on this instance — stop noriq-runner, uninstall the daemon, and use MCP copilots for coordination only';

export const RUNNER_DISABLED_CODE = 'runner_plane_disabled';

export const RUNNER_PLANE_DRAIN_REASON = 'runner_plane_disabled';

/** Truthy check mirroring MAINTENANCE_MODE / DEMO_MODE: any value except unset / '0' / 'false'. */
export const isRunnerDisabled = (env: { RUNNER_DISABLED?: string }): boolean => {
  const v = env.RUNNER_DISABLED;
  return !!v && v !== '0' && v.toLowerCase() !== 'false';
};

export const runnerDisabledBody = (): { error: string; code: string } => ({
  error: RUNNER_DISABLED_MESSAGE,
  code: RUNNER_DISABLED_CODE,
});
