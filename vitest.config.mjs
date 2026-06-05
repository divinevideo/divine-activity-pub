// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Vitest configuration for testing the Divine ActivityPub Gateway Worker
// ABOUTME: Uses @cloudflare/vitest-pool-workers for a Workers-environment simulation (local D1/Queues)

import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ['src/**/*.test.mjs'],
    exclude: [
      '**/node_modules/**',
      '**/.worktrees/**',
      '**/.wrangler/**',
    ],
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
});
