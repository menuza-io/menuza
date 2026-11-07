import { JWTAuthApi } from '../jwt-auth-api'

const mockStored = {
	tokens: {
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		expiresIn: 900,
		// Expired: refreshing must still present the mockStored refresh token.
		expiresAt: new Date(Date.now() - 60_000).toISOString(),
	} as null | {
		accessToken: string
		refreshToken: string
		expiresIn: number
		expiresAt: string
	},
}

const mockManager = {
	validateTokens: jest.fn(async () => ({
		isValid: false,
		isExpired: true,
		needsRefresh: false,
		tokens: mockStored.tokens,
	})),
	getCurrentTokens: jest.fn(async () => null),
	getUser: jest.fn(async () => ({ id: 'user-1' })),
	storeTokens: jest.fn(async (tokens: typeof mockStored.tokens) => {
		mockStored.tokens = tokens
	}),
	clearTokens: jest.fn(async () => {
		mockStored.tokens = null
	}),
}

jest.mock('../../storage/session-manager', () => ({
	TokenManager: { getInstance: () => mockManager },
}))

global.fetch = jest.fn()
const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>

function jsonResponse(status: number, body: unknown) {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: '',
		headers: { get: () => 'application/json' },
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response
}

const REFRESHED = {
	success: true,
	data: {
		accessToken: 'access-2',
		refreshToken: 'refresh-2',
		expiresIn: 900,
		expiresAt: new Date(Date.now() + 900_000).toISOString(),
	},
}

function refreshCalls() {
	return mockFetch.mock.calls.filter(([url]) =>
		String(url).endsWith('/api/auth/refresh'),
	)
}

describe('operator session refresh', () => {
	let api: JWTAuthApi

	beforeEach(() => {
		jest.clearAllMocks()
		mockStored.tokens = {
			accessToken: 'access-1',
			refreshToken: 'refresh-1',
			expiresIn: 900,
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
		}
		api = new JWTAuthApi({ baseUrl: 'https://app.test', retryAttempts: 0 })
	})

	it('runs one refresh for every concurrent caller', async () => {
		let release: (value: Response) => void = () => {}
		mockFetch.mockImplementation(async (url) => {
			if (String(url).endsWith('/api/auth/refresh')) {
				return new Promise<Response>((resolve) => {
					release = resolve
				})
			}
			return jsonResponse(200, { ok: true })
		})

		const calls = [
			api.refreshTokens('refresh-1', 'user-1'),
			api.refreshTokens('refresh-1', 'user-1'),
			api.getOrganizations(),
		]
		await new Promise((resolve) => setImmediate(resolve))
		release(jsonResponse(200, REFRESHED))
		const [a, b] = await Promise.all(calls)

		expect(refreshCalls()).toHaveLength(1)
		expect(a).toMatchObject({ success: true })
		expect(b).toMatchObject({ success: true })
		expect(mockStored.tokens?.refreshToken).toBe('refresh-2')
	})

	it.each([429, 500, 503])(
		'keeps the session when refresh answers %i',
		async (status) => {
			mockFetch.mockResolvedValue(jsonResponse(status, { success: false }))
			const result = await api.refreshTokens('refresh-1', 'user-1')
			expect(result.success).toBe(false)
			expect(mockManager.clearTokens).not.toHaveBeenCalled()
			expect(mockStored.tokens?.refreshToken).toBe('refresh-1')
		},
	)

	it('keeps the session and does not retry when the refresh response is lost', async () => {
		mockFetch.mockRejectedValue(new TypeError('Network request failed'))
		const result = await api.refreshTokens('refresh-1', 'user-1')
		expect(result.success).toBe(false)
		expect(refreshCalls()).toHaveLength(1)
		expect(mockManager.clearTokens).not.toHaveBeenCalled()
	})

	it('keeps the session when an API call cannot refresh because of a server error', async () => {
		mockFetch.mockImplementation(async (url) =>
			String(url).endsWith('/api/auth/refresh')
				? jsonResponse(503, { success: false })
				: jsonResponse(401, { error: 'unauthorized' }),
		)
		await api.getOrganizations()
		expect(refreshCalls()).toHaveLength(1)
		expect(mockManager.clearTokens).not.toHaveBeenCalled()
	})

	it('ends the session when the server refuses the refresh token', async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(401, { success: false, error: 'invalid_refresh_token' }),
		)
		const result = await api.refreshTokens('refresh-1', 'user-1')
		expect(result).toMatchObject({ success: false, status: 401 })
		expect(mockManager.clearTokens).toHaveBeenCalled()
	})
})
