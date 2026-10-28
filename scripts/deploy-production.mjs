import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { release } from './release.mjs';

const env = process.env;
const receipt = {
  source_sha: env.GITHUB_SHA, environment: 'production', worker: 'divine-activity-pub',
  run_id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT,
  started_at: new Date().toISOString(), result: 'failed',
};

async function json(url, token) {
  const response = await fetch(url, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/json' },
    signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Read failed with HTTP ${response.status}`);
  return response.json();
}

try {
  await release({
    env, receipt,
    github: () => json('https://api.github.com/repos/divinevideo/divine-activity-pub/commits/main', env.GH_TOKEN),
    cloudflare: async (path) => {
      const data = await json(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/divine-activity-pub${path}`, env.CLOUDFLARE_API_TOKEN);
      if (!data.success) throw new Error('Provider read was not successful');
      return data.result;
    },
    deploy: async () => {
      const result = spawnSync('npm', ['run', 'deploy', '--', '--config', 'wrangler.toml', '--keep-vars', '--tag', env.GITHUB_SHA, '--message', `GitHub ${env.GITHUB_RUN_ID} source ${env.GITHUB_SHA}`], {
        stdio: 'inherit', env, timeout: 300000,
      });
      if (result.error || result.status !== 0) throw new Error('Wrangler deployment failed');
    },
    health: () => json(`https://divine.video/ap/health?release=${env.GITHUB_SHA}`, undefined),
  });
} catch (error) {
  receipt.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  receipt.finished_at = new Date().toISOString();
  writeFileSync('release-result.json', JSON.stringify(receipt, null, 2) + '\n');
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `## Production release\n\n\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\`\n`);
  }
}
