import {
	db,
	eq,
	MarketingSmsSend,
	MarketingSmsUsage,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import {
	checkSmsSend,
	getSmsAllowance,
	grantExtraSmsSends,
	releaseSmsSend,
	reserveSmsSend,
	smsUsageByLocation,
	startSmsSend,
} from '@repo/marketing/server/sms-allowance'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'

/**
 * #247: the monthly marketing text allowance. Numbers only; a send is spent by
 * one conditional statement, so two racing for the last slot cannot both win.
 */

const NOV = Date.UTC(2026, 10, 15, 12)
const DEC = Date.UTC(2026, 11, 15, 12)
let userId: string

beforeAll(async () => {
	userId = (await createTestUser()).id
})

async function org(planName: string | null = 'starter') {
	const organization = await createTestOrganization(userId)
	await db
		.update(Organization)
		.set({ planName })
		.where(eq(Organization.id, organization.id))
	return organization.id
}

let counter = 0
const campaign = () => `campaign_${Date.now()}_${counter++}`

describe('marketing text allowance (#247)', () => {
	it("starts with the plan's sends and counts down as broadcasts are sent or scheduled", async () => {
		const organizationId = await org('starter')
		expect(await getSmsAllowance(organizationId, NOV)).toMatchObject({
			limit: 4,
			used: 0,
			remaining: 4,
			periodKey: '2026-11',
			resetsAt: Date.UTC(2026, 11, 1),
		})
		await reserveSmsSend({
			organizationId,
			campaignId: campaign(),
			startsAtMs: NOV,
		})
		await reserveSmsSend({
			organizationId,
			campaignId: campaign(),
			startsAtMs: NOV,
		})
		expect(await getSmsAllowance(organizationId, NOV)).toMatchObject({
			used: 2,
			remaining: 2,
		})
	})

	it('reserving the same broadcast twice spends one send', async () => {
		const organizationId = await org()
		const campaignId = campaign()
		const first = await reserveSmsSend({
			organizationId,
			campaignId,
			startsAtMs: NOV,
		})
		const again = await reserveSmsSend({
			organizationId,
			campaignId,
			startsAtMs: NOV,
		})
		expect(first).toMatchObject({ ok: true, alreadyHeld: false })
		expect(again).toMatchObject({ ok: true, alreadyHeld: true })
		expect((await getSmsAllowance(organizationId, NOV)).used).toBe(1)
	})

	it('a send over the allowance cannot start this month, but can be held for next month', async () => {
		const organizationId = await org('starter')
		for (let i = 0; i < 4; i++) {
			expect(
				(
					await reserveSmsSend({
						organizationId,
						campaignId: campaign(),
						startsAtMs: NOV,
					})
				).ok,
			).toBe(true)
		}
		const refused = await reserveSmsSend({
			organizationId,
			campaignId: campaign(),
			startsAtMs: NOV,
		})
		expect(refused).toMatchObject({ ok: false, reason: 'exhausted' })
		if (!refused.ok) {
			expect(refused.allowance.remaining).toBe(0)
			expect(refused.allowance.resetsAt).toBe(Date.UTC(2026, 11, 1))
		}
		expect((await checkSmsSend({ organizationId, startsAtMs: NOV })).ok).toBe(
			false,
		)
		// Written and scheduled for next month: that month's allowance is whole.
		expect((await checkSmsSend({ organizationId, startsAtMs: DEC })).ok).toBe(
			true,
		)
		expect(
			await reserveSmsSend({
				organizationId,
				campaignId: campaign(),
				startsAtMs: DEC,
			}),
		).toMatchObject({ ok: true, periodKey: '2026-12' })
		expect((await getSmsAllowance(organizationId, NOV)).used).toBe(4)
		expect((await getSmsAllowance(organizationId, DEC)).used).toBe(1)
	})

	it('two sends racing for the last slot: exactly one wins', async () => {
		const organizationId = await org('starter')
		for (let i = 0; i < 3; i++) {
			await reserveSmsSend({
				organizationId,
				campaignId: campaign(),
				startsAtMs: NOV,
			})
		}
		const results = await Promise.all(
			Array.from({ length: 6 }, () =>
				reserveSmsSend({
					organizationId,
					campaignId: campaign(),
					startsAtMs: NOV,
				}),
			),
		)
		expect(results.filter((result) => result.ok)).toHaveLength(1)
		expect(results.filter((result) => !result.ok)).toHaveLength(5)
		const usage = await getSmsAllowance(organizationId, NOV)
		expect(usage).toMatchObject({ used: 4, remaining: 0 })
		// The losers hold nothing: no stray reservation is left counting.
		const held = (
			await db
				.select()
				.from(MarketingSmsSend)
				.where(eq(MarketingSmsSend.organizationId, organizationId))
		).filter((row) => row.state === 'reserved')
		expect(held).toHaveLength(4)
	})

	it('cancelling before it starts gives the send back, once', async () => {
		const organizationId = await org('starter')
		const campaignId = campaign()
		await reserveSmsSend({ organizationId, campaignId, startsAtMs: NOV })
		expect((await getSmsAllowance(organizationId, NOV)).used).toBe(1)
		expect(await releaseSmsSend({ organizationId, campaignId })).toBe(true)
		expect(await releaseSmsSend({ organizationId, campaignId })).toBe(false)
		expect((await getSmsAllowance(organizationId, NOV)).used).toBe(0)
		// It can hold a send again afterwards.
		expect(
			(await reserveSmsSend({ organizationId, campaignId, startsAtMs: NOV }))
				.ok,
		).toBe(true)
		expect((await getSmsAllowance(organizationId, NOV)).used).toBe(1)
	})

	it('rescheduling into another month moves the send to that month', async () => {
		const organizationId = await org('starter')
		const campaignId = campaign()
		await reserveSmsSend({ organizationId, campaignId, startsAtMs: NOV })
		await reserveSmsSend({ organizationId, campaignId, startsAtMs: DEC })
		expect((await getSmsAllowance(organizationId, NOV)).used).toBe(0)
		expect((await getSmsAllowance(organizationId, DEC)).used).toBe(1)
	})

	it('a started send is held by the region and a refused one is put off to the reset', async () => {
		const organizationId = await org('starter')
		const campaignId = campaign()
		await reserveSmsSend({ organizationId, campaignId, startsAtMs: NOV })
		expect(
			await startSmsSend({ organizationId, campaignId, now: NOV }),
		).toEqual({ ok: true })
		expect(
			(
				await db
					.select()
					.from(MarketingSmsSend)
					.where(eq(MarketingSmsSend.campaignId, campaignId))
			)[0]?.state,
		).toBe('started')
		// Starting twice (a resumed dispatch) still costs one.
		await startSmsSend({ organizationId, campaignId, now: NOV })
		expect((await getSmsAllowance(organizationId, NOV)).used).toBe(1)

		for (let i = 0; i < 3; i++) {
			await reserveSmsSend({
				organizationId,
				campaignId: campaign(),
				startsAtMs: NOV,
			})
		}
		const refused = await startSmsSend({
			organizationId,
			campaignId: campaign(),
			now: NOV,
		})
		expect(refused).toEqual({
			ok: false,
			reason: 'exhausted',
			resetsAt: Date.UTC(2026, 11, 1),
		})
	})

	it('a new month starts again from the whole allowance (rollover)', async () => {
		const organizationId = await org('starter')
		for (let i = 0; i < 4; i++) {
			await reserveSmsSend({
				organizationId,
				campaignId: campaign(),
				startsAtMs: NOV,
			})
		}
		expect((await getSmsAllowance(organizationId, NOV)).remaining).toBe(0)
		expect(
			await getSmsAllowance(organizationId, Date.UTC(2026, 11, 1)),
		).toMatchObject({
			periodKey: '2026-12',
			used: 0,
			remaining: 4,
		})
	})

	it('Admin can grant extra sends, which add to the month', async () => {
		const organizationId = await org('starter')
		for (let i = 0; i < 4; i++) {
			await reserveSmsSend({
				organizationId,
				campaignId: campaign(),
				startsAtMs: NOV,
			})
		}
		expect(
			(
				await reserveSmsSend({
					organizationId,
					campaignId: campaign(),
					startsAtMs: NOV,
				})
			).ok,
		).toBe(false)
		expect(
			await grantExtraSmsSends({ organizationId, extra: 2, atMs: NOV }),
		).toMatchObject({
			limit: 6,
			extra: 2,
			remaining: 2,
		})
		await grantExtraSmsSends({ organizationId, extra: 1, atMs: NOV })
		expect((await getSmsAllowance(organizationId, NOV)).limit).toBe(7)
		expect(
			(
				await reserveSmsSend({
					organizationId,
					campaignId: campaign(),
					startsAtMs: NOV,
				})
			).ok,
		).toBe(true)
		// A grant is for its own month only.
		expect((await getSmsAllowance(organizationId, DEC)).extra).toBe(0)
	})

	it("Billing shows each location's usage this month", async () => {
		const organizationId = await org('growth')
		await db.insert(OrganizationLocation).values([
			{ organizationId, name: 'Downtown', slug: 'downtown' },
			{ organizationId, name: 'Airport', slug: 'airport' },
		])
		await reserveSmsSend({
			organizationId,
			campaignId: campaign(),
			startsAtMs: NOV,
		})
		await reserveSmsSend({
			organizationId,
			campaignId: campaign(),
			startsAtMs: NOV,
		})
		const { allowance, locations } = await smsUsageByLocation(
			organizationId,
			NOV,
		)
		expect(allowance.limit).toBe(12)
		expect(locations.map((l) => [l.name, l.used, l.limit]).sort()).toEqual([
			['Airport', 2, 12],
			['Downtown', 2, 12],
		])
	})

	it('holds only numbers: the counters and holds carry no guest, no message and no number', async () => {
		const organizationId = await org('starter')
		await reserveSmsSend({
			organizationId,
			campaignId: campaign(),
			startsAtMs: NOV,
		})
		const usage = await db
			.select()
			.from(MarketingSmsUsage)
			.where(eq(MarketingSmsUsage.organizationId, organizationId))
		expect(Object.keys(usage[0]!).sort()).toEqual([
			'extraSends',
			'organizationId',
			'periodKey',
			'sends',
			'updatedAt',
		])
	})
})
