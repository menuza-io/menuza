import { beforeAll, afterEach, vi } from 'vitest'

vi.mock('@repo/observability', () => ({
	logger: {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
		child: vi.fn(() => ({
			error: vi.fn(),
			warn: vi.fn(),
			info: vi.fn(),
			debug: vi.fn(),
		})),
	},
}))

// Configure test environment
beforeAll(() => {
	// Set test environment variables
	process.env.NODE_ENV = 'test'
	process.env.STRIPE_SECRET_KEY = 'sk_test_mock_key_for_testing'
	process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_mock_webhook_secret'

	// Mock console methods to reduce noise in tests
	global.console = {
		...console,
		log: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}
})

// Reset after each test
afterEach(() => {
	vi.clearAllMocks()
})
