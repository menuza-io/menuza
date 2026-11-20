/**
 * #103 in the region: every guest email carries the organization's sender
 * name and verified reply-to, comes from its own domain only while that is
 * verified, falls back to the platform address when it is not (or when the
 * lookup fails), and no name can inject a header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindAppService } from './app-service.ts'
import {
	clearOrgEmailSenderCacheForTest,
	ORG_SENDER_TTL_MS,
} from './org-email-sender.ts'
import { sendTenantEmail } from './tenant-email.ts'

const sent = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))

vi.mock('@repo/email', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@repo/email')>()
	return {
		...actual,
		getOciEmailConfig: () => ({
			senderEmail: 'noreply@platform.example',
			senderName: 'Menuza',
		}),
		sendOciEmail: vi.fn(async (input: Record<string, unknown>) => {
			sent.calls.push(input)
			return { status: 'success', data: { messageId: 'm1' } }
		}),
	}
})

const orgId = 'clw9x0a12000008l00sender01'
const token = 'test-internal-command-token'

function appAnswers(body: unknown, status = 200) {
	const fetchMock = vi.fn(async () =>
		status === 200 ? Response.json(body) : new Response('no', { status }),
	)
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

const base = {
	to: 'guest@example.com',
	subject: 'Your order',
	html: '<p>Hi</p>',
	text: 'Hi',
}

beforeEach(() => {
	sent.calls.length = 0
	clearOrgEmailSenderCacheForTest()
	vi.stubEnv('APP_URL', 'https://app.example.com')
	vi.stubEnv('INTERNAL_COMMAND_TOKEN', token)
})
afterEach(() => {
	bindAppService(null)
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	vi.useRealTimers()
})

const org = { id: orgId, name: 'Al Bait' }

describe('guest email sender', () => {
	it('shows the organization name and verified reply-to on the platform address', async () => {
		appAnswers({
			...org,
			emailSender: {
				senderName: null,
				replyTo: 'owner@alrestaurant.com',
				fromEmail: null,
			},
		})
		await sendTenantEmail({
			...base,
			capture: { orgId, messageKind: 'order_receipt' },
		})
		expect(sent.calls).toHaveLength(1)
		expect(sent.calls[0]).toMatchObject({
			sender: { email: 'noreply@platform.example', name: 'Al Bait' },
			replyTo: { email: 'owner@alrestaurant.com' },
		})
	})

	it('uses the chosen sender name, and the restaurant address once its domain is verified', async () => {
		appAnswers({
			...org,
			emailSender: {
				senderName: 'Acme Pizza',
				replyTo: null,
				fromEmail: 'hello@acmepizza.com',
			},
		})
		await sendTenantEmail({ ...base, context: { orgId, messageId: 'x1' } })
		expect(sent.calls[0]).toMatchObject({
			sender: { email: 'hello@acmepizza.com', name: 'Acme Pizza' },
		})
		expect(sent.calls[0]).not.toHaveProperty('replyTo')
	})

	it('applies to every kind of sender: context, capture or an explicit orgId', async () => {
		appAnswers({
			...org,
			emailSender: { senderName: 'Acme', replyTo: null, fromEmail: null },
		})
		await sendTenantEmail({ ...base, orgId })
		await sendTenantEmail({ ...base, capture: { orgId } })
		await sendTenantEmail({ ...base, context: { orgId } })
		expect(sent.calls.map((c) => (c.sender as { name: string }).name)).toEqual([
			'Acme',
			'Acme',
			'Acme',
		])
	})

	it('falls back to the platform address when the domain is no longer verified (the App sends no address)', async () => {
		appAnswers({
			...org,
			emailSender: { senderName: 'Acme Pizza', replyTo: null, fromEmail: null },
		})
		await sendTenantEmail({ ...base, orgId })
		expect(sent.calls[0]).toMatchObject({
			sender: { email: 'noreply@platform.example', name: 'Acme Pizza' },
		})
	})

	it('leaves a message with no organization on the platform sender, as before', async () => {
		const fetchMock = appAnswers({})
		await sendTenantEmail({ ...base })
		expect(sent.calls[0]).not.toHaveProperty('sender')
		expect(sent.calls[0]).not.toHaveProperty('replyTo')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('never fails a send because the lookup failed', async () => {
		appAnswers({}, 503)
		const result = await sendTenantEmail({ ...base, orgId })
		expect(result.status).toBe('success')
		expect(sent.calls[0]).not.toHaveProperty('sender')

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network')
			}),
		)
		clearOrgEmailSenderCacheForTest()
		expect((await sendTenantEmail({ ...base, orgId })).status).toBe('success')
	})

	it('reads the settings once a minute, and keeps the last answer if the App stops answering', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		const fetchMock = appAnswers({
			...org,
			emailSender: { senderName: 'Acme', replyTo: null, fromEmail: null },
		})
		await sendTenantEmail({ ...base, orgId })
		await sendTenantEmail({ ...base, orgId })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock).toHaveBeenCalledWith(
			`https://app.example.com/resources/tenant-organization?orgId=${orgId}`,
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
			}),
		)
		vi.setSystemTime(Date.now() + ORG_SENDER_TTL_MS + 1)
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('down', { status: 503 })),
		)
		await sendTenantEmail({ ...base, orgId })
		expect((sent.calls[2]!.sender as { name: string }).name).toBe('Acme')
	})

	it('cannot be made to inject a header, whatever the stored name is', async () => {
		appAnswers({
			...org,
			emailSender: {
				senderName: 'Acme\r\nBcc: attacker@example.com',
				replyTo: 'owner@x.com\nBcc: attacker@example.com',
				fromEmail: 'hello@x.com\nBcc: attacker@example.com',
			},
		})
		await sendTenantEmail({ ...base, orgId })
		const call = sent.calls[0] as {
			sender: { email: string; name: string }
			replyTo?: unknown
		}
		expect(call.sender.name).not.toMatch(/[\r\n<>@]/u)
		expect(call.sender.email).toBe('noreply@platform.example')
		expect(call.replyTo).toBeUndefined()
	})

	it('ignores an answer about another organization', async () => {
		appAnswers({
			id: 'clw9x0a12000008l00othrorg1',
			name: 'Other',
			emailSender: { senderName: 'Other', replyTo: null, fromEmail: null },
		})
		await sendTenantEmail({ ...base, orgId })
		expect(sent.calls[0]).not.toHaveProperty('sender')
	})
})
