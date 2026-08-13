import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations')
  return {
    plugins: [
      cloudflareTest({
        main: './email-worker/src/index.ts',
        miniflare: {
          compatibilityDate: '2026-07-27',
          compatibilityFlags: ['nodejs_compat'],
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_ORIGINS: 'https://mail.example.com',
            SUPER_ADMIN_EMAIL: 'owner@example.com',
            SETUP_TOKEN: 'integration-setup-token-32-bytes',
          },
          d1Databases: ['DB'],
          r2Buckets: ['MAIL_BUCKET'],
          queueProducers: {
            MAIL_QUEUE: { queueName: 'omnimail-mail' },
          },
        },
      }),
    ],
    test: {
      include: ['email-worker/integration/**/*.integration.ts'],
    },
  }
})
