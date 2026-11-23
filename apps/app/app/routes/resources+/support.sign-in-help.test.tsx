import { recordSignInCodeDelivery } from '@repo/auth'
import {
	OrderAlertRecipient,
	OrganizationLocation,
	SignInCodeDelivery,
	Verification,
	db,
	eq,
} from '@repo/database'
import type * as EmailModule from '@repo/email'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

const sendEmailMock = vi.hoisted(() => vi.fn())

vi.mock('@repo/email', async (importOriginal) => ({
	...(await importOriginal<typeof EmailModule>()),
	sendEmail: sendEmailMock,
}))

import {
	MockAlertTextProvider,
	setAlertTextProvider,
} from '#app/utils/alerts/text.server.ts'
import {
	MockPhoneLookup,
	setPhoneLookupProvider,
} from '#app/utils/phone-lookup.server.ts'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { action as signInHelp } from './support.sign-in-help.tsx'
import { action as smsStatus } from './support.sms-status.ts'

function call(
	run: (args: never) => Promise<unknown>,
	path: string,
	body: unknown,
	authorized = true,
) {
	return run({
		request: new Request(`http://localhost:3001${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(authorized
					? { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }
					: {}),
			},
			body: JSON.stringify(body),
		}),
		params: {},
		context: new RouterContextProvider(),
	} as never).catch((thrown: unknown) => thrown) as Promise<Response>
}

const texts = new MockAlertTextProvider()
beforeEach(() => {
	sendEmailMock.mockReset().mockResolvedValue({
		status: 'success',
		data: { id: 'em_resend_1' },
	})
	texts.reset()
	setAlertTextProvider(texts)
	setPhoneLookupProvider(new MockPhoneLookup())
})

describe('sign-in code delivery log (#246)', () => {
	it('logs a resent email, with the provider id, and keeps the code out of the log', async () => {
		const { user } = await setupTestOrgWithUser('admin')
		const response = await call(signInHelp, '/resources/support/sign-in-help', {
			intent: 'resend',
			userId: user.id,
			channel: 'email',
		})
		expect(await response.json()).toMatchObject({
			status: 'sent',
			channel: 'email',
		})

		const [verification] = await db
			.select()
			.from(Verification)
			.where(eq(Verification.target, user.email))
		expect(verification).toBeTruthy()

		const rows = await db
			.select()
			.from(SignInCodeDelivery)
			.where(eq(SignInCodeDelivery.userId, user.id))
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			purpose: 'sign_in_help',
			channel: 'email',
			providerMessageId: 'em_resend_1',
			status: 'sent',
		})
		// The email went out; its code is in the email only.
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
		const html = JSON.stringify(
			sendEmailMock.mock.calls[0]![0].react?.props ?? {},
		)
		const otp = (html.match(/"otp":"([A-Z0-9]{6})"/) ?? [])[1]
		expect(otp).toBeTruthy()
		expect(JSON.stringify(rows)).not.toContain(otp)
		expect(JSON.stringify(rows)).not.toContain(user.email)
	})

	it('texts the code to a verified number the operator added, and logs it', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const [location] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: organization.id,
				name: 'Main street',
				slug: 'main-street',
			})
			.returning()
		await db.insert(OrderAlertRecipient).values({
			organizationId: organization.id,
			locationId: location!.id,
			kind: 'phone',
			address: '+14155551234',
			verifiedAt: new Date(),
			createdBy: user.id,
		})
		const response = await call(signInHelp, '/resources/support/sign-in-help', {
			intent: 'resend',
			userId: user.id,
			channel: 'sms',
		})
		expect(await response.json()).toMatchObject({
			status: 'sent',
			channel: 'sms',
		})
		expect(texts.sent).toHaveLength(1)
		expect(texts.sent[0]!.to).toBe('+14155551234')
		expect(texts.sent[0]!.text).toMatch(/Reply STOP to opt out\.$/)

		const [row] = await db
			.select()
			.from(SignInCodeDelivery)
			.where(eq(SignInCodeDelivery.userId, user.id))
		expect(row).toMatchObject({
			channel: 'sms',
			purpose: 'sign_in_help',
			provider: 'mock',
			status: 'sent',
		})
		expect(row!.providerMessageId).toBeTruthy()
		// The log holds neither the number nor the code that was texted.
		const code = texts.sent[0]!.text.match(/code is ([A-Z0-9]{6})/)?.[1]
		expect(code).toBeTruthy()
		expect(JSON.stringify(row)).not.toContain(code)
		expect(JSON.stringify(row)).not.toContain('4155551234')
	})

	it('says there is no phone on file when the operator has none', async () => {
		const { user } = await setupTestOrgWithUser('admin')
		const response = await call(signInHelp, '/resources/support/sign-in-help', {
			intent: 'resend',
			userId: user.id,
			channel: 'sms',
		})
		expect(await response.json()).toEqual({ status: 'no_phone_on_file' })
		expect(texts.sent).toHaveLength(0)
	})

	it('checks a number: a landline and an invalid number are identified', async () => {
		const landline = await call(signInHelp, '/resources/support/sign-in-help', {
			intent: 'check_phone',
			phone: '+14155550000',
		})
		expect(await landline.json()).toMatchObject({
			status: 'ok',
			check: { valid: true, lineType: 'landline' },
		})
		const invalid = await call(signInHelp, '/resources/support/sign-in-help', {
			intent: 'check_phone',
			phone: '+14155559999',
		})
		expect(await invalid.json()).toMatchObject({
			status: 'ok',
			check: { valid: false },
		})
	})

	it('is for the internal token only, and refuses a field outside the contract', async () => {
		const denied = await call(
			signInHelp,
			'/resources/support/sign-in-help',
			{ intent: 'check_phone', phone: '+14155550000' },
			false,
		)
		expect(denied.status).toBe(401)
		const strict = await call(signInHelp, '/resources/support/sign-in-help', {
			intent: 'resend',
			userId: 'u',
			channel: 'email',
			code: '123456',
		})
		expect(strict.status).toBe(400)
	})

	it("updates a text from the carrier's report, with the error code and no number", async () => {
		await recordSignInCodeDelivery({
			purpose: 'alert_recipient',
			channel: 'sms',
			destination: '+14155550000',
			provider: 'twilio',
			providerMessageId: 'SM1234567890abcdef',
		})
		const response = await call(smsStatus, '/resources/support/sms-status', {
			providerMessageId: 'SM1234567890abcdef',
			status: 'undelivered',
			errorCode: '30006',
		})
		expect(await response.json()).toEqual({ matched: true })
		const [row] = await db
			.select()
			.from(SignInCodeDelivery)
			.where(eq(SignInCodeDelivery.providerMessageId, 'SM1234567890abcdef'))
		expect(row).toMatchObject({ status: 'bounced', failureReason: '30006' })
		expect(JSON.stringify(row)).not.toContain('4155550000')

		// A report for a text that is not ours, and one with an extra field.
		const other = await call(smsStatus, '/resources/support/sms-status', {
			providerMessageId: 'SMotherotherother',
			status: 'delivered',
			errorCode: null,
		})
		expect(await other.json()).toEqual({ matched: false })
		const withNumber = await call(smsStatus, '/resources/support/sms-status', {
			providerMessageId: 'SM1234567890abcdef',
			status: 'delivered',
			errorCode: null,
			to: '+14155550000',
		})
		expect(withNumber.status).toBe(400)
	})
})
