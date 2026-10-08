import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type AppConfigResponse,
	CONFIG_MAX_STALE_MS,
	CONFIG_REQUEST_TIMEOUT_MS,
	createRuntimeConfigLoader,
	FINISH_RETRY_DELAYS_MS,
	finishCallWithRetry,
	memoryConfigCache,
	requestRuntimeConfig,
	ServiceError,
	smsBlockedExplanation,
	tenantApi,
} from './services.ts'
import { testConfig } from './test-fixtures.ts'

vi.mock('varlock/env', () => ({
	ENV: {
		APP_URL: 'http://app.test',
		TENANT_API_URL: 'http://tenant.test',
		VOICE_AGENT_TOKEN: 'test-voice-agent-token-0123456789abcdef',
	},
}))

const lookup = { kind: 'number', calledNumber: '+15550001111' } as const

function loader(responses: Array<AppConfigResponse | Error>) {
	let now = 1_000_000
	const request = vi.fn(async () => {
		const next = responses.shift()
		if (!next) throw new Error('no response queued')
		if (next instanceof Error) throw next
		return next
	})
	const load = createRuntimeConfigLoader({
		request,
		cache: memoryConfigCache(),
		now: () => now,
	})
	return {
		load,
		request,
		advance: (ms: number) => {
			now += ms
		},
	}
}

describe('runtime config cache', () => {
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('asks App on every call, even right after caching', async () => {
		const updated = testConfig({ greeting: 'We moved across the street.' })
		const { load, request, advance } = loader([
			{ kind: 'config', config: testConfig() },
			{ kind: 'config', config: updated },
		])
		await load(lookup)
		advance(1)
		await expect(load(lookup)).resolves.toEqual({
			kind: 'config',
			config: updated,
			stale: false,
		})
		expect(request).toHaveBeenCalledTimes(2)
	})

	it('serves the cached config while App is down or timing out, up to a day', async () => {
		const config = testConfig()
		const { load, advance } = loader([
			{ kind: 'config', config },
			new ServiceError('Bad gateway', 502),
			new ServiceError('Timed out', 0),
			new ServiceError('Could not reach App', 0),
		])
		await load(lookup)
		advance(60_000)
		await expect(load(lookup)).resolves.toEqual({
			kind: 'config',
			config,
			stale: true,
		})
		await expect(load(lookup)).resolves.toMatchObject({ stale: true })
		advance(CONFIG_MAX_STALE_MS)
		await expect(load(lookup)).rejects.toThrow('Could not reach App')
	})

	it('never answers from the cache when App refuses the number', async () => {
		const { load } = loader([
			{ kind: 'config', config: testConfig() },
			new ServiceError('Unknown number', 404),
			new ServiceError('Down', 503),
		])
		await load(lookup)
		await expect(load(lookup)).rejects.toThrow('Unknown number')
		// The refusal also dropped the cached copy.
		await expect(load(lookup)).rejects.toThrow('Down')
	})

	it('drops the cached config on an unexpected 409', async () => {
		const { load } = loader([
			{ kind: 'config', config: testConfig() },
			new ServiceError('Unexpected 409 from App', 409),
			new ServiceError('Down', 503),
		])
		await load(lookup)
		await expect(load(lookup)).rejects.toThrow('Unexpected 409')
		await expect(load(lookup)).rejects.toThrow('Down')
	})

	it('does not use the cache when App rejects the worker token', async () => {
		const { load } = loader([
			{ kind: 'config', config: testConfig() },
			new ServiceError('App rejected VOICE_AGENT_TOKEN', 401),
		])
		await load(lookup)
		await expect(load(lookup)).rejects.toMatchObject({ status: 401 })
	})

	it('drops the cached config once the agent is turned off', async () => {
		const passthrough = {
			kind: 'passthrough',
			passthrough: {
				passthrough: true,
				error: 'off',
				phone: null,
				message: null,
				language: 'en',
				voiceId: null,
				agentLines: [] as string[],
			},
		} as const
		const { load } = loader([
			{ kind: 'config', config: testConfig() },
			passthrough,
			new ServiceError('Down', 503),
		])
		await load(lookup)
		await expect(load(lookup)).resolves.toEqual(passthrough)
		await expect(load(lookup)).rejects.toThrow('Down')
	})

	it('never caches test-call lookups', async () => {
		const config = testConfig()
		const { load, request } = loader([
			{ kind: 'config', config },
			new ServiceError('Down', 503),
		])
		const test = {
			kind: 'test',
			orgId: 'org_1',
			scopeId: 'scope_1',
			flow: 'draft',
		} as const
		await load(test)
		await expect(load(test)).rejects.toThrow('Down')
		expect(request).toHaveBeenCalledTimes(2)
	})
})

describe('requestRuntimeConfig', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	function respond(status: number, body: unknown) {
		const fetchMock = vi.fn(
			async (ignoredUrl: string, ignoredInit?: RequestInit) =>
				new Response(JSON.stringify(body), { status }),
		)
		vi.stubGlobal('fetch', fetchMock)
		return fetchMock
	}

	it('sends the voice agent token and returns the config', async () => {
		const config = testConfig()
		const fetchMock = respond(200, config)
		await expect(requestRuntimeConfig(lookup)).resolves.toEqual({
			kind: 'config',
			config,
		})
		const [url, init] = fetchMock.mock.calls[0]!
		expect(url).toBe(
			'http://app.test/resources/phone-agent-config?number=%2B15550001111',
		)
		expect(init?.headers).toMatchObject({
			Authorization: 'Bearer test-voice-agent-token-0123456789abcdef',
		})
	})

	it('returns the passthrough App sends with a 409', async () => {
		const passthrough = {
			passthrough: true,
			error: 'Phone agent is off',
			phone: '+15552345678',
			message: 'Lo comunicamos ahora.',
			language: 'es',
			voiceId: 'voice-1',
			agentLines: ['+15552001111'],
		}
		respond(409, passthrough)
		await expect(requestRuntimeConfig(lookup)).resolves.toEqual({
			kind: 'passthrough',
			passthrough,
		})
	})

	it('accepts a passthrough from an App that does not send agent lines yet', async () => {
		respond(409, {
			passthrough: true,
			error: 'off',
			phone: null,
			message: null,
		})
		await expect(requestRuntimeConfig(lookup)).resolves.toMatchObject({
			passthrough: { agentLines: [], language: 'en', voiceId: null },
		})
	})

	it('looks test calls up by organization, scope, and flow', async () => {
		const fetchMock = respond(200, testConfig())
		await requestRuntimeConfig({
			kind: 'test',
			orgId: 'org_1',
			scopeId: 'scope_1',
			flow: 'draft',
		})
		await requestRuntimeConfig({
			kind: 'test',
			orgId: 'org_1',
			scopeId: null,
			flow: 'published',
		})
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			'http://app.test/resources/phone-agent-config?orgId=org_1&scopeId=scope_1&flow=draft',
			'http://app.test/resources/phone-agent-config?orgId=org_1&flow=published',
		])
	})

	it('reports a rejected token as a 401', async () => {
		respond(401, { error: 'Unauthorized' })
		await expect(requestRuntimeConfig(lookup)).rejects.toMatchObject({
			status: 401,
		})
	})

	it('gives App only a short time to answer', async () => {
		const fetchMock = respond(200, testConfig())
		const timeout = vi.spyOn(AbortSignal, 'timeout')
		await requestRuntimeConfig(lookup)
		expect(timeout).toHaveBeenCalledWith(CONFIG_REQUEST_TIMEOUT_MS)
		expect(CONFIG_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(3_000)
		expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal)
		timeout.mockRestore()
	})

	it('reports a network failure as unreachable', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('fetch failed')
			}),
		)
		await expect(requestRuntimeConfig(lookup)).rejects.toMatchObject({
			status: 0,
		})
	})
})

describe('tenantApi.startCall', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	const input = {
		orgId: 'org_1',
		channel: 'phone',
		roomName: 'room_1',
		scopeId: 'scope_1',
		flowVersionId: null,
		callerPhone: '+15552223333',
	} as const

	function respond(status: number, body: unknown) {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(body), { status })),
		)
	}

	it('returns only the call id, ignoring any customer name', async () => {
		respond(200, { callId: 'call_1', customerName: 'Jane Doe' })
		await expect(tenantApi.startCall(input)).resolves.toEqual({
			callId: 'call_1',
		})
	})

	it('accepts a response without a customer name', async () => {
		respond(200, { callId: 'call_1' })
		await expect(tenantApi.startCall(input)).resolves.toEqual({
			callId: 'call_1',
		})
	})

	it('rejects a response without a call id', async () => {
		respond(200, { customerName: 'Jane' })
		await expect(tenantApi.startCall(input)).rejects.toMatchObject({
			status: 502,
		})
	})
})

describe('tenantApi links', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('posts the link handoff and website link bodies tenant-api expects', async () => {
		const fetchMock = vi.fn(
			async (ignoredUrl: string, ignoredInit?: RequestInit) =>
				new Response(JSON.stringify({ url: 'https://x.test', smsSent: true }), {
					status: 200,
				}),
		)
		vi.stubGlobal('fetch', fetchMock)
		const handoff = {
			orgId: 'org_1',
			callId: 'call_1',
			scopeId: 'scope_1',
			path: '/book?scope=scope_1',
			payload: { note: 'Call back' },
			message: 'Acme: {url}',
			sendTo: '+15552223333',
		}
		await tenantApi.createHandoff(handoff)
		const { payload: ignoredPayload, ...website } = handoff
		await tenantApi.sendWebsiteLink(website)
		const calls = fetchMock.mock.calls.map(([url, init]) => [
			url,
			JSON.parse(String(init?.body)),
		])
		expect(calls).toEqual([
			['http://tenant.test/api/voice/handoffs', handoff],
			['http://tenant.test/api/voice/website-links', website],
		])
	})
})

describe('finishCallWithRetry', () => {
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	const sleep = vi.fn(async (ignoredMs: number) => undefined)

	it('retries a tenant-api outage with backoff until the log is saved', async () => {
		sleep.mockClear()
		const finish = vi
			.fn<() => Promise<unknown>>()
			.mockRejectedValueOnce(new ServiceError('Could not reach', 0))
			.mockRejectedValueOnce(new ServiceError('Bad gateway', 502))
			.mockResolvedValueOnce({ success: true })
		await expect(finishCallWithRetry(finish, { sleep })).resolves.toBe(true)
		expect(finish).toHaveBeenCalledTimes(3)
		expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(FINISH_RETRY_DELAYS_MS)
	})

	it('gives up after the last attempt without throwing', async () => {
		const finish = vi.fn(async () => {
			throw new ServiceError('Down', 503)
		})
		await expect(finishCallWithRetry(finish, { sleep })).resolves.toBe(false)
		expect(finish).toHaveBeenCalledTimes(FINISH_RETRY_DELAYS_MS.length + 1)
	})

	it('does not retry a request tenant-api rejected', async () => {
		const finish = vi.fn(async () => {
			throw new ServiceError('Invalid body', 400)
		})
		await expect(finishCallWithRetry(finish, { sleep })).resolves.toBe(false)
		expect(finish).toHaveBeenCalledTimes(1)
	})

	it('keeps the total wait bounded', () => {
		const total = FINISH_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)
		expect(total).toBeLessThanOrEqual(10_000)
	})
})

describe('smsBlockedExplanation', () => {
	it('explains why a text was not sent', () => {
		expect(smsBlockedExplanation('not_allowed_number')).toBe(
			"I can only text the number you're calling from or another US mobile number.",
		)
		expect(smsBlockedExplanation(undefined)).toBe("The text didn't go through.")
	})
})
