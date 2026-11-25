// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Vitest configuration for testing the Divine ActivityPub Gateway Worker
// ABOUTME: Uses @cloudflare/vitest-plugin to simulate Workers with local D1 and Queues

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    remoteBindings: false,
    wrangler: { configPath: './wrangler.toml' },
  })],
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ['src/**/*.test.mjs'],
    exclude: [
      '**/node_modules/**',
      '**/.worktrees/**',
      '**/.wrangler/**',
    ],
  },
});
