#!/usr/bin/env node

const args = process.argv.slice(2);
const values = (flag) => args.flatMap((arg, index) => arg === flag && args[index + 1] ? [args[index + 1]] : []);
const first = (flag) => values(flag)[0];
const json = args.includes('--json');
const baseUrl = (first('--url') ?? process.env.NORIQ_URL ?? '').replace(/\/$/, '');
const sessionCookie = process.env.NORIQ_SESSION_COOKIE ?? '';
const targets = [...values('--target'), ...(process.env.NORIQ_ACCEPTANCE_TARGETS ?? '').split(',').map((value) => value.trim()).filter(Boolean)];

const usage = () => {
  console.error('Usage: NORIQ_SESSION_COOKIE="noriq_session=..." npm run memory:acceptance -- --url https://noriq.example --target PROJECT:TASK:REPOSITORY[:BRANCH[:BASE_ID]] [--target ...] [--json]');
};

if (!baseUrl || !sessionCookie || targets.length === 0) {
  usage();
  process.exitCode = 2;
} else {
  const headers = { Cookie: sessionCookie, Accept: 'application/json' };
  const request = async (path, init = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    const body = await response.json().catch(() => ({ error: `non-JSON response (${response.status})` }));
    if (!response.ok) throw new Error(`${path}: ${body.error ?? response.statusText}`);
    return body;
  };
  try {
    const { projects } = await request('/api/projects');
    const reports = [];
    for (const raw of targets) {
      const [projectKey, taskId, repositoryKey, explicitBranch, explicitBaseId] = raw.split(':');
      if (!projectKey || !taskId || !repositoryKey) throw new Error(`invalid target "${raw}"; expected PROJECT:TASK:REPOSITORY[:BRANCH[:BASE_ID]]`);
      const project = projects.find((candidate) => candidate.key === projectKey || candidate.id === projectKey);
      if (!project) throw new Error(`project ${projectKey} is not visible to this session`);
      const repositoryResponse = await request(`/api/projects/${encodeURIComponent(project.id)}/memory/repositories`);
      const repository = repositoryResponse.repositories.find((candidate) => candidate.repositoryKey === repositoryKey);
      const branch = explicitBranch || repository?.activeGeneration?.branch || repository?.defaultBranch || null;
      const baseId = explicitBaseId || repository?.activeGeneration?.baseId || null;
      const report = await request(`/api/projects/${encodeURIComponent(project.id)}/memory/acceptance`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, repositoryKey, branch, baseId }),
      });
      reports.push(report);
    }

    if (json) console.log(JSON.stringify({ proof: 'live-environment', reports }, null, 2));
    else {
      console.log('# Project Memory live acceptance');
      console.log('');
      console.log(`Environment: ${baseUrl}`);
      console.log('Proof: live-environment (authenticated REST reads; no fixture substitution)');
      for (const report of reports) {
        console.log('');
        console.log(`## ${report.target.taskKey} — ${report.passed ? 'PASS' : 'FAIL'}`);
        console.log('');
        console.log(`Scope: ${report.target.repositoryKey ?? 'unspecified'} ${report.target.branch ?? '?'}@${report.target.baseId ?? '?'}`);
        console.log(`Summary: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.unanswerable} unanswerable`);
        console.log('');
        console.log('| Result | Criterion | Observed |');
        console.log('|---|---|---|');
        for (const criterion of report.criteria) {
          const observed = String(criterion.observed).replaceAll('|', '\\|').replaceAll('\n', ' ');
          console.log(`| ${criterion.status.toUpperCase()} | ${criterion.label} | ${observed} |`);
        }
      }
    }
    if (reports.some((report) => !report.passed)) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
