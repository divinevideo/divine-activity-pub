import { describe, it, expect, vi } from 'vitest';
import worker from './index.mjs';
import { release, assertProductionContext, activeVersion } from '../scripts/release.mjs';

const sha = 'a'.repeat(40);
const context = () => ({
  GITHUB_REPOSITORY: 'divinevideo/divine-activity-pub', GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'push', GITHUB_SHA: sha, PRODUCTION_CD_ENABLED: 'true',
  CLOUDFLARE_ACCOUNT_ID: 'synthetic', CLOUDFLARE_API_TOKEN: 'synthetic', GH_TOKEN: 'synthetic',
});
const active = (id) => ({ deployments: [{ versions: [{ version_id: id, percentage: 100 }] }] });
function fixture() {
  let deployed = false;
  return {
    env: context(), receipt: { result: 'failed' },
    wait: vi.fn(async () => {}),
    github: vi.fn(async () => ({ sha })),
    cloudflare: vi.fn(async path => path.startsWith('/versions/')
      ? { annotations: { 'workers/tag': sha } } : active(deployed ? 'new-version' : 'old-version')),
    deploy: vi.fn(async () => { deployed = true; }),
    health: vi.fn(async () => ({ status: 'ok', service: 'divine-activity-pub', version: 'new-version', source: sha })),
  };
}

describe('production release', () => {
  it.each([
    ['GITHUB_EVENT_NAME', 'pull_request'], ['GITHUB_REF', 'refs/heads/topic'],
    ['GITHUB_REPOSITORY', 'example/fork'], ['GITHUB_SHA', 'not-a-sha'],
    ['PRODUCTION_CD_ENABLED', ''], ['CLOUDFLARE_API_TOKEN', ''],
    ['CLOUDFLARE_ACCOUNT_ID', ''], ['GH_TOKEN', ''],
  ])('rejects unsafe context %s', async (name, value) => {
    const f = fixture(); f.env[name] = value;
    await expect(release(f)).rejects.toThrow();
    expect(f.deploy).not.toHaveBeenCalled();
  });
  it('allows explicit manual replay on main', () => {
    expect(() => assertProductionContext({ ...context(), GITHUB_EVENT_NAME: 'workflow_dispatch' })).not.toThrow();
  });
  it('rejects a superseded checked commit before deploy', async () => {
    const f = fixture(); f.github.mockResolvedValue({ sha: 'b'.repeat(40) });
    await expect(release(f)).rejects.toThrow('no longer current main');
    expect(f.deploy).not.toHaveBeenCalled();
  });
  it('records previous and active versions only after verification', async () => {
    const f = fixture(); await release(f);
    expect(f.receipt).toEqual({ result: 'verified', previous_version: 'old-version', version: 'new-version' });
    expect(f.deploy).toHaveBeenCalledTimes(1);
  });
  it('propagates deploy failure without reporting success', async () => {
    const f = fixture(); f.deploy.mockRejectedValue(new Error('failed'));
    await expect(release(f)).rejects.toThrow('failed');
    expect(f.health).not.toHaveBeenCalled(); expect(f.receipt.result).toBe('failed');
  });
  it('retries stale public health without repeating deployment', async () => {
    const f = fixture();
    f.health.mockResolvedValueOnce({ status: 'ok', service: 'divine-activity-pub', version: 'old-version', source: 'b'.repeat(40) });
    await release(f);
    expect(f.receipt.result).toBe('verified');
    expect(f.wait).toHaveBeenCalledWith(5000);
    expect(f.health).toHaveBeenCalledTimes(2);
    expect(f.deploy).toHaveBeenCalledTimes(1);
  });
  it('retries stale provider reads before checking public health', async () => {
    const f = fixture(); const original = f.cloudflare.getMockImplementation();
    let stale = true;
    f.cloudflare.mockImplementation(async path => {
      if (path.startsWith('/versions/') && stale) {
        stale = false; return { annotations: { 'workers/tag': 'b'.repeat(40) } };
      }
      return original(path);
    });
    await release(f);
    expect(f.receipt.result).toBe('verified'); expect(f.deploy).toHaveBeenCalledTimes(1);
    expect(f.wait).toHaveBeenCalledTimes(1);
  });
  it('rejects an unrelated active provider version', async () => {
    const f = fixture(); f.cloudflare.mockImplementation(async path => path.startsWith('/versions/')
      ? { annotations: { 'workers/tag': 'b'.repeat(40) } } : active('version'));
    await expect(release(f)).rejects.toThrow('does not identify');
    expect(f.health).not.toHaveBeenCalled();
  });
  it.each(['status', 'service', 'version', 'source'])('rejects health mismatch: %s', async field => {
    const f = fixture(); const health = await f.health(); health[field] = 'wrong';
    f.health.mockClear().mockResolvedValue(health);
    await expect(release(f)).rejects.toThrow('health does not match');
    expect(f.receipt.result).toBe('failed');
    expect(f.health).toHaveBeenCalledTimes(6);
    expect(f.deploy).toHaveBeenCalledTimes(1);
  });
  it('rejects activation changed during verification', async () => {
    const f = fixture(); const original = f.cloudflare.getMockImplementation();
    let reads = 0;
    f.cloudflare.mockImplementation(async path => {
      if (path === '/deployments' && ++reads > 1 && reads % 2 === 1) return active('other-version');
      return original(path);
    });
    await expect(release(f)).rejects.toThrow('changed during verification');
  });
  it('rejects split traffic or missing deployment metadata', () => {
    expect(() => activeVersion({})).toThrow();
    expect(() => activeVersion({ deployments: [{ versions: [{ percentage: 50 }, { percentage: 50 }] }] })).toThrow();
  });
});

it('serves uncached version health without any database or upstream binding', async () => {
  const response = await worker.fetch(new Request('https://gateway.example/ap/health'), {
    CF_VERSION_METADATA: { id: 'version', tag: sha },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ status: 'ok', service: 'divine-activity-pub', version: 'version', source: sha });
});
