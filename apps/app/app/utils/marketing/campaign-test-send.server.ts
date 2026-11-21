import { i18n } from '@lingui/core'
import { msg } from '@lingui/macro'
import { db, eq, User } from '@repo/database'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'
import { campaignActionError } from './campaign-send.server.ts'

type FetchTenant = (path: string, init?: RequestInit) => Promise<Response>

/**
 * Makes a server-only tenant-api client whose token carries the recipient as a
 * signed claim (`testEmail`). tenant-api reads the address from the token and
 * never from the request body, so the browser cannot aim a test elsewhere.
 */
export type TestSendClientFactory = (claims: {
	testEmail: string
}) => Promise<FetchTenant>

/**
 * The factory the routes hand to a test send: a short-lived, server-only token
 * (never given to a browser) carrying the recipient claim.
 */
export function testSendClientFor(
	request: Request,
	orgSlug: string,
): TestSendClientFactory {
	return async (claims) =>
		(
			await getOperatorTenantClient(request, orgSlug, {
				canUpdate: true,
				claims,
				expiresIn: '5m',
			})
		).fetchTenant
}

export type TestSendResult = { ok: boolean; message: string }

/**
 * "Send a test" (#101): the message to the operator's own address, with sample
 * merge values and a "[Test]" subject, through tenant-api. The address is read
 * from the operator's own control-plane account and signed into the token; the
 * region uses it for this one send and does not keep it.
 *
 * Only email can be tested here: the control plane keeps no verified phone
 * number for an operator, so there is nothing to text. (tenant-api's route
 * takes a number for the day it does.)
 */
export async function sendTestBroadcast(input: {
	makeFetchTenant: TestSendClientFactory
	userId: string
	message: {
		channel: 'email' | 'sms' | 'push'
		subject: string | null
		content: string
		contentHtml: string | null
	}
}): Promise<TestSendResult> {
	if (input.message.channel !== 'email') {
		return {
			ok: false,
			message: i18n._(
				msg`Test sends are available for email only. Texts cannot be tested yet.`,
			),
		}
	}
	const [user] = await db
		.select({ email: User.email })
		.from(User)
		.where(eq(User.id, input.userId))
		.limit(1)
	if (!user?.email) {
		return {
			ok: false,
			message: i18n._(
				msg`Your account has no email address to send a test to.`,
			),
		}
	}

	const fetchTenant = await input.makeFetchTenant({ testEmail: user.email })
	const res = await fetchTenant('/operator/marketing/test-send', {
		method: 'POST',
		body: JSON.stringify({
			channel: 'email',
			subject: input.message.subject || null,
			content: input.message.content,
			contentHtml: input.message.contentHtml,
		}),
	})
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: unknown }
		return { ok: false, message: campaignActionError(body.error) }
	}
	const address = user.email
	return {
		ok: true,
		message: i18n._(msg`A test was sent to ${address}.`),
	}
}
