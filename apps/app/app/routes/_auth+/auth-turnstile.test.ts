import { TURNSTILE_SITEVERIFY_URL } from '@repo/common/turnstile'
import { db, eq, Session } from '@repo/database'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TURNSTILE_RESPONSE_FIELD } from '#app/utils/turnstile.server.ts'
import { server } from '#tests/mocks/index.ts'
import { createTestUser, getResponseStatus } from '#tests/test-utils.ts'
import { action as forgotPasswordAction } from './forgot-password.tsx'
import { action as loginAction, loader as loginLoader } from './login.tsx'
import { action as signupAction } from './signup.tsx'

function post(url: string, formData: FormData) {
	return new Request(url, { method: 'POST', body: formData })
}

function callAction(
	fn: typeof loginAction | typeof signupAction | typeof forgotPasswordAction,
	request: Request,
) {
	return fn({ request, params: {}, context: {} } as any) as Promise<any>
}

describe('Turnstile on operator auth forms', () => {
	let siteverifyCalls = 0

	beforeEach(() => {
		siteverifyCalls = 0
		vi.stubEnv('TURNSTILE_SITE_KEY', '0x4AAAAAAA-site')
		vi.stubEnv('TURNSTILE_SECRET_KEY', '0x4AAAAAAA-secret')
		vi.stubEnv('TURNSTILE_HOSTNAMES', '')
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	function mockSiteverify(action: string) {
		server.use(
			http.post(TURNSTILE_SITEVERIFY_URL, () => {
				siteverifyCalls++
				return HttpResponse.json({ success: true, action })
			}),
		)
	}

	it('sends the site key to the login page', async () => {
		const result = (await loginLoader({
			request: new Request('http://localhost:3000/login'),
			params: {},
			context: {},
		} as any)) as any
		expect(result.turnstileSiteKey).toBe('0x4AAAAAAA-site')
	})

	it('refuses a login without a token before checking the password', async () => {
		const password = 'ValidPassword123!'
		const user = await createTestUser({ password })
		const formData = new FormData()
		formData.append('username', user.username)
		formData.append('password', password)

		const response = await callAction(
			loginAction,
			post('http://localhost:3000/login', formData),
		)

		expect(getResponseStatus(response)).toBe(400)
		expect(response.data?.result?.error?.['']?.[0]).toMatch(/security check/i)
		const sessions = await db
			.select({ id: Session.id })
			.from(Session)
			.where(eq(Session.userId, user.id))
		expect(sessions).toHaveLength(0)
	})

	it('logs in when siteverify accepts the token', async () => {
		mockSiteverify('login')
		const password = 'ValidPassword123!'
		const user = await createTestUser({ password })
		const formData = new FormData()
		formData.append('username', user.username)
		formData.append('password', password)
		formData.append(TURNSTILE_RESPONSE_FIELD, 'token-123')

		const response = (await callAction(
			loginAction,
			post('http://localhost:3000/login', formData),
		)) as Response

		expect(response.status).toBe(302)
		expect(siteverifyCalls).toBe(1)
	})

	it('leaves the SSO discovery step unchallenged', async () => {
		const formData = new FormData()
		formData.append('intent', 'check-email')
		formData.append('username', 'someone@example.com')

		const response = await callAction(
			loginAction,
			post('http://localhost:3000/login', formData),
		)

		expect(getResponseStatus(response)).toBe(200)
		expect(response.data?.ssoAvailable).toBe(false)
		expect(siteverifyCalls).toBe(0)
	})

	it('refuses a signup without a token before sending any email', async () => {
		const formData = new FormData()
		formData.append('email', 'new-user@example.com')

		const response = await callAction(
			signupAction,
			post('http://localhost:3000/signup', formData),
		)

		expect(getResponseStatus(response)).toBe(400)
		expect(response.data?.result?.error?.['']?.[0]).toMatch(/security check/i)
	})

	it('refuses a signup token minted for the login form', async () => {
		mockSiteverify('login')
		const formData = new FormData()
		formData.append('email', 'new-user@example.com')
		formData.append(TURNSTILE_RESPONSE_FIELD, 'token-123')

		const response = await callAction(
			signupAction,
			post('http://localhost:3000/signup', formData),
		)

		expect(getResponseStatus(response)).toBe(400)
		expect(siteverifyCalls).toBe(1)
	})

	it('refuses a password reset without a token before the account lookup', async () => {
		const user = await createTestUser()
		const formData = new FormData()
		formData.append('usernameOrEmail', user.email)

		const response = await callAction(
			forgotPasswordAction,
			post('http://localhost:3000/forgot-password', formData),
		)

		expect(getResponseStatus(response)).toBe(400)
		expect(response.data?.result?.error?.['']?.[0]).toMatch(/security check/i)
	})
})
