import { i18n } from '@lingui/core'
import { msg } from '@lingui/macro'
import { db, eq, User } from '@repo/database'
import { campaignActionError } from './campaign-send.server.ts'

type FetchTenant = (path: string, init?: RequestInit) => Promise<Response>

export type TestSendResult = { ok: boolean; message: string }

/**
 * "Send a test" (#101): the message to the operator's own address, with sample
 * merge values and a "[Test]" subject, through tenant-api. The address is read
 * from the operator's own control-plane account and passed in the request; the
 * region uses it for this one send and does not keep it.
 *
 * Only email can be tested here: the control plane keeps no verified phone
 * number for an operator, so there is nothing to text. (tenant-api's route
 * takes a number for the day it does.)
 */
export async function sendTestBroadcast(input: {
	fetchTenant: FetchTenant
	userId: string
	message: {
		channel: 'email' | 'sms'
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

	const res = await input.fetchTenant('/operator/marketing/test-send', {
		method: 'POST',
		body: JSON.stringify({
			channel: 'email',
			subject: input.message.subject || null,
			content: input.message.content,
			contentHtml: input.message.contentHtml,
			to: { email: user.email },
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
