import 'varlock/auto-load'
import { vi } from 'vitest'

// Suites that are not about quiet hours (#75) send marketing texts at any
// clock; the quiet-hours suites turn this back on. Honoured only under Vitest.
process.env.MARKETING_SMS_QUIET_HOURS ??= 'off'

// The monthly text allowance (#247) lives in the App. Suites that send texts
// have no App to ask, which is what a bare local run looks like
// (`not_configured`: nothing is counted); the allowance suites say otherwise.
vi.mock('../src/lib/sms-allowance-client.ts', () => ({
	postSmsAllowance: vi.fn(async () => ({ ok: 'not_configured' })),
}))
