import { type AuthTokens } from './auth-tokens'
import { CustomerSession } from './customer-session'
import { createMemoryTokenStorage } from './token-storage'
import { ApiError } from '@/lib/api/api-error'
import { type HttpResponse, type HttpTransport } from '@/lib/api/http'
import { TenantApiClient } from '@/lib/api/tenant-api-client'
import { header, sleep, StubTransport } from '@/test/stub-transport'
import { makeAccessToken, makeConfiguration } from '@/test/support'

function makeSession(
	transport: StubTransport,
	initial: AuthTokens | null = null,
) {
	const storage = createMemoryTokenStorage(initial)
	const session = new CustomerSession(
		new TenantApiClient(makeConfiguration(), transport.send),
		storage,
	)
	return { session, storage }
}

async function signedIn(transport: StubTransport, refreshToken = 'refresh-1') {
	const made = makeSession(transport, {
		accessToken: makeAccessToken(),
		refreshToken,
	})
	await made.session.restore()
	return made
}

async function caught(promise: Promise<unknown>): Promise<ApiError> {
	try {
		await promise
	} catch (error) {
		if (error instanceof ApiError) return error
		throw error
	}
	throw new Error('Expected an ApiError')
}

describe('CustomerSession', () => {
	it('restores the stored session', async () => {
		const stored = {
			accessToken: makeAccessToken({ name: 'Ada Lovelace' }),
			refreshToken: 'refresh-1',
		}
		const { session } = makeSession(new StubTransport(), stored)

		const restored = await session.restore()

		expect(restored?.accessToken).toBe(stored.accessToken)
		expect(session.isSignedIn).toBe(true)
		expect(session.customerFirstName).toBe('Ada')
	})

	it('stores the tokens of a verification', async () => {
		const transport = new StubTransport([
			{
				json: {
					success: true,
					accessToken: makeAccessToken(),
					refreshToken: 'refresh-1',
					needsName: false,
				},
			},
		])
		const { session, storage } = makeSession(transport)

		const result = await session.verify('+1 (555) 000-1111', ' 123456 ')

		expect(result.needsName).toBe(false)
		expect(storage.current?.accessToken).toBeTruthy()
		expect(transport.lastRequest?.body.phone).toBe('+15550001111')
		expect(transport.lastRequest?.body.code).toBe('123456')
	})

	it('rejects short phone numbers before calling the server', async () => {
		const transport = new StubTransport()
		const { session } = makeSession(transport)

		const error = await caught(session.sendCode('123'))
		expect(error.message).toBe('Enter a valid phone number.')
		expect(error.code).toBe('invalid_phone')
		expect(transport.recorded).toHaveLength(0)
	})

	it('sends the normalized phone number', async () => {
		const transport = new StubTransport([{ json: { success: true } }])
		const { session } = makeSession(transport)

		await session.sendCode('+1 (555) 000-1111')
		expect(transport.lastRequest?.body.phone).toBe('+15550001111')
	})

	it('refreshes once after a 401', async () => {
		const refreshed = makeAccessToken({ name: 'Ada Lovelace' })
		const transport = new StubTransport([
			{ status: 401, raw: '{"error":"Invalid or expired token"}' },
			{
				json: {
					success: true,
					accessToken: refreshed,
					refreshToken: 'refresh-2',
				},
			},
			{
				json: {
					customer: { id: 'cust_1', name: 'Ada Lovelace', needsName: false },
				},
			},
		])
		const { session, storage } = await signedIn(transport)

		const profile = await session.profile()

		expect(profile.name).toBe('Ada Lovelace')
		expect(transport.paths).toEqual(['/auth/me', '/auth/refresh', '/auth/me'])
		expect(transport.recorded[1]?.body).toEqual({
			refreshToken: 'refresh-1',
			orgId: 'org_1',
		})
		expect(storage.current?.refreshToken).toBe('refresh-2')
		expect(header(transport.recorded[2], 'Authorization')).toBe(
			`Bearer ${refreshed}`,
		)
	})

	it('signs out when the refresh is refused', async () => {
		const transport = new StubTransport([
			{ status: 401, raw: '{"error":"Invalid or expired token"}' },
			{ status: 401, raw: '{"error":"Invalid refresh token"}' },
		])
		const { session, storage } = await signedIn(transport)

		const error = await caught(session.profile())
		expect(error.isUnauthorized).toBe(true)
		expect(storage.current).toBeNull()
		expect(session.isSignedIn).toBe(false)
	})

	it('keeps the session when the refresh is forbidden without a session-ending code', async () => {
		const transport = new StubTransport([
			{ status: 401, raw: '{"error":"Invalid or expired token"}' },
			{ status: 403, raw: '{"error":"Forbidden"}' },
		])
		const { session, storage } = await signedIn(transport)

		const error = await caught(session.profile())
		expect(error.status).toBe(403)
		// Only a 401, or a 403 with organization_inactive, ends the session.
		expect(storage.current?.refreshToken).toBe('refresh-1')
		expect(session.isSignedIn).toBe(true)
	})

	it('keeps the session when a control-plane outage answers the refresh with a bare 403', async () => {
		const transport = new StubTransport((request) => {
			const path = new URL(request.url).pathname
			if (path === '/auth/refresh') {
				return {
					status: 403,
					json: { error: 'Organization is no longer active' },
				}
			}
			return { status: 401, json: { error: 'Invalid or expired token' } }
		})
		const { session, storage } = await signedIn(transport)

		const error = await caught(session.profile())

		expect(error.status).toBe(403)
		expect(error.endsSession).toBe(false)
		expect(storage.current?.refreshToken).toBe('refresh-1')
		expect(session.isSignedIn).toBe(true)
	})

	it('signs out when the refresh says the organization is inactive', async () => {
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
		const { session, storage } = await signedIn(transport)
		const listener = jest.fn()
		session.subscribe(listener)

		const error = await caught(session.profile())

		expect(error.status).toBe(403)
		expect(error.code).toBe('organization_inactive')
		expect(error.endsSession).toBe(true)
		expect(storage.current).toBeNull()
		expect(session.isSignedIn).toBe(false)
		expect(listener).toHaveBeenCalledTimes(1)
	})

	it('signs out when an authenticated call says the organization is inactive', async () => {
		const transport = new StubTransport([
			{
				status: 403,
				json: {
					error: 'Organization is no longer active',
					code: 'organization_inactive',
				},
			},
		])
		const { session, storage } = await signedIn(transport)

		const error = await caught(session.profile())

		expect(error.code).toBe('organization_inactive')
		// No refresh: the organization itself is gone, not the access token.
		expect(transport.paths).toEqual(['/auth/me'])
		expect(storage.current).toBeNull()
		expect(session.isSignedIn).toBe(false)
	})

	it('keeps the session when a forbidden authenticated call has no session-ending code', async () => {
		const transport = new StubTransport([
			{ status: 403, json: { error: 'Forbidden' } },
		])
		const { session, storage } = await signedIn(transport)

		const error = await caught(session.profile())

		expect(error.status).toBe(403)
		expect(transport.paths).toEqual(['/auth/me'])
		expect(storage.current?.refreshToken).toBe('refresh-1')
		expect(session.isSignedIn).toBe(true)
	})

	it('stays signed in when a refresh answer was lost and the retry lands in the rotation grace window', async () => {
		// Models tenant-api's rotation rule: a rotated token presented again
		// within the grace window gets the successor pair; later it is reuse.
		const live = new Set(['refresh-1'])
		const successor = new Map<string, string>()
		let next = 1
		let dropNextRefreshAnswer = true
		let meCalls = 0
		const transport = new StubTransport((request) => {
			const path = new URL(request.url).pathname
			if (path === '/auth/refresh') {
				const presented = String(
					(JSON.parse(request.body ?? '{}') as { refreshToken?: string })
						.refreshToken,
				)
				const graced = successor.get(presented)
				if (graced) {
					return {
						json: {
							success: true,
							accessToken: makeAccessToken(),
							refreshToken: graced,
						},
					}
				}
				if (!live.has(presented)) {
					live.clear()
					return { status: 401, json: { error: 'Invalid refresh token' } }
				}
				live.delete(presented)
				next += 1
				const rotated = `refresh-${next}`
				live.add(rotated)
				successor.set(presented, rotated)
				if (dropNextRefreshAnswer) {
					dropNextRefreshAnswer = false
					const lost = new Error('aborted')
					lost.name = 'AbortError'
					throw lost
				}
				return {
					json: {
						success: true,
						accessToken: makeAccessToken(),
						refreshToken: rotated,
					},
				}
			}
			if (path === '/auth/me') {
				meCalls += 1
				return meCalls <= 2
					? { status: 401, json: { error: 'Invalid or expired token' } }
					: { json: { customer: { id: 'cust_1', name: 'Ada Lovelace' } } }
			}
			return { status: 404, json: { error: `unexpected ${path}` } }
		})
		const { session, storage } = await signedIn(transport)

		const timedOut = await caught(session.profile())
		expect(timedOut.isTransportFailure).toBe(true)
		expect(session.isSignedIn).toBe(true)

		const profile = await session.profile()

		expect(profile.name).toBe('Ada Lovelace')
		expect(session.isSignedIn).toBe(true)
		expect(storage.current?.refreshToken).toBe('refresh-2')
	})

	it('stores rotated tokens after saving the profile', async () => {
		const rotated = makeAccessToken({ name: 'Ada Byron' })
		const transport = new StubTransport([
			{
				json: {
					success: true,
					accessToken: rotated,
					refreshToken: 'refresh-2',
				},
			},
			{
				json: {
					customer: { id: 'cust_1', name: 'Ada Byron', needsName: false },
				},
			},
		])
		const { session, storage } = await signedIn(transport)

		const profile = await session.updateProfile(
			' Ada Byron ',
			'ada@example.com',
		)

		expect(profile.name).toBe('Ada Byron')
		expect(storage.current?.accessToken).toBe(rotated)
		expect(storage.current?.refreshToken).toBe('refresh-2')
		expect(transport.recorded[0]?.body).toEqual({
			name: 'Ada Byron',
			email: 'ada@example.com',
		})
	})

	it('requires a name of two characters', async () => {
		const transport = new StubTransport()
		const { session } = await signedIn(transport)

		const error = await caught(session.updateProfile('A', null))
		expect(error.message).toBe('Name is required.')
		expect(error.code).toBe('name_required')
		expect(transport.recorded).toHaveLength(0)
	})

	it('revokes the refresh token and clears storage on sign-out', async () => {
		const transport = new StubTransport([{ json: { success: true } }])
		const { session, storage } = await signedIn(transport)

		await session.signOut()

		expect(storage.current).toBeNull()
		expect(transport.lastRequest?.url.pathname).toBe('/auth/logout')
		expect(transport.lastRequest?.body).toEqual({
			refreshToken: 'refresh-1',
			orgId: 'org_1',
		})
	})

	it('signs out locally when the server is unreachable', async () => {
		const transport = new StubTransport(() => {
			throw new TypeError('Network request failed')
		})
		const { session, storage } = await signedIn(transport)

		await session.signOut()

		expect(storage.current).toBeNull()
		expect(session.isSignedIn).toBe(false)
	})

	it('shares one refresh between concurrent 401s', async () => {
		const refreshed = makeAccessToken({ name: 'Ada Byron' })
		let refreshCalls = 0
		// Path-keyed replies, so the assertions hold whatever order the callers
		// reach the transport in.
		const transport = new StubTransport((request) => {
			const path = new URL(request.url).pathname
			if (path === '/auth/refresh') {
				refreshCalls += 1
				return {
					json: {
						success: true,
						accessToken: refreshed,
						refreshToken: 'refresh-2',
					},
				}
			}
			if (path === '/auth/me') {
				if (refreshCalls === 0)
					return { status: 401, json: { error: 'Invalid or expired token' } }
				return { json: { customer: { id: 'cust_1', name: 'Ada Lovelace' } } }
			}
			return { status: 404, json: { error: `unexpected ${path}` } }
		})
		const { session, storage } = await signedIn(transport)

		await Promise.all([session.profile(), session.profile()])

		// Refresh tokens rotate; parallel refreshes would revoke the session.
		expect(refreshCalls).toBe(1)
		expect(storage.current?.refreshToken).toBe('refresh-2')
	})

	it('retries a stale 401 with the token another caller already refreshed', async () => {
		const stale = makeAccessToken()
		const rotated = makeAccessToken({ name: 'Ada Byron' })
		let refreshCalls = 0
		let staleRequests = 0
		const transport = new StubTransport((request) => {
			const path = new URL(request.url).pathname
			if (path === '/auth/refresh') {
				refreshCalls += 1
				return {
					json: {
						success: true,
						accessToken: rotated,
						refreshToken: 'refresh-2',
					},
				}
			}
			if (path === '/auth/me') {
				if (request.headers.Authorization !== `Bearer ${stale}`) {
					return { json: { customer: { id: 'cust_1', name: 'Ada Byron' } } }
				}
				// This caller's 401 only lands after the refresh below finished.
				staleRequests += 1
				return {
					status: 401,
					json: { error: 'Invalid or expired token' },
					delayMs: 150,
				}
			}
			return { status: 404, json: { error: `unexpected ${path}` } }
		})
		const storage = createMemoryTokenStorage({
			accessToken: stale,
			refreshToken: 'refresh-1',
		})
		const session = new CustomerSession(
			new TenantApiClient(makeConfiguration(), transport.send),
			storage,
		)
		await session.restore()

		const staleCall = session.profile()
		for (let attempt = 0; attempt < 200 && staleRequests === 0; attempt += 1) {
			await sleep(1)
		}
		expect(staleRequests).toBe(1)

		// Another caller refreshes while that request is in flight, so its 401
		// was answered for a token that is already stale.
		const refreshed = await session.refresh()
		expect(refreshed.accessToken).toBe(rotated)

		const profile = await staleCall
		expect(profile.name).toBe('Ada Byron')
		// A 401 that predates another caller's refresh retries with the rotated token.
		expect(refreshCalls).toBe(1)
		expect(storage.current?.refreshToken).toBe('refresh-2')
	})

	it('rejects a profile answer without a refresh token and keeps the session', async () => {
		const transport = new StubTransport([
			{ json: { success: true, accessToken: makeAccessToken() } },
		])
		const { session, storage } = await signedIn(transport)

		const error = await caught(session.updateProfile('Ada Byron', null))

		expect(error.code).toBe('profile_not_saved')
		expect(storage.current?.refreshToken).toBe('refresh-1')
	})

	it('discards a refresh that finishes after sign-out', async () => {
		const rotated = makeAccessToken({ name: 'Ada Lovelace' })
		const transport = new StubTransport([
			{ status: 401, raw: '{"error":"Invalid or expired token"}' },
			// Delayed so the sign-out lands while the refresh is in flight.
			{
				json: {
					success: true,
					accessToken: rotated,
					refreshToken: 'refresh-2',
				},
				delayMs: 200,
			},
			{ json: { success: true } },
		])
		const { session, storage } = await signedIn(transport)

		const profile = session.profile().catch((error: unknown) => error)
		await sleep(60)
		await session.signOut()
		const outcome = await profile

		expect(outcome).toBeInstanceOf(ApiError)
		expect(storage.current).toBeNull()
		expect(session.isSignedIn).toBe(false)
	})

	it('keeps the session when the refresh fails for a transient reason', async () => {
		const transport = new StubTransport([
			{ status: 401, raw: '{"error":"Invalid or expired token"}' },
			{ status: 500, raw: '{"error":"Internal Server Error"}' },
		])
		const { session, storage } = await signedIn(transport)

		const error = await caught(session.profile())
		expect(error.status).toBe(500)
		// A 5xx must not sign the customer out.
		expect(storage.current?.refreshToken).toBe('refresh-1')
		expect(session.isSignedIn).toBe(true)
	})

	it('omits the email when none is given', async () => {
		const transport = new StubTransport([
			{
				json: {
					success: true,
					accessToken: makeAccessToken({ name: 'Ada' }),
					refreshToken: 'refresh-2',
				},
			},
			{
				json: {
					customer: { id: 'cust_1', name: 'Ada', email: 'kept@example.com' },
				},
			},
		])
		const { session } = await signedIn(transport)

		await session.updateProfile('Ada', undefined)

		// Omitting the field keeps the stored email; an empty string would clear it.
		expect(transport.recorded[0]?.body).toEqual({ name: 'Ada' })
	})

	it('refuses authorized calls while signed out', async () => {
		const transport = new StubTransport()
		const { session } = makeSession(transport)

		const error = await caught(session.profile())
		expect(error.isUnauthorized).toBe(true)
		expect(transport.recorded).toHaveLength(0)
	})

	it('does not adopt a verification that finishes after sign-out', async () => {
		const transport = new StubTransport([
			{
				json: {
					success: true,
					accessToken: makeAccessToken(),
					refreshToken: 'r',
				},
				delayMs: 50,
			},
		])
		const { session, storage } = makeSession(transport)

		const verification = session.verify('+15550001111', '123456')
		await session.signOut()
		await verification

		expect(storage.current).toBeNull()
		expect(session.isSignedIn).toBe(false)
	})
	it('revokes a verification that finishes after the sign-in was abandoned', async () => {
		const transport = new StubTransport([
			{
				json: {
					success: true,
					accessToken: makeAccessToken(),
					refreshToken: 'r-late',
				},
				delayMs: 50,
			},
			{ json: { success: true } },
		])
		const { session, storage } = makeSession(transport)

		const verification = session.verify('+15550001111', '123456')
		session.abandonPendingVerification()
		await verification
		for (
			let attempt = 0;
			attempt < 50 && transport.recorded.length < 2;
			attempt += 1
		) {
			await sleep(1)
		}

		expect(storage.current).toBeNull()
		expect(session.isSignedIn).toBe(false)
		// The server issued a session nobody will use: it is revoked, not kept.
		expect(transport.paths).toEqual(['/auth/verify', '/auth/logout'])
		expect(transport.lastRequest?.body).toEqual({
			refreshToken: 'r-late',
			orgId: 'org_1',
		})
	})

	it('keeps a signed-in session when no verification is pending', async () => {
		const rotated = makeAccessToken({ name: 'Ada Byron' })
		const transport = new StubTransport([
			{
				json: {
					success: true,
					accessToken: rotated,
					refreshToken: 'refresh-2',
				},
			},
			{ json: { customer: { id: 'cust_1', name: 'Ada Byron' } } },
		])
		const { session, storage } = await signedIn(transport)

		session.abandonPendingVerification()
		await session.updateProfile('Ada Byron', null)

		expect(storage.current?.accessToken).toBe(rotated)
	})

	it('signs out without waiting for the server to revoke the token', async () => {
		let releaseLogout: (() => void) | null = null
		const send: HttpTransport = (request) =>
			new Promise<HttpResponse>((resolve) => {
				releaseLogout = () =>
					resolve({
						status: 200,
						url: request.url,
						body: '{"success":true}',
						headers: { 'content-type': 'application/json' },
					})
			})
		const storage = createMemoryTokenStorage({
			accessToken: makeAccessToken(),
			refreshToken: 'refresh-1',
		})
		const session = new CustomerSession(
			new TenantApiClient(makeConfiguration(), send),
			storage,
		)
		await session.restore()

		await session.signOut()

		expect(storage.current).toBeNull()
		expect(session.isSignedIn).toBe(false)
		for (let attempt = 0; attempt < 50 && !releaseLogout; attempt += 1)
			await sleep(1)
		expect(releaseLogout).not.toBeNull()
		releaseLogout!()
	})

	it('tells subscribers when a refused refresh ends the session', async () => {
		const transport = new StubTransport([
			{ status: 401, raw: '{"error":"Invalid or expired token"}' },
			{ status: 401, raw: '{"error":"Invalid refresh token"}' },
		])
		const { session } = await signedIn(transport)
		const seen: boolean[] = []
		session.subscribe(() => seen.push(session.isSignedIn))

		await caught(session.profile())

		expect(seen).toEqual([false])
	})

	it('tells subscribers about restore, sign-in and sign-out, until they unsubscribe', async () => {
		const transport = new StubTransport([
			{
				json: {
					success: true,
					accessToken: makeAccessToken(),
					refreshToken: 'r',
				},
			},
			{ json: { success: true } },
		])
		const { session } = makeSession(transport)
		const listener = jest.fn()
		const unsubscribe = session.subscribe(listener)

		await session.restore()
		expect(listener).not.toHaveBeenCalled()

		await session.verify('+15550001111', '123456')
		expect(listener).toHaveBeenCalledTimes(1)

		unsubscribe()
		await session.signOut()
		expect(listener).toHaveBeenCalledTimes(1)
	})

	it('forgets a session locally without contacting any server', async () => {
		const transport = new StubTransport()
		const { session, storage } = makeSession(transport, {
			accessToken: makeAccessToken({ orgId: 'org_other' }),
			refreshToken: 'refresh-other',
		})
		await session.restore()

		await session.discardLocal()

		expect(storage.current).toBeNull()
		expect(session.isSignedIn).toBe(false)
		// Another organization's refresh token must never reach this node.
		expect(transport.recorded).toHaveLength(0)
	})
})
