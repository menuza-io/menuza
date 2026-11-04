import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	DEV_OPERATOR_ANALYTICS_TOKEN,
	getOperatorAnalyticsToken,
	syncEnvFromProcess,
} from './secrets.ts'

describe('getOperatorAnalyticsToken', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
		syncEnvFromProcess()
	})

	it('refuses the schema default when NODE_ENV is unset', () => {
		vi.stubEnv('OPERATOR_ANALYTICS_TOKEN', DEV_OPERATOR_ANALYTICS_TOKEN)
		vi.stubEnv('NODE_ENV', '')
		syncEnvFromProcess()
		expect(getOperatorAnalyticsToken()).toBe('')
	})

	it('accepts the schema default in development', () => {
		vi.stubEnv('OPERATOR_ANALYTICS_TOKEN', DEV_OPERATOR_ANALYTICS_TOKEN)
		vi.stubEnv('NODE_ENV', 'development')
		vi.stubEnv(
			'INTERNAL_COMMAND_TOKEN',
			'dev-internal-command-token-do-not-use-in-prod',
		)
		syncEnvFromProcess()
		expect(getOperatorAnalyticsToken()).toBe(DEV_OPERATOR_ANALYTICS_TOKEN)
	})
})
