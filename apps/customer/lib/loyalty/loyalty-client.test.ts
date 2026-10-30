import {
	LOYALTY_ERROR_HTTP_STATUS,
	LOYALTY_MEMBER_CODE_TTL_MS,
	loyaltyApprovalResponseSchema,
	loyaltyApprovalsResponseSchema,
	loyaltyHistoryResponseSchema,
	loyaltyMemberCodeResponseSchema,
	loyaltyProgramResponseSchema,
	loyaltyWalletResponseSchema,
} from '@repo/loyalty'
import {
	createAttemptKeys,
	isRetryableLoyaltyError,
	LoyaltyClientError,
	loyaltyErrorCodeFrom,
	loyaltyErrorFromResponse,
	memberCodeDeadline,
} from '@/lib/loyalty/loyalty-client'
import {
	decodeFixture,
	fixtureJson,
	testApproval,
	testEntry,
	testProgram,
	testWallet,
} from '@/test/loyalty/fixtures'
import { makeLoyaltyClient } from '@/test/loyalty/session'
import { failingTransport, header, StubTransport } from '@/test/stub-transport'
import { makeConfiguration } from '@/test/support'

const ORIGIN = 'https://acme.epic-startup.com'

function boundConfiguration() {
	return makeConfiguration({ slug: 'acme', origin: ORIGIN })
}

async function setup(
	transport: StubTransport,
	options: { newKey?: () => string } = {},
) {
	return makeLoyaltyClient(transport.send, {
		configuration: boundConfiguration(),
		newKey: options.newKey ?? (() => 'generated-key'),
	})
}

describe('contract fixtures', () => {
	it('decodes the program and its absence', async () => {
		const transport = new StubTransport([
			{ raw: JSON.stringify(fixtureJson('program')) },
			{ raw: JSON.stringify(fixtureJson('program-none')) },
		])
		const { client } = await setup(transport)
		await expect(client.program()).resolves.toEqual(
			decodeFixture(loyaltyProgramResponseSchema, 'program').program,
		)
		await expect(client.program()).resolves.toBeNull()
	})

	it.each([
		'wallet-member',
		'wallet-none',
		'wallet-paused',
		'wallet-suspended',
		'wallet-after-approval',
	] as const)('decodes %s through the wallet call', async (name) => {
		const transport = new StubTransport([
			{ raw: JSON.stringify(fixtureJson(name)) },
		])
		const { client } = await setup(transport)
		const expected = decodeFixture(loyaltyWalletResponseSchema, name).wallet
		await expect(client.wallet()).resolves.toEqual(expected)
	})

	it('decodes history pages', async () => {
		const transport = new StubTransport([
			{ raw: JSON.stringify(fixtureJson('history')) },
			{ raw: JSON.stringify(fixtureJson('history-last-page')) },
		])
		const { client } = await setup(transport)
		await expect(client.history({ limit: 20 })).resolves.toEqual(
			decodeFixture(loyaltyHistoryResponseSchema, 'history'),
		)
		const last = decodeFixture(
			loyaltyHistoryResponseSchema,
			'history-last-page',
		)
		await expect(client.history({ cursor: 'c2', limit: 20 })).resolves.toEqual(
			last,
		)
		expect(last.nextCursor).toBeNull()
	})

	it('decodes the member code', async () => {
		const transport = new StubTransport([
			{ status: 201, raw: JSON.stringify(fixtureJson('member-code')) },
		])
		const { client } = await setup(transport)
		await expect(client.memberCode()).resolves.toEqual(
			decodeFixture(loyaltyMemberCodeResponseSchema, 'member-code'),
		)
	})

	it('decodes approvals and decisions', async () => {
		const transport = new StubTransport([
			{ raw: JSON.stringify(fixtureJson('approvals')) },
			{ raw: JSON.stringify(fixtureJson('approvals-empty')) },
			{ raw: JSON.stringify(fixtureJson('approval-approved')) },
			{ raw: JSON.stringify(fixtureJson('approval-declined')) },
		])
		const { client } = await setup(transport)
		await expect(client.approvals()).resolves.toEqual(
			decodeFixture(loyaltyApprovalsResponseSchema, 'approvals').approvals,
		)
		await expect(client.approvals()).resolves.toEqual([])
		const approved = decodeFixture(
			loyaltyApprovalResponseSchema,
			'approval-approved',
		)
		await expect(
			client.decideApproval(approved.approval.id, 'approve', 'key-9'),
		).resolves.toEqual(approved.approval)
		const declined = decodeFixture(
			loyaltyApprovalResponseSchema,
			'approval-declined',
		)
		await expect(
			client.decideApproval(declined.approval.id, 'decline'),
		).resolves.toEqual(declined.approval)
	})

	it.each([
		['error-approval-closed', 409],
		['error-approval-expired', 410],
		['error-approval-not-found', 404],
		['error-member-not-found-code', 404],
		['error-loyalty-disabled', 403],
		['error-member-inactive', 409],
		['error-member-not-found', 404],
		['error-organization-mismatch', 403],
		['error-program-inactive', 409],
		['error-rate-limited', 429],
		['error-redemption-disabled', 403],
		['error-unavailable', 503],
	] as const)('maps %s to its code', async (name, status) => {
		const body = fixtureJson(name)
		const expectedCode = (body as { code: string }).code
		expect(status).toBe(
			expectedCode === 'organization_mismatch'
				? 403
				: LOYALTY_ERROR_HTTP_STATUS[
						expectedCode as keyof typeof LOYALTY_ERROR_HTTP_STATUS
					],
		)
		const transport = new StubTransport([{ status, raw: JSON.stringify(body) }])
		const { client } = await setup(transport)
		const error = await client.wallet().catch((failure: unknown) => failure)
		expect(error).toBeInstanceOf(LoyaltyClientError)
		expect((error as LoyaltyClientError).code).toBe(expectedCode)
		expect((error as LoyaltyClientError).status).toBe(status)
	})

	it('keeps the rate-limit hint from the body', async () => {
		const transport = new StubTransport([
			{ status: 429, raw: JSON.stringify(fixtureJson('error-rate-limited')) },
		])
		const { client } = await setup(transport)
		const error = (await client
			.wallet()
			.catch((failure: unknown) => failure)) as LoyaltyClientError
		expect(error.code).toBe('rate_limited')
		expect(error.retryAfterSeconds).toBe(
			fixtureJson('error-rate-limited').retryAfterSeconds,
		)
	})
})

describe('requests', () => {
	it('reads the program anonymously with the site binding', async () => {
		const transport = new StubTransport([
			{ raw: JSON.stringify(fixtureJson('program')) },
		])
		const { client } = await setup(transport)
		await client.program()
		const request = transport.lastRequest
		expect(request?.url.pathname).toBe('/loyalty/program')
		expect(request?.url.searchParams.get('slug')).toBe('acme')
		expect(request?.request.method).toBe('GET')
		expect(header(request, 'Authorization')).toBeUndefined()
		expect(header(request, 'X-Client')).toBe('ios')
		expect(header(request, 'Origin')).toBe(ORIGIN)
		expect(header(request, 'Accept')).toBe('application/json')
		expect(request?.request.timeoutMs).toBe(15_000)
	})

	it('reads the wallet with the customer token', async () => {
		const transport = new StubTransport([
			{ raw: JSON.stringify(fixtureJson('wallet-member')) },
		])
		const { client, session } = await setup(transport)
		await client.wallet()
		const request = transport.lastRequest
		expect(request?.url.pathname).toBe('/loyalty/wallet')
		expect(header(request, 'Authorization')).toBe(
			`Bearer ${session.tokens?.accessToken ?? ''}`,
		)
	})

	it('binds with the host when the site has one', async () => {
		const transport = new StubTransport([
			{ raw: JSON.stringify(fixtureJson('program')) },
		])
		const { client } = await makeLoyaltyClient(transport.send, {
			configuration: makeConfiguration({
				slug: null,
				host: 'order.acme.com',
				origin: 'https://order.acme.com',
			}),
		})
		await client.program()
		const request = transport.lastRequest
		expect(request?.url.searchParams.get('host')).toBe('order.acme.com')
		expect(request?.url.searchParams.get('slug')).toBeNull()
	})

	it('omits the Origin header without an https origin', async () => {
		const transport = new StubTransport([
			{ raw: JSON.stringify(fixtureJson('program')) },
		])
		const { client } = await makeLoyaltyClient(transport.send, {
			configuration: makeConfiguration({ slug: 'acme', origin: null }),
		})
		await client.program()
		expect(header(transport.lastRequest, 'Origin')).toBeUndefined()
	})

	it('has no enroll call: the wallet read opens the account', async () => {
		const { client } = await setup(new StubTransport([]))
		expect('enroll' in client).toBe(false)
	})

	it('sends the binding in the body and an idempotency key on a decision', async () => {
		const approval = fixtureJson('approval-approved')
		const transport = new StubTransport([
			{ raw: JSON.stringify(approval) },
			{ raw: JSON.stringify(approval) },
		])
		const { client } = await setup(transport)
		await client.decideApproval(approval.approval.id, 'approve', 'key-1')
		await client.decideApproval(approval.approval.id, 'approve')
		const first = transport.recorded[0]
		expect(first?.url.pathname).toBe(
			`/loyalty/approvals/${approval.approval.id}/decide`,
		)
		expect(first?.url.search).toBe('')
		expect(first?.body).toEqual({ decision: 'approve', slug: 'acme' })
		expect(header(first, 'Idempotency-Key')).toBe('key-1')
		expect(header(transport.recorded[1], 'Idempotency-Key')).toBe(
			'generated-key',
		)
	})

	it('pages history with the cursor', async () => {
		const transport = new StubTransport([
			{ raw: JSON.stringify(fixtureJson('history')) },
			{ raw: JSON.stringify(fixtureJson('history-last-page')) },
		])
		const { client } = await setup(transport)
		await client.history({ limit: 20 })
		await client.history({ cursor: 'c2', limit: 20 })
		const first = transport.recorded[0]?.url
		expect(first?.pathname).toBe('/loyalty/history')
		expect(first?.searchParams.get('slug')).toBe('acme')
		expect(first?.searchParams.get('limit')).toBe('20')
		expect(first?.searchParams.get('cursor')).toBeNull()
		expect(transport.recorded[1]?.url.searchParams.get('cursor')).toBe('c2')
	})

	it('asks for a member code with the binding in the query', async () => {
		const transport = new StubTransport([
			{ status: 201, raw: JSON.stringify(fixtureJson('member-code')) },
		])
		const { client } = await setup(transport)
		await client.memberCode()
		const request = transport.lastRequest
		expect(request?.url.pathname).toBe('/loyalty/member-code')
		expect(request?.url.searchParams.get('slug')).toBe('acme')
		expect(request?.request.method).toBe('POST')
		expect(request?.body).toEqual({})
	})

	it('decides a request by its encoded id with the binding in the body', async () => {
		const approval = testApproval({ id: 'apr/1', status: 'approved' })
		const transport = new StubTransport([{ json: { approval } }])
		const { client } = await setup(transport)
		await client.decideApproval('apr/1', 'approve', 'key-9')
		const request = transport.lastRequest
		expect(request?.url.pathname).toBe('/loyalty/approvals/apr%2F1/decide')
		expect(request?.body).toEqual({ decision: 'approve', slug: 'acme' })
		expect(header(request, 'Idempotency-Key')).toBe('key-9')
	})
})

describe('session handling', () => {
	it('refreshes once after a 401 and retries with the new token', async () => {
		const rotated = 'rotated-access-token'
		const transport = new StubTransport([
			{ status: 401, raw: '{"error":"Invalid or expired token"}' },
			{
				json: {
					success: true,
					accessToken: rotated,
					refreshToken: 'refresh-2',
				},
			},
			{ raw: JSON.stringify(fixtureJson('wallet-member')) },
		])
		const { client } = await setup(transport)
		const wallet = await client.wallet()
		expect(wallet?.member?.id).toBeTruthy()
		expect(transport.paths).toEqual([
			'/loyalty/wallet',
			'/auth/refresh',
			'/loyalty/wallet',
		])
		expect(transport.recorded[1]?.body).toEqual({
			refreshToken: 'refresh-1',
			orgId: 'org_1',
		})
		expect(header(transport.recorded[2], 'Authorization')).toBe(
			`Bearer ${rotated}`,
		)
	})

	it('reports signed_out when the refresh is refused and the session ends', async () => {
		const transport = new StubTransport([
			{ status: 401, raw: '{"error":"Invalid or expired token"}' },
			{ status: 401, raw: '{"error":"Invalid refresh token"}' },
		])
		const { client, session } = await setup(transport)
		const error = await client.wallet().catch((failure: unknown) => failure)
		expect(error).toMatchObject({ code: 'signed_out', status: 401 })
		expect(session.isSignedIn).toBe(false)
	})

	it('reports network when the refresh fails for now and keeps the session', async () => {
		const transport = new StubTransport([
			{ status: 401, raw: '{"error":"Invalid or expired token"}' },
			{ status: 503, raw: '{"error":"busy"}' },
		])
		const { client, session } = await setup(transport)
		await expect(client.wallet()).rejects.toMatchObject({
			code: 'network',
			status: 0,
		})
		expect(session.isSignedIn).toBe(true)
	})

	it('reports network when the refresh is forbidden without a session-ending code and keeps the session', async () => {
		const transport = new StubTransport([
			{ status: 401, raw: '{"error":"Invalid or expired token"}' },
			{ status: 403, raw: '{"error":"Organization is no longer active"}' },
		])
		const { client, session } = await setup(transport)
		await expect(client.wallet()).rejects.toMatchObject({
			code: 'network',
			status: 0,
		})
		expect(session.isSignedIn).toBe(true)
	})

	it('reports signed_out when the refresh says the organization is inactive', async () => {
		const transport = new StubTransport([
			{ status: 401, raw: '{"error":"Invalid or expired token"}' },
			{
				status: 403,
				json: {
					error: 'Organization is no longer active',
					code: 'organization_inactive',
				},
			},
		])
		const { client, session } = await setup(transport)
		await expect(client.wallet()).rejects.toMatchObject({
			code: 'signed_out',
		})
		expect(session.isSignedIn).toBe(false)
	})

	it('reports signed_out when a loyalty route says the organization is inactive', () => {
		expect(
			loyaltyErrorCodeFrom(403, {
				error: 'Organization is no longer active',
				code: 'organization_inactive',
			}),
		).toBe('signed_out')
		expect(
			loyaltyErrorCodeFrom(403, { error: 'Organization is no longer active' }),
		).toBe('unknown')
	})

	it('reports signed_out without a session and never sends a request', async () => {
		const transport = new StubTransport()
		const { client } = await makeLoyaltyClient(transport.send, {
			configuration: boundConfiguration(),
			signedIn: false,
		})
		await expect(client.wallet()).rejects.toMatchObject({ code: 'signed_out' })
		expect(transport.recorded).toHaveLength(0)
		// The public program still loads anonymously.
		transport.recorded.length = 0
	})

	it('maps organization_mismatch from the region', async () => {
		const transport = new StubTransport([
			{
				status: 403,
				raw: JSON.stringify(fixtureJson('error-organization-mismatch')),
			},
		])
		const { client } = await setup(transport)
		await expect(client.wallet()).rejects.toMatchObject({
			code: 'organization_mismatch',
			status: 403,
		})
	})

	it('reports organization_not_found when the region has no node here', async () => {
		const configuration = makeConfiguration({ slug: 'acme', region: 'ksa' })
		configuration.tenantApiBaseUrlKsa = null
		const transport = new StubTransport()
		const { client } = await makeLoyaltyClient(transport.send, {
			configuration,
		})
		await expect(client.wallet()).rejects.toMatchObject({
			code: 'organization_not_found',
			status: 0,
		})
		await expect(client.program()).rejects.toMatchObject({
			code: 'organization_not_found',
		})
		expect(transport.recorded).toHaveLength(0)
	})
})

describe('failures', () => {
	it('turns a transport failure into a network error', async () => {
		const { client } = await makeLoyaltyClient(failingTransport, {
			configuration: boundConfiguration(),
		})
		await expect(client.wallet()).rejects.toMatchObject({
			code: 'network',
			status: 0,
		})
		await expect(client.program()).rejects.toMatchObject({
			code: 'network',
			status: 0,
		})
	})

	it('turns an answer off the contract into invalid_response', async () => {
		const transport = new StubTransport([
			{ json: { wallet: { nonsense: true } } },
		])
		const { client } = await setup(transport)
		await expect(client.wallet()).rejects.toMatchObject({
			code: 'invalid_response',
			status: 200,
		})
	})

	it('reads Retry-After from the header, seconds or a date', async () => {
		const transport = new StubTransport([
			{
				status: 429,
				json: { error: 'rate_limited', code: 'rate_limited' },
				headers: { 'retry-after': '30' },
			},
			{
				status: 429,
				json: { error: 'rate_limited', code: 'rate_limited' },
				headers: { 'retry-after': new Date(Date.now() + 10_000).toUTCString() },
			},
		])
		const { client } = await setup(transport)
		await expect(client.approvals()).rejects.toMatchObject({
			code: 'rate_limited',
			retryAfterSeconds: 30,
		})
		const error = (await client
			.approvals()
			.catch((failure: unknown) => failure)) as LoyaltyClientError
		expect(error.retryAfterSeconds).toBeGreaterThan(8)
		expect(error.retryAfterSeconds).toBeLessThanOrEqual(11)
	})
})

describe('error codes', () => {
	it('prefers the server code and falls back to the status', () => {
		expect(
			loyaltyErrorCodeFrom(409, { error: 'x', code: 'member_inactive' }),
		).toBe('member_inactive')
		expect(loyaltyErrorCodeFrom(403, { error: 'organization_mismatch' })).toBe(
			'organization_mismatch',
		)
		expect(loyaltyErrorCodeFrom(401, { error: 'Unauthorized' })).toBe(
			'signed_out',
		)
		expect(loyaltyErrorCodeFrom(404, { error: 'Not found' })).toBe(
			'organization_not_found',
		)
		expect(loyaltyErrorCodeFrom(429, null)).toBe('rate_limited')
		expect(loyaltyErrorCodeFrom(503, 'down')).toBe('loyalty_unavailable')
		expect(loyaltyErrorCodeFrom(422, {})).toBe('invalid_request')
		expect(loyaltyErrorCodeFrom(500, {})).toBe('unknown')
	})

	it('reads a whole-second retry hint from the body', () => {
		expect(
			loyaltyErrorFromResponse(429, {
				code: 'rate_limited',
				retryAfterSeconds: 2.2,
			}).retryAfterSeconds,
		).toBe(3)
		expect(
			loyaltyErrorFromResponse(429, {
				code: 'rate_limited',
				retryAfterSeconds: 'soon',
			}).retryAfterSeconds,
		).toBeNull()
	})

	it('retries only what may succeed with the same key', () => {
		expect(isRetryableLoyaltyError(new LoyaltyClientError('network', 0))).toBe(
			true,
		)
		expect(
			isRetryableLoyaltyError(new LoyaltyClientError('rate_limited', 429)),
		).toBe(true)
		expect(
			isRetryableLoyaltyError(
				new LoyaltyClientError('loyalty_unavailable', 503),
			),
		).toBe(true)
		expect(
			isRetryableLoyaltyError(new LoyaltyClientError('unknown', 502)),
		).toBe(true)
		expect(
			isRetryableLoyaltyError(new LoyaltyClientError('member_inactive', 409)),
		).toBe(false)
		expect(isRetryableLoyaltyError(new Error('boom'))).toBe(true)
	})
})

describe('createAttemptKeys', () => {
	it('keeps one key per intent until a definitive answer', () => {
		let n = 0
		const keys = createAttemptKeys(() => `k${++n}`)
		expect(keys.key('decide:a:approve')).toBe('k1')
		keys.settle('decide:a:approve', new LoyaltyClientError('network', 0))
		expect(keys.key('decide:a:approve')).toBe('k1')
		keys.settle(
			'decide:a:approve',
			new LoyaltyClientError('approval_closed', 409),
		)
		expect(keys.key('decide:a:approve')).toBe('k2')
		keys.settle('decide:a:approve')
		expect(keys.key('decide:a:approve')).toBe('k3')
		expect(keys.key('decide:apr_1:approve')).toBe('k4')
		keys.clear()
		expect(keys.key('decide:a:approve')).toBe('k5')
	})
})

describe('memberCodeDeadline', () => {
	const ttl = LOYALTY_MEMBER_CODE_TTL_MS

	it('follows the server when the clocks agree', () => {
		expect(memberCodeDeadline(1_000 + 60_000, 1_000, ttl)).toBe(61_000)
	})

	it('never runs past one TTL from arrival, and never starts expired', () => {
		expect(memberCodeDeadline(1_000 + ttl * 3, 1_000, ttl)).toBe(1_000 + ttl)
		expect(memberCodeDeadline(500, 1_000, ttl)).toBe(1_000 + ttl)
	})
})

describe('fixtures used by the builders parse', () => {
	it('builds valid programs, wallets, approvals and entries', () => {
		expect(testProgram().rewards.length).toBeGreaterThan(0)
		expect(testWallet().member?.status).toBe('active')
		expect(testApproval().status).toBe('pending')
		expect(testEntry().id).toBeTruthy()
	})
})
