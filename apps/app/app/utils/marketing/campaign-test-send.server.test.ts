import { i18n } from '@lingui/core'
import { db } from '@repo/database'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendTestBroadcast } from './campaign-test-send.server.ts'

vi.mock('@repo/database', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	db: { select: vi.fn() },
}))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function userHasEmail(email: string | null) {
	vi.mocked(db.select).mockReturnValue({
		from: () => ({
			where: () => ({ limit: async () => (email === null ? [] : [{ email }]) }),
		}),
	} as never)
}

const message = {
	channel: 'email' as const,
	subject: 'Lunch',
	content: 'Hello',
	contentHtml: '<p>Hello</p>',
}

describe('sendTestBroadcast', () => {
	beforeEach(() => {
		vi.mocked(db.select).mockReset()
	})

	it('signs the operator’s own address into the token and never into the body', async () => {
		userHasEmail('owner@restaurant.test')
		const fetchTenant = vi.fn(async () => Response.json({ success: true }))
		const makeFetchTenant = vi.fn(async () => fetchTenant)

		const result = await sendTestBroadcast({
			makeFetchTenant,
			userId: 'user-1',
			message,
		})

		expect(result.ok).toBe(true)
		expect(makeFetchTenant).toHaveBeenCalledWith({
			testEmail: 'owner@restaurant.test',
		})
		const [path, init] = fetchTenant.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(path).toBe('/operator/marketing/test-send')
		const body = JSON.parse(String(init.body)) as Record<string, unknown>
		expect(body).not.toHaveProperty('to')
		expect(JSON.stringify(body)).not.toContain('owner@restaurant.test')
	})

	it('sends nothing when the account has no address, and not for a text', async () => {
		const makeFetchTenant = vi.fn()
		userHasEmail(null)
		expect(
			(await sendTestBroadcast({ makeFetchTenant, userId: 'u', message })).ok,
		).toBe(false)
		expect(
			(
				await sendTestBroadcast({
					makeFetchTenant,
					userId: 'u',
					message: { ...message, channel: 'sms' },
				})
			).ok,
		).toBe(false)
		expect(makeFetchTenant).not.toHaveBeenCalled()
	})

	it('turns a refusal into the operator’s message', async () => {
		userHasEmail('owner@restaurant.test')
		const result = await sendTestBroadcast({
			makeFetchTenant: async () => async () =>
				Response.json({ error: 'test_send_limit' }, { status: 429 }),
			userId: 'user-1',
			message,
		})
		expect(result.ok).toBe(false)
		expect(result.message.length).toBeGreaterThan(0)
	})
})
