import { i18n } from '@lingui/core'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { auditCampaign } from './campaign-audit.server.ts'
import { prepareCampaignMessage } from './campaign-message.server.ts'
import { runSendChecks } from './campaign-send.server.ts'
import { submitCampaign } from './campaign-submit.server.ts'

vi.mock('./campaign-audit.server.ts', () => ({ auditCampaign: vi.fn() }))
vi.mock('#app/utils/email/designer.server.ts', () => ({ designEmail: vi.fn() }))
vi.mock('#app/utils/discounts/marketing-offers.server.ts', () => ({
	checkMarketingOffer: vi.fn(),
	readOfferField: () => null,
}))
vi.mock('./campaign-send.server.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	runSendChecks: vi.fn(),
}))
vi.mock('#app/utils/legal/agreements.server.ts', () => ({
	requireModuleAgreement: vi.fn(async () => null),
}))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function form(fields: Record<string, string>) {
	const data = new FormData()
	data.set('name', 'Spring')
	data.set('channel', 'push')
	for (const [key, value] of Object.entries(fields)) data.set(key, value)
	return data
}

const prepare = (fields: Record<string, string>) =>
	prepareCampaignMessage({
		formData: form(fields),
		organizationId: 'org',
		userId: 'user',
		baseUrl: 'http://localhost',
	})

describe('a push broadcast in the App (#105)', () => {
	it('prepares a title, a message, a site page and an image, with no coupon', async () => {
		const result = await prepare({
			subject: 'Fresh summer menu',
			content: 'Open the app to take a look.',
			pushLink: '/menu',
			pushImageUrl: 'https://cdn.example.com/summer.jpg',
		})
		expect(result).toMatchObject({
			ok: true,
			message: {
				channel: 'push',
				subject: 'Fresh summer menu',
				content: 'Open the app to take a look.',
				pushLink: '/menu',
				pushImageUrl: 'https://cdn.example.com/summer.jpg',
				contentHtml: null,
				discountOffer: null,
			},
		})
	})

	it('refuses merge tags in the title or the message: a push holds no personal data', async () => {
		for (const fields of [
			{ subject: 'Hi {{name}}', content: 'Come in' },
			{ subject: 'Hello', content: 'Use {{couponCode}} today' },
		]) {
			const result = await prepare(fields)
			expect(result.ok).toBe(false)
			if (!result.ok) expect(result.error).toMatch(/merge tags/)
		}
	})

	it('refuses a title or message over the limits, an insecure image and a link to another site', async () => {
		expect((await prepare({ subject: 'x'.repeat(66), content: 'ok' })).ok).toBe(
			false,
		)
		expect(
			(await prepare({ subject: 'ok', content: 'x'.repeat(179) })).ok,
		).toBe(false)
		expect(
			(
				await prepare({
					subject: 'ok',
					content: 'ok',
					pushImageUrl: 'http://cdn.example.com/a.jpg',
				})
			).ok,
		).toBe(false)
		const link = await prepare({
			subject: 'ok',
			content: 'ok',
			pushLink: 'https://evil.example.com',
		})
		expect(link.ok).toBe(false)
		if (!link.ok) expect(link.error).toMatch(/path on your site/)
		expect((await prepare({ subject: '', content: 'ok' })).ok).toBe(false)
	})
})

describe('submitting a push broadcast (#105)', () => {
	const fetchTenant = vi.fn()

	beforeEach(() => {
		fetchTenant
			.mockReset()
			.mockResolvedValue(Response.json({ success: true, campaignId: 'c1' }))
		vi.mocked(auditCampaign).mockReset().mockResolvedValue(undefined)
		vi.mocked(runSendChecks).mockReset().mockResolvedValue([])
	})

	const run = (fields: Record<string, string>) =>
		submitCampaign({
			request: new Request('http://localhost/x'),
			organizationId: 'org',
			userId: 'user',
			fetchTenant,
			makeTestFetchTenant: vi.fn(async () => fetchTenant),
			formData: form({
				subject: 'Fresh summer menu',
				content: 'Open the app.',
				pushLink: '/menu',
				...fields,
			}),
			baseUrl: 'http://localhost',
		})

	it('always targets everyone who opted in, whatever audience was posted, and sends the page and image', async () => {
		const result = await run({ intent: 'send', audience: 'verified' })
		expect(result).toMatchObject({ kind: 'saved', intent: 'send' })
		const body = JSON.parse(
			fetchTenant.mock.calls.at(-1)![1].body as string,
		) as Record<string, unknown>
		expect(body).toMatchObject({
			channel: 'push',
			audience: 'all',
			subject: 'Fresh summer menu',
			pushLink: '/menu',
		})
		expect(vi.mocked(runSendChecks).mock.calls[0]![0]).toMatchObject({
			audience: 'all',
		})
		expect(vi.mocked(runSendChecks).mock.calls[0]![0].message.channel).toBe(
			'push',
		)
	})

	it('asks for no Text marketing terms, and audits the channel only (no words)', async () => {
		await run({ intent: 'send' })
		const calls = vi.mocked(auditCampaign).mock.calls.map(([a]) => a)
		expect(calls.map((a) => a.kind)).toEqual(['created', 'sent'])
		expect(calls.every((a) => a.channel === 'push')).toBe(true)
		expect(JSON.stringify(calls)).not.toContain('Fresh summer menu')
	})

	it('refuses a test send: only email can be tested', async () => {
		const result = await run({ intent: 'test' })
		expect(result).toMatchObject({ kind: 'test', result: { ok: false } })
		expect(fetchTenant).not.toHaveBeenCalled()
	})

	it("shows the region's reason when push is not on for the restaurant", async () => {
		fetchTenant.mockResolvedValue(
			Response.json({ error: 'push_not_enabled' }, { status: 409 }),
		)
		const result = await run({ intent: 'send' })
		expect(result).toMatchObject({ kind: 'error' })
	})
})
