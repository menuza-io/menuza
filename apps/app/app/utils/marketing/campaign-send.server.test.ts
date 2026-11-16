import { i18n } from '@lingui/core'
import {
	getDefaultEmailBlock,
	type EmailBlock,
} from '@repo/common/email-blocks'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDiscount } from '#app/utils/discounts/discounts.server.ts'
import { type PreparedCampaignMessage } from './campaign-message.server.ts'
import {
	campaignActionError,
	countAudience,
	couponStateFromDiscount,
	mayProceed,
	readCampaignIntent,
	readCampaignSchedule,
	runSendChecks,
} from './campaign-send.server.ts'

vi.mock('#app/utils/discounts/discounts.server.ts', () => ({
	getDiscount: vi.fn(),
}))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-15T12:00:00Z')

function form(fields: Record<string, string>) {
	const data = new FormData()
	for (const [key, value] of Object.entries(fields)) data.set(key, value)
	return data
}

describe('readCampaignSchedule', () => {
	it('reads a future time and the late window in hours', () => {
		const result = readCampaignSchedule(
			form({
				scheduledAt: new Date(NOW + 2 * HOUR).toISOString(),
				lateAfterHours: '6',
			}),
			NOW,
		)
		expect(result).toEqual({
			ok: true,
			schedule: {
				scheduledAt: new Date(NOW + 2 * HOUR),
				lateAfterMinutes: 360,
			},
		})
	})

	it('means "now" with no time, and defaults the window to 4 hours', () => {
		expect(readCampaignSchedule(form({}), NOW)).toEqual({
			ok: true,
			schedule: { scheduledAt: null, lateAfterMinutes: 240 },
		})
	})

	it('keeps the window between 1 and 72 hours', () => {
		const minutes = (hours: string) => {
			const result = readCampaignSchedule(form({ lateAfterHours: hours }), NOW)
			return result.ok ? result.schedule.lateAfterMinutes : null
		}
		expect(minutes('0.1')).toBe(60)
		expect(minutes('500')).toBe(4320)
		expect(minutes('abc')).toBe(240)
	})

	it('refuses a time in the past and one that is not a time', () => {
		expect(
			readCampaignSchedule(
				form({ scheduledAt: new Date(NOW - 1000).toISOString() }),
				NOW,
			).ok,
		).toBe(false)
		expect(
			readCampaignSchedule(form({ scheduledAt: 'tomorrow-ish' }), NOW).ok,
		).toBe(false)
	})
})

describe('couponStateFromDiscount', () => {
	const sendAt = Date.parse('2026-11-20T18:00:00Z')

	it('is ok for an active discount with no end or an end after the send', () => {
		expect(
			couponStateFromDiscount({ status: 'active', endsAt: null }, sendAt),
		).toBe('ok')
		expect(
			couponStateFromDiscount(
				{ status: 'active', endsAt: '2026-11-30T00:00' },
				sendAt,
			),
		).toBe('ok')
	})

	it('is paused when it is paused, archived or gone', () => {
		for (const status of ['paused', 'archived']) {
			expect(couponStateFromDiscount({ status, endsAt: null }, sendAt)).toBe(
				'paused',
			)
		}
		expect(couponStateFromDiscount(null, sendAt)).toBe('paused')
	})

	it('calls an end passed everywhere before the send "ended", and not one still running somewhere', () => {
		// Ended at 2026-11-20T00:00 local: over everywhere by 12:00 UTC the same day.
		expect(
			couponStateFromDiscount(
				{ status: 'active', endsAt: '2026-11-20T00:00' },
				sendAt,
			),
		).toBe('ended_before_send')
		// Ends at 2026-11-20T10:00 local: still running at UTC-12 when it is 18:00 UTC.
		expect(
			couponStateFromDiscount(
				{ status: 'active', endsAt: '2026-11-20T10:00' },
				sendAt,
			),
		).toBe('ok')
	})
})

describe('mayProceed', () => {
	it('never proceeds past a blocking problem, however it is acknowledged', () => {
		const blocking = [{ code: 'audience_zero', severity: 'blocking' }] as const
		expect(mayProceed(blocking, true)).toBe(false)
		expect(mayProceed(blocking, false)).toBe(false)
	})

	it('proceeds past a warning only once the operator chose Send anyway', () => {
		const warning = [
			{ code: 'starter_text', severity: 'warning', blockId: 'b' },
		] as const
		expect(mayProceed(warning, false)).toBe(false)
		expect(mayProceed(warning, true)).toBe(true)
		expect(mayProceed([], false)).toBe(true)
	})
})

describe('runSendChecks', () => {
	beforeEach(() => vi.mocked(getDiscount).mockReset())

	const message = (
		over: Partial<PreparedCampaignMessage> = {},
		blocks: EmailBlock[] = [],
	): PreparedCampaignMessage => ({
		channel: 'email',
		subject: 'Lunch',
		content: 'Come eat',
		contentHtml: '<p>Come eat</p>',
		contentBlocks: JSON.stringify(blocks),
		blocks,
		discountOffer: null,
		...over,
	})
	const tenant = (count: number | 'fail') =>
		vi.fn(async () =>
			count === 'fail'
				? new Response('{}', { status: 500 })
				: Response.json({ count }),
		)

	it('asks the region only for a count', async () => {
		const fetchTenant = tenant(42)
		await runSendChecks({
			organizationId: 'org',
			message: message(),
			audience: 'verified',
			sendAtMs: NOW,
			fetchTenant,
		})
		expect(fetchTenant).toHaveBeenCalledWith(
			'/operator/marketing/audience-count?channel=email&audience=verified',
		)
	})

	it('reports an audience of zero, unedited starter text and an empty coupon block', async () => {
		const starter = getDefaultEmailBlock('body')
		const coupon = getDefaultEmailBlock('coupon')
		const problems = await runSendChecks({
			organizationId: 'org',
			message: message({}, [starter, coupon]),
			audience: 'all',
			sendAtMs: NOW,
			fetchTenant: tenant(0),
		})
		expect(problems.map((p) => [p.code, p.severity, p.blockId])).toEqual([
			['empty_coupon', 'blocking', coupon.id],
			['audience_zero', 'blocking', undefined],
			['starter_text', 'warning', starter.id],
		])
	})

	it('does not block on a count it could not read', async () => {
		const problems = await runSendChecks({
			organizationId: 'org',
			message: message(),
			audience: 'all',
			sendAtMs: NOW,
			fetchTenant: tenant('fail'),
		})
		expect(problems).toEqual([])
	})

	it('blocks a coupon that is paused or ends before the send', async () => {
		const offer = { mode: 'shared', discountId: 'd1', code: 'SAVE10' } as const
		const withOffer = message({
			discountOffer: offer,
			content: 'Code {{couponCode}}',
		})
		vi.mocked(getDiscount).mockResolvedValueOnce({
			row: { status: 'paused' },
			stored: { definition: { endsAt: null } },
		} as never)
		expect(
			(
				await runSendChecks({
					organizationId: 'org',
					message: withOffer,
					audience: 'all',
					sendAtMs: NOW,
					fetchTenant: tenant(5),
				})
			).map((p) => p.code),
		).toEqual(['coupon_paused'])

		vi.mocked(getDiscount).mockResolvedValueOnce({
			row: { status: 'active' },
			stored: { definition: { endsAt: '2026-11-15T00:00' } },
		} as never)
		expect(
			(
				await runSendChecks({
					organizationId: 'org',
					message: withOffer,
					audience: 'all',
					sendAtMs: NOW + 48 * HOUR,
					fetchTenant: tenant(5),
				})
			).map((p) => p.code),
		).toEqual(['coupon_ended_before_send'])
	})

	it('blocks a coupon tag when no coupon is attached', async () => {
		const problems = await runSendChecks({
			organizationId: 'org',
			message: message({ content: 'Code {{couponCode}}' }),
			audience: 'all',
			sendAtMs: NOW,
			fetchTenant: tenant(5),
		})
		expect(problems.map((p) => p.code)).toEqual(['coupon_missing'])
	})
})

describe('countAudience, intents and messages', () => {
	it('passes a re-send link and survives a network failure', async () => {
		const fetchTenant = vi.fn(async (_path: string) =>
			Response.json({ count: 3 }),
		)
		expect(
			await countAudience(fetchTenant, {
				channel: 'email',
				audience: 'all',
				retargetOf: 'c1',
			}),
		).toBe(3)
		expect(fetchTenant.mock.calls[0]![0]).toContain('retargetOf=c1')
		expect(
			await countAudience(
				vi.fn(async () => {
					throw new Error('network')
				}),
				{ channel: 'email', audience: 'all' },
			),
		).toBeNull()
	})

	it('knows the four intents and refuses anything else', () => {
		for (const intent of ['send', 'schedule', 'draft', 'test']) {
			expect(readCampaignIntent(intent)).toBe(intent)
		}
		expect(readCampaignIntent('delete')).toBeNull()
		expect(readCampaignIntent(null)).toBeNull()
	})

	it('says why an action was refused, in plain words', () => {
		expect(campaignActionError('campaign_already_sending')).toMatch(
			/already sending/i,
		)
		expect(campaignActionError('retarget_too_early')).toMatch(/48 hours/)
		expect(campaignActionError('test_send_limit')).toMatch(/10 tests an hour/)
		expect(campaignActionError('whatever')).toMatch(/went wrong/i)
	})
})
