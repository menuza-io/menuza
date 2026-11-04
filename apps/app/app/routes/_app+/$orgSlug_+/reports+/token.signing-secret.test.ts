import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader } from './token.ts'

/**
 * The schema default for OPERATOR_ANALYTICS_TOKEN is a placeholder. A real
 * production deploy must refuse it, but E2E and `npm run build` + preview run a
 * production build on localhost with that default and still need report tokens.
 */
async function status(slug: string, cookie: string) {
	const args = {
		request: createAuthenticatedRequest(
			`http://localhost:3000/${slug}/reports/token`,
			{},
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never
	try {
		const result = (await loader(args)) as { data?: { token?: string } }
		return result.data?.token ? 200 : 500
	} catch (error) {
		return (error as { init?: { status?: number } }).init?.status ?? 500
	}
}

describe('reports token signing secret', () => {
	beforeEach(() => {
		// A refused secret logs `operator_analytics_token_not_configured`.
		vi.spyOn(console, 'error').mockImplementation(() => {})
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})

	it('accepts the schema default outside production', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		expect(await status(organization.slug, cookie)).toBe(200)
	})

	it('accepts the schema default in a production build on localhost (E2E)', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		vi.stubEnv('NODE_ENV', 'production')
		vi.stubEnv('BASE_URL', 'http://localhost:3001')
		expect(await status(organization.slug, cookie)).toBe(200)
	})

	it('refuses the schema default on a real production deploy', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		vi.stubEnv('NODE_ENV', 'production')
		vi.stubEnv('BASE_URL', 'https://app.example.com')
		expect(await status(organization.slug, cookie)).toBe(503)
	})

	it('refuses the schema default in production when BASE_URL is missing', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		vi.stubEnv('NODE_ENV', 'production')
		vi.stubEnv('BASE_URL', '')
		expect(await status(organization.slug, cookie)).toBe(503)
	})
})
