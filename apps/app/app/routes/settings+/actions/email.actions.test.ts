import { db, eq, User } from '@repo/database'
import { sendEmail } from '@repo/email'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	getResponseStatus,
} from '#tests/test-utils.ts'
import { action as verifyAction } from '../../_auth+/verify.tsx'
import { changeEmailAction } from './email.actions.tsx'

vi.mock('@repo/email', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	sendEmail: vi.fn().mockResolvedValue({ status: 'success' }),
}))

const sendEmailMock = vi.mocked(sendEmail)

function uniqueEmail(label: string) {
	return `${label}-${Math.random().toString(36).slice(2)}@example.test`
}

async function requestChange(
	userId: string,
	authCookie: string,
	email: string,
) {
	const formData = new FormData()
	formData.append('email', email)
	const response = await changeEmailAction({
		formData,
		userId,
		request: createAuthenticatedRequest(
			'http://localhost:3000/settings/profile',
			{ method: 'POST', body: formData },
			authCookie,
		),
	})
	// The mailed code is the only place the requester can learn it.
	const call = sendEmailMock.mock.calls.at(-1)?.[0] as any
	return {
		response,
		to: call?.to as string | undefined,
		otp: call?.react?.props?.otp as string | undefined,
		verifyCookie: response.headers.get('set-cookie')?.split(';')[0],
	}
}

async function submitCode(
	userId: string,
	authCookie: string,
	verifyCookie: string,
	code: string,
) {
	const formData = new FormData()
	formData.append('type', 'change-email')
	formData.append('target', userId)
	formData.append('code', code)
	try {
		return (await verifyAction({
			request: createAuthenticatedRequest(
				'http://localhost:3000/verify',
				{ method: 'POST', body: formData },
				`${authCookie}; ${verifyCookie}`,
			),
			params: {},
			context: {},
		} as any)) as Response
	} catch (thrown) {
		return thrown as Response
	}
}

async function emailOf(userId: string) {
	const [row] = await db
		.select({ email: User.email })
		.from(User)
		.where(eq(User.id, userId))
	return row?.email
}

describe('changeEmailAction', () => {
	beforeEach(() => sendEmailMock.mockClear())

	it('mails the code to the new address only and never returns it', async () => {
		const user = await createTestUser()
		const { cookie } = await createTestSession(user.id)
		const email = uniqueEmail('new')

		const { response, to, otp } = await requestChange(user.id, cookie, email)

		expect(response.status).toBe(200)
		expect(to).toBe(email)
		expect(otp).toBeTruthy()
		const body = JSON.stringify(await response.json())
		expect(body).not.toContain(otp!)
		expect(body).not.toContain('verifyUrl')
	})

	it('changes the address when the code from the same request is entered', async () => {
		const user = await createTestUser()
		const { cookie } = await createTestSession(user.id)
		const email = uniqueEmail('new')
		const { otp, verifyCookie } = await requestChange(user.id, cookie, email)

		const response = await submitCode(user.id, cookie, verifyCookie!, otp!)

		expect(response.status).toBe(302)
		expect(await emailOf(user.id)).toBe(email)
	})

	it('refuses a code that was sent to a different address than this browser asked for', async () => {
		const user = await createTestUser()
		const { cookie } = await createTestSession(user.id)
		const mine = uniqueEmail('mine')
		const theirs = uniqueEmail('theirs')
		const before = await emailOf(user.id)
		const first = await requestChange(user.id, cookie, mine)
		// An overlapping request replaces the stored code with one for `theirs`,
		// while this browser still holds the cookie naming `mine`.
		const second = await requestChange(user.id, cookie, theirs)

		const response = await submitCode(
			user.id,
			cookie,
			first.verifyCookie!,
			second.otp!,
		)

		expect(getResponseStatus(response)).toBe(400)
		expect(await emailOf(user.id)).toBe(before)
	})

	it('treats an address differing only in case as already in use and stores lowercase', async () => {
		const taken = uniqueEmail('taken')
		await createTestUser({ email: taken })
		const user = await createTestUser()
		const { cookie } = await createTestSession(user.id)

		const clash = await requestChange(user.id, cookie, taken.toUpperCase())
		expect(clash.response.status).toBe(400)
		expect(clash.verifyCookie).toBeUndefined()

		const mixed = uniqueEmail('Mixed').replace('mixed', 'MiXeD')
		const { otp, verifyCookie, to } = await requestChange(
			user.id,
			cookie,
			mixed,
		)
		expect(to).toBe(mixed.toLowerCase())
		const response = await submitCode(user.id, cookie, verifyCookie!, otp!)
		expect(response.status).toBe(302)
		expect(await emailOf(user.id)).toBe(mixed.toLowerCase())
	})

	it('limits how many codes one address can be sent', async () => {
		const user = await createTestUser()
		const { cookie } = await createTestSession(user.id)
		const email = uniqueEmail('target')

		for (let attempt = 0; attempt < 3; attempt++) {
			expect(
				(await requestChange(user.id, cookie, email)).response.status,
			).toBe(200)
		}
		const blocked = await requestChange(user.id, cookie, email)

		expect(blocked.response.status).toBe(429)
		expect(sendEmailMock).toHaveBeenCalledTimes(3)
	})

	it('limits how many codes one user can request across addresses', async () => {
		const user = await createTestUser()
		const { cookie } = await createTestSession(user.id)

		for (let attempt = 0; attempt < 5; attempt++) {
			expect(
				(await requestChange(user.id, cookie, uniqueEmail('spread'))).response
					.status,
			).toBe(200)
		}
		const blocked = await requestChange(user.id, cookie, uniqueEmail('spread'))

		expect(blocked.response.status).toBe(429)
		expect(sendEmailMock).toHaveBeenCalledTimes(5)
	})

	it('does not charge a recipient for a request the user limit refused', async () => {
		const user = await createTestUser()
		const { cookie } = await createTestSession(user.id)
		for (let attempt = 0; attempt < 5; attempt++) {
			await requestChange(user.id, cookie, uniqueEmail('spread'))
		}
		const victim = uniqueEmail('victim')
		for (let attempt = 0; attempt < 4; attempt++) {
			expect(
				(await requestChange(user.id, cookie, victim)).response.status,
			).toBe(429)
		}

		// Someone else can still send a code to that address.
		const other = await createTestUser()
		const { cookie: otherCookie } = await createTestSession(other.id)
		expect(
			(await requestChange(other.id, otherCookie, victim)).response.status,
		).toBe(200)
	})

	it('greets the user by name, not the template placeholder', async () => {
		const user = await createTestUser()
		const { cookie } = await createTestSession(user.id)

		await requestChange(user.id, cookie, uniqueEmail('greet'))

		const react = (sendEmailMock.mock.calls.at(-1)?.[0] as any).react
		expect(react.props.firstName).toBeTruthy()
		expect(react.props.firstName).not.toBe('Developer')
	})
})
