import { describe, expect, it, vi } from 'vitest'
import adminConfig from '../../../admin/playwright.config.ts'
import appConfig from '../../playwright.config.ts'

vi.mock('varlock/auto-load', () => ({}))

describe.each([
	['App', appConfig],
	['Admin', adminConfig],
])('%s Playwright server environment', (ignoredName, config) => {
	it('discards the runner snapshot before enabling server mocks', () => {
		const server = config.webServer
		if (!server || Array.isArray(server)) {
			throw new Error('Expected a single Playwright server')
		}

		// Playwright merges the runner's env before applying server overrides.
		const serverEnv: Record<string, string | undefined> = {
			__VARLOCK_ENV: '{"config":{"MOCKS":{"value":false}}}',
			MOCKS: 'false',
			...server.env,
		}
		expect(serverEnv.__VARLOCK_ENV).toBe('')
		expect(serverEnv.MOCKS).toBe('true')
		expect(serverEnv.AUDIT_LOG_SECRET_KEY).toBeTruthy()
	})
})
