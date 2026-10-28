// Release policy is independent of credentials and process execution for testing.
export function assertProductionContext(env) {
  if (env.GITHUB_REPOSITORY !== 'divinevideo/divine-activity-pub' ||
      env.GITHUB_REF !== 'refs/heads/main' ||
      !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) {
    throw new Error('Production requires a checked main push or main manual replay');
  }
  if (env.PRODUCTION_CD_ENABLED !== 'true') {
    throw new Error('Production CD prerequisites have not been confirmed; see DEPLOYMENT.md');
  }
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'GH_TOKEN']) {
    if (!env[name]) throw new Error(`Missing required credential: ${name}`);
  }
}

export function activeVersion(result) {
  const deployment = result.deployments?.[0];
  if (deployment?.versions?.length !== 1 || deployment.versions[0].percentage !== 100) {
    throw new Error('Expected one active production version at 100%');
  }
  return deployment.versions[0].version_id;
}

export async function release({ env, github, cloudflare, deploy, health, receipt }) {
  assertProductionContext(env);
  // Inside the production concurrency lock, reject reruns of superseded commits.
  const main = await github();
  if (main.sha !== env.GITHUB_SHA) throw new Error('Checked commit is no longer current main');
  receipt.previous_version = activeVersion(await cloudflare('/deployments'));
  await deploy();
  receipt.version = activeVersion(await cloudflare('/deployments'));
  const version = await cloudflare(`/versions/${receipt.version}`);
  if (version.annotations?.['workers/tag'] !== env.GITHUB_SHA) {
    throw new Error('Active provider version does not identify the checked commit');
  }
  const response = await health();
  if (response.status !== 'ok' || response.service !== 'divine-activity-pub' ||
      response.version !== receipt.version || response.source !== env.GITHUB_SHA) {
    throw new Error('Public production health does not match the active checked version');
  }
  // Detect an out-of-band activation during public verification, too.
  if (activeVersion(await cloudflare('/deployments')) !== receipt.version) {
    throw new Error('Production version changed during verification');
  }
  receipt.result = 'verified';
}
