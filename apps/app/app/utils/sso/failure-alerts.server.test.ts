import {
	and,
	db,
	eq,
	Notification,
	NotificationPreference,
	SsoFailureEvent,
	SsoFailureNotice,
	User,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	addOrganizationMember,
	createTestOrganization,
	createTestUser,
} from '#tests/test-utils.ts'

const mail = vi.hoisted(() => ({ fail: false }))
const sendEmail = vi.hoisted(() => vi.fn())

vi.mock('@repo/email', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	sendEmail,
}))

const { handleSSOError, createSSOError, SSOErrorType } =
	await import('./error-handling.server.ts')
const { recordSsoFailure } = await import('./failure-alerts.server.ts')
const {
	SSO_FAILURE_WORKFLOW,
	SSO_REASON_EMAIL,
	organizationSlugFromSsoRequestUrl,
} = await import('./sso-alerts.ts')

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const T0 = new Date('2027-03-01T10:00:00Z')

async function setup() {
	const admin = await createTestUser()
	const organization = await createTestOrganization(admin.id, 'admin')
	return { admin, organization }
}

function fail(
	slug: string,
	at: Date,
	errorType: string = SSOErrorType.TOKEN_EXCHANGE_FAILED,
) {
	return recordSsoFailure(
		{ organizationSlug: slug, errorType },
		{ now: () => at, sendEmail: sendEmail as never },
	)
}

async function failTimes(slug: string, start: Date, times: number) {
	const results = []
	for (let i = 0; i < times; i++) {
		results.push(await fail(slug, new Date(start.getTime() + i * 10_000)))
	}
	return results
}

function sentTo() {
	return sendEmail.mock.calls.map(([input]) => input.to as string)
}

describe('SSO failure alerts (#347)', () => {
	beforeEach(() => {
		// handleSSOError logs the (sanitized) error; that is expected here.
		vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		sendEmail.mockReset()
		sendEmail.mockImplementation(async () =>
			mail.fail
				? {
						status: 'error',
						error: { name: 'x', message: 'y', statusCode: 500 },
					}
				: { status: 'success', data: { id: 'email_1' } },
		)
		mail.fail = false
	})

	it('sends one email to the admins after five failures in ten minutes', async () => {
		const { admin, organization } = await setup()
		const results = await failTimes(organization.slug, T0, 4)
		expect(results.map((r) => r.status)).toEqual([
			'recorded',
			'recorded',
			'recorded',
			'recorded',
		])
		expect(sendEmail).not.toHaveBeenCalled()

		const fifth = await fail(organization.slug, new Date(T0.getTime() + 50_000))
		expect(fifth).toMatchObject({ status: 'notified', failures: 5, emailed: 1 })
		const [adminRow] = await db
			.select({ email: User.email })
			.from(User)
			.where(eq(User.id, admin.id))
		expect(sentTo()).toEqual([adminRow!.email])
	})

	it('sends only one email per hour for one outage, and again after the hour', async () => {
		const { organization } = await setup()
		await failTimes(organization.slug, T0, 5)
		expect(sendEmail).toHaveBeenCalledTimes(1)

		// The outage goes on: more failures inside the hour tell nobody again.
		const more = await failTimes(
			organization.slug,
			new Date(T0.getTime() + 2 * MINUTE),
			10,
		)
		expect(more.every((r) => r.status === 'throttled')).toBe(true)
		expect(sendEmail).toHaveBeenCalledTimes(1)

		// An hour later, five new failures send the next notice.
		await failTimes(
			organization.slug,
			new Date(T0.getTime() + HOUR + MINUTE),
			5,
		)
		expect(sendEmail).toHaveBeenCalledTimes(2)
	})

	it('does not count failures spread over more than ten minutes', async () => {
		const { organization } = await setup()
		for (let i = 0; i < 6; i++) {
			await fail(organization.slug, new Date(T0.getTime() + i * 3 * MINUTE))
		}
		// Never five inside any ten-minute window.
		expect(sendEmail).not.toHaveBeenCalled()
	})

	it('names the failure reason in plain words, without any secret', async () => {
		const { organization } = await setup()
		await failTimes(organization.slug, T0, 5)
		const [input] = sendEmail.mock.calls[0]!
		const text = JSON.stringify(input.react.props)
		expect(input.subject).toContain(organization.name)
		expect(text).toContain(SSO_REASON_EMAIL.token_exchange_failed)
		expect(text).toContain('5 sign-in attempts failed in the last 10 minutes')
		expect(text).toContain(`/${organization.slug}/settings`)
		// Nothing a person or a provider could have typed is in it.
		for (const secret of [
			'client_secret',
			'eyJ',
			'@',
			'password',
			'assertion',
		]) {
			expect(text.replace(/https?:\/\/\S+/g, '')).not.toContain(secret)
		}
	})

	it('never carries the provider message, a token or a user through handleSSOError', async () => {
		const { organization } = await setup()
		const request = new Request(
			`http://localhost:3001/auth/sso/${organization.slug}/callback?code=abc`,
		)
		const secretMessage =
			'invalid_grant for jane@example.com client_secret=hunter2 eyJhbGciOiJIUzI1NiJ9.payload.sig'
		for (let i = 0; i < 5; i++) {
			await handleSSOError(
				createSSOError(
					SSOErrorType.TOKEN_EXCHANGE_FAILED,
					secretMessage,
					'assertion: <saml:Assertion>',
				),
				'/login',
				request,
			)
		}
		expect(sendEmail).toHaveBeenCalledTimes(1)
		const everything = JSON.stringify([
			sendEmail.mock.calls[0]![0].react.props,
			sendEmail.mock.calls[0]![0].subject,
			await db
				.select()
				.from(SsoFailureEvent)
				.where(eq(SsoFailureEvent.organizationId, organization.id)),
			await db
				.select()
				.from(Notification)
				.where(eq(Notification.organizationId, organization.id)),
			await db
				.select()
				.from(SsoFailureNotice)
				.where(eq(SsoFailureNotice.organizationId, organization.id)),
		])
		for (const secret of [
			'jane@example.com',
			'hunter2',
			'eyJhbGci',
			'saml:Assertion',
		]) {
			expect(everything).not.toContain(secret)
		}
	})

	it('counts only failures that point at the setup, not a wrong user or a rate limit', async () => {
		const { organization } = await setup()
		const request = new Request(
			`http://localhost:3001/auth/sso/${organization.slug}/callback`,
		)
		for (const type of [
			SSOErrorType.AUTHENTICATION_FAILED,
			SSOErrorType.USER_NOT_AUTHORIZED,
			SSOErrorType.RATE_LIMIT_EXCEEDED,
			SSOErrorType.NETWORK_ERROR,
		]) {
			for (let i = 0; i < 6; i++) {
				await handleSSOError(createSSOError(type, 'x'), '/login', request)
			}
		}
		expect(
			await db
				.select()
				.from(SsoFailureEvent)
				.where(eq(SsoFailureEvent.organizationId, organization.id)),
		).toEqual([])
		expect(sendEmail).not.toHaveBeenCalled()
	})

	it('stops the emails for an admin who muted the notice, and the bell for one who muted that', async () => {
		const { admin, organization } = await setup()
		const second = await createTestUser()
		await addOrganizationMember(second.id, organization.id, 'org_role_admin')
		const third = await createTestUser()
		await addOrganizationMember(third.id, organization.id, 'org_role_admin')
		await db.insert(NotificationPreference).values([
			// Muted entirely.
			{
				userId: admin.id,
				organizationId: organization.id,
				workflow: SSO_FAILURE_WORKFLOW,
				email: false,
				inApp: false,
			},
			// Email muted, the bell stays.
			{
				userId: second.id,
				organizationId: organization.id,
				workflow: SSO_FAILURE_WORKFLOW,
				email: false,
				inApp: true,
			},
		])
		await failTimes(organization.slug, T0, 5)
		const [secondRow] = await db
			.select({ email: User.email })
			.from(User)
			.where(eq(User.id, second.id))
		const [thirdRow] = await db
			.select({ email: User.email })
			.from(User)
			.where(eq(User.id, third.id))
		expect(sentTo()).toEqual([thirdRow!.email])
		expect(sentTo()).not.toContain(secondRow!.email)
		const notified = (
			await db
				.select()
				.from(Notification)
				.where(eq(Notification.organizationId, organization.id))
		).map((n) => n.userId)
		expect(notified.sort()).toEqual([second.id, third.id].sort())
	})

	it('tells nobody who cannot run the settings', async () => {
		const { organization } = await setup()
		const viewer = await createTestUser()
		await addOrganizationMember(viewer.id, organization.id, 'org_role_viewer')
		await failTimes(organization.slug, T0, 5)
		const [viewerRow] = await db
			.select({ email: User.email })
			.from(User)
			.where(eq(User.id, viewer.id))
		expect(sentTo()).not.toContain(viewerRow!.email)
		const viewerNotices = await db
			.select()
			.from(Notification)
			.where(and(eq(Notification.userId, viewer.id)))
		expect(viewerNotices).toEqual([])
	})

	it('writes one in-app notice per admin and outage hour', async () => {
		const { admin, organization } = await setup()
		await failTimes(organization.slug, T0, 5)
		await failTimes(organization.slug, new Date(T0.getTime() + MINUTE), 5)
		const notices = await db
			.select()
			.from(Notification)
			.where(eq(Notification.userId, admin.id))
		expect(notices).toHaveLength(1)
		expect(JSON.parse(notices[0]!.payload)).toEqual({
			orgSlug: organization.slug,
			reasonKind: 'token_exchange_failed',
			failures: 5,
		})
	})

	it('gives the claim back when nothing could be delivered, so the next failure tries again', async () => {
		const { admin, organization } = await setup()
		// The only admin muted the bell, and the email provider is down.
		await db.insert(NotificationPreference).values({
			userId: admin.id,
			organizationId: organization.id,
			workflow: SSO_FAILURE_WORKFLOW,
			email: true,
			inApp: false,
		})
		mail.fail = true
		await failTimes(organization.slug, T0, 5)
		expect(sendEmail).toHaveBeenCalledTimes(1)
		expect(
			await db
				.select()
				.from(SsoFailureNotice)
				.where(eq(SsoFailureNotice.organizationId, organization.id)),
		).toEqual([])
		mail.fail = false
		const next = await fail(organization.slug, new Date(T0.getTime() + MINUTE))
		expect(next).toMatchObject({ status: 'notified', emailed: 1 })
	})

	it('ignores an unknown organization', async () => {
		expect(await fail('no-such-org', T0)).toEqual({
			status: 'unknown_organization',
		})
	})

	it('reads the organization from the SSO request path only', () => {
		expect(
			organizationSlugFromSsoRequestUrl(
				'http://x/auth/sso/acme/callback?code=1',
			),
		).toBe('acme')
		expect(organizationSlugFromSsoRequestUrl('http://x/auth/sso/acme')).toBe(
			'acme',
		)
		expect(organizationSlugFromSsoRequestUrl('http://x/login')).toBeNull()
		expect(organizationSlugFromSsoRequestUrl(undefined)).toBeNull()
	})
})
