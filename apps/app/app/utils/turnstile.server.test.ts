import { TURNSTILE_SITEVERIFY_URL } from '@repo/common/turnstile'
import { getClientIp } from '@repo/security'
import { http, HttpResponse } from 'msw'
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import { ensureLinguiRequestLocale } from '#app/modules/lingui/lingui.server.ts'
import { server } from '#tests/mocks/index.ts'
import {
	checkOperatorTurnstile,
	getOperatorTurnstileSiteKey,
	TURNSTILE_RESPONSE_FIELD,
	turnstileCspSources,
} from './turnstile.server.ts'

function submission(token?: string) {
	const formData = new FormData()
	formData.set('username', 'kody')
	if (token !== undefined) formData.set(TURNSTILE_RESPONSE_FIELD, token)
	return formData
}

const request = () =>
	new Request('http://localhost:3001/login', {
		method: 'POST',
		headers: { 'CF-Connecting-IP': '203.0.113.7' },
	})

function mockSiteverify(
	result: Record<string, unknown>,
	onBody?: (body: URLSearchParams) => void,
) {
	server.use(
		http.post(TURNSTILE_SITEVERIFY_URL, async ({ request }) => {
			onBody?.(new URLSearchParams(await request.text()))
			return HttpResponse.json(result)
		}),
	)
}

beforeAll(async () => {
	// The error messages are Lingui strings; actions activate the locale first.
	await ensureLinguiRequestLocale(new Request('http://localhost:3001/login'))
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('operator Turnstile, not configured', () => {
	beforeEach(() => {
		vi.stubEnv('TURNSTILE_SITE_KEY', '')
		vi.stubEnv('TURNSTILE_SECRET_KEY', '')
	})

	it('bypasses the check and adds no CSP source', async () => {
		let called = false
		mockSiteverify({ success: false }, () => {
			called = true
		})

		expect(getOperatorTurnstileSiteKey()).toBeNull()
		expect(turnstileCspSources()).toEqual([])
		await expect(
			checkOperatorTurnstile(request(), submission(), 'login'),
		).resolves.toEqual({ ok: true })
		expect(called).toBe(false)
	})

	it('stays off when only one of the two keys is set', async () => {
		vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret-only')
		expect(getOperatorTurnstileSiteKey()).toBeNull()
		await expect(
			checkOperatorTurnstile(request(), submission(), 'login'),
		).resolves.toEqual({ ok: true })

		vi.stubEnv('TURNSTILE_SECRET_KEY', '')
		vi.stubEnv('TURNSTILE_SITE_KEY', 'site-only')
		expect(getOperatorTurnstileSiteKey()).toBeNull()
	})
})

describe('operator Turnstile, configured', () => {
	beforeEach(() => {
		vi.stubEnv('TURNSTILE_SITE_KEY', '0x4AAAAAAA-site')
		vi.stubEnv('TURNSTILE_SECRET_KEY', '0x4AAAAAAA-secret')
		vi.stubEnv('TURNSTILE_HOSTNAMES', '')
	})

	it('exposes the site key and the challenge origin for CSP', () => {
		expect(getOperatorTurnstileSiteKey()).toBe('0x4AAAAAAA-site')
		expect(turnstileCspSources()).toEqual(['https://challenges.cloudflare.com'])
	})

	it('refuses a submission without a token, without calling siteverify', async () => {
		let called = false
		mockSiteverify({ success: true, action: 'login' }, () => {
			called = true
		})

		const result = await checkOperatorTurnstile(
			request(),
			submission(),
			'login',
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/security check/i)

		const blank = await checkOperatorTurnstile(
			request(),
			submission('   '),
			'login',
		)
		expect(blank.ok).toBe(false)
		expect(called).toBe(false)
	})

	it('passes when siteverify succeeds for the expected action', async () => {
		let body: URLSearchParams | undefined
		mockSiteverify({ success: true, action: 'signup' }, (b) => {
			body = b
		})

		const req = request()
		await expect(
			checkOperatorTurnstile(req, submission('token-123'), 'signup'),
		).resolves.toEqual({ ok: true })
		expect(body?.get('secret')).toBe('0x4AAAAAAA-secret')
		expect(body?.get('response')).toBe('token-123')
		expect(body?.get('remoteip') ?? undefined).toBe(
			getClientIp(req, { returnUndefined: true }),
		)
	})

	it('refuses a token minted for another form', async () => {
		mockSiteverify({ success: true, action: 'signup' })
		const result = await checkOperatorTurnstile(
			request(),
			submission('token-123'),
			'login',
		)
		expect(result.ok).toBe(false)
	})

	it('refuses when siteverify rejects the token', async () => {
		mockSiteverify({
			success: false,
			'error-codes': ['timeout-or-duplicate'],
		})
		const result = await checkOperatorTurnstile(
			request(),
			submission('used-token'),
			'login',
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/security check failed/i)
	})

	it('refuses a hostname outside TURNSTILE_HOSTNAMES', async () => {
		vi.stubEnv('TURNSTILE_HOSTNAMES', 'app.example.com')
		mockSiteverify({
			success: true,
			action: 'login',
			hostname: 'evil.example.net',
		})
		const result = await checkOperatorTurnstile(
			request(),
			submission('token-123'),
			'login',
		)
		expect(result.ok).toBe(false)
	})

	it('fails closed with a form error when siteverify is unreachable', async () => {
		server.use(http.post(TURNSTILE_SITEVERIFY_URL, () => HttpResponse.error()))
		const result = await checkOperatorTurnstile(
			request(),
			submission('token-123'),
			'login',
		)
		expect(result.ok).toBe(false)
	})
})
