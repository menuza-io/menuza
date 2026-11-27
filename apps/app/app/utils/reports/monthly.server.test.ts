import {
	db,
	eq,
	MonthlyResultsDelivery,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { type FigureId } from '@repo/reports'
import { reportFiguresResponseSchema } from '@repo/reports/figures-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	addOrganizationMember,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import {
	keptFor,
	partialMonthFor,
	planMonthlyFigures,
	runMonthlyResultsEmails,
} from './monthly.server.ts'
import {
	reportUnsubscribeUrl,
	setMonthlyResultsEmail,
} from './report-unsubscribe.server.ts'

/**
 * The monthly results email (#221): one per owner or admin per month, on the
 * 2nd from 08:00 in the reporting zone; totals only; the lines each person's
 * grants allow; the estimate labelled with the organization's own rate. The
 * region is a fake.
 */

const NOW = new Date('2027-02-02T15:00:00Z') // 09:00 in Chicago on the 2nd: January's results

async function setup(createdAt = new Date('2026-01-01T00:00:00Z')) {
	const { user, organization } = await setupTestOrgWithUser('admin')
	await db
		.update(Organization)
		.set({ hasProvisionedDb: true, dataRegion: 'us', createdAt })
		.where(eq(Organization.id, organization.id))
	await db.insert(OrganizationLocation).values({
		organizationId: organization.id,
		name: 'Main',
		slug: 'main',
		timezone: 'America/Chicago',
	} as never)
	return { user, organization }
}

const entry = (currency: string | null, value: number) => ({ currency, value })
const FIGURE_DATA: Record<
	string,
	{
		entries: ReturnType<typeof entry>[]
		previous: ReturnType<typeof entry>[]
		format: string
	}
> = {
	directSales: {
		format: 'currency',
		entries: [entry('SAR', 2000), entry('USD', 10_000)],
		previous: [entry('USD', 8_000)],
	},
	directOrders: {
		format: 'number',
		entries: [entry(null, 320)],
		previous: [entry(null, 300)],
	},
	onlineSales: {
		format: 'currency',
		entries: [entry('USD', 4_000), entry('SAR', 800)],
		previous: [],
	},
	newGuestOrders: {
		format: 'number',
		entries: [entry(null, 40)],
		previous: [],
	},
	returningGuestOrders: {
		format: 'number',
		entries: [entry(null, 280)],
		previous: [],
	},
}

function fakeRegion() {
	const calls: Array<Record<string, any>> = []
	const post = vi.fn(
		async (input: { path: string; body: Record<string, any> }) => {
			calls.push(input.body)
			return Response.json(
				reportFiguresResponseSchema.parse({
					groups: (
						input.body.groups as Array<{
							key: string
							grants: { subjects: string[] }
							figureIds: FigureId[]
						}>
					).map((group) => ({
						key: group.key,
						// The region leaves out what the grants do not cover.
						figures: group.figureIds
							.filter(
								(id) =>
									FIGURE_DATA[id] && group.grants.subjects.includes('sales'),
							)
							.map((id) => ({ id, ...FIGURE_DATA[id]! })),
					})),
				}),
			)
		},
	)
	return { post: post as never, calls }
}

afterEach(async () => {
	await db.delete(MonthlyResultsDelivery)
	// The job reads every provisioned organization: leave none for the next test.
	await db.update(Organization).set({ hasProvisionedDb: false })
})

describe('planning the lines (#221)', () => {
	it('hides a line without the grant and names at most two modules that are off', () => {
		const plan = planMonthlyFigures({
			grants: new Set(['sales', 'orders']),
			modulesOn: new Set(['marketing'] as const),
		})
		expect(plan.shown).toContain('directSales')
		expect(plan.shown).not.toContain('bookings')
		expect(plan.off).toHaveLength(2)
		const none = planMonthlyFigures({
			grants: new Set(),
			modulesOn: new Set([
				'marketing',
				'loyalty',
				'reservations',
				'phone_agent',
			] as const),
		})
		expect(none.shown).toEqual([])
		expect(none.off).toEqual([])
	})

	it('estimates what ordering direct kept from the rate, per currency', () => {
		expect(
			keptFor(
				[
					{
						id: 'onlineSales',
						format: 'currency',
						entries: [entry('USD', 4000), entry('SAR', 800)],
						previous: [],
					},
				],
				2000,
			),
		).toEqual([entry('USD', 800), entry('SAR', 160)])
		expect(keptFor([], 2500)).toBeNull()
	})

	it('says so when the organization began inside the month', () => {
		expect(
			partialMonthFor('2027-01', new Date('2027-01-17T12:00:00Z')),
		).toEqual({ since: '2027-01-17' })
		expect(
			partialMonthFor('2027-01', new Date('2026-06-01T00:00:00Z')),
		).toBeNull()
	})
})

describe('the monthly email job (#221)', () => {
	it('sends one email per owner per month, only on the 2nd from 08:00, with totals only', async () => {
		const { user, organization } = await setup()
		const region = fakeRegion()
		const sendMock = vi
			.fn()
			.mockResolvedValue({ status: 'success', data: { id: 'm' } })

		// The 1st, and the 2nd before 08:00 local: nothing.
		await runMonthlyResultsEmails({
			now: new Date('2027-02-01T15:00:00Z'),
			post: region.post,
			sendEmailImpl: sendMock as never,
		})
		await runMonthlyResultsEmails({
			now: new Date('2027-02-02T13:00:00Z'),
			post: region.post,
			sendEmailImpl: sendMock as never,
		})
		expect(sendMock).not.toHaveBeenCalled()

		const first = await runMonthlyResultsEmails({
			now: NOW,
			post: region.post,
			sendEmailImpl: sendMock as never,
		})
		expect(first.sent).toBe(1)
		const mail = sendMock.mock.calls[0]![0]
		expect(mail.to).toBe(user.email)
		expect(mail.subject).toContain('Monthly results')
		expect(mail.subject).toContain('January 2027')
		// Two currencies, side by side.
		expect(mail.text).toMatch(
			/Direct sales: .*SAR.*\$10,000\.00|Direct sales: .*\$10,000\.00.*SAR/,
		)
		// The estimate carries the default 25% rate and its label.
		expect(mail.text).toContain('Kept by ordering direct (Estimate · 25%)')
		expect(mail.text).toContain('$1,000.00')
		expect(mail.text).toContain(
			'is an estimate at a 25% delivery-app commission',
		)
		expect(mail.text).toContain('/resources/report-unsubscribe?token=')
		// Totals only: nobody's name, phone or address in it.
		const body = mail.html + mail.text
		expect(body).not.toContain(user.email)
		expect(body).not.toMatch(/\+\d{7,}/)
		// And the request to the region names no person either: grants and figure ids.
		const request = JSON.stringify(region.calls[0])
		expect(request).not.toContain(user.email)
		expect(request).not.toMatch(/userId|"email"|"name"/)

		// Running the hour again, and the next hour, never sends it twice.
		await runMonthlyResultsEmails({
			now: NOW,
			post: region.post,
			sendEmailImpl: sendMock as never,
		})
		await runMonthlyResultsEmails({
			now: new Date('2027-02-02T20:00:00Z'),
			post: region.post,
			sendEmailImpl: sendMock as never,
		})
		expect(sendMock).toHaveBeenCalledTimes(1)
		expect(region.post).toHaveBeenCalledTimes(1)
		const rows = await db
			.select()
			.from(MonthlyResultsDelivery)
			.where(eq(MonthlyResultsDelivery.organizationId, organization.id))
		expect(rows).toHaveLength(1)
		expect(rows[0]!.month).toBe('2027-01')
	})

	it("uses the organization's own commission rate", async () => {
		const { organization } = await setup()
		await db
			.update(Organization)
			.set({ deliveryCommissionBp: 1850 })
			.where(eq(Organization.id, organization.id))
		const sendMock = vi
			.fn()
			.mockResolvedValue({ status: 'success', data: { id: 'm' } })
		await runMonthlyResultsEmails({
			now: NOW,
			post: fakeRegion().post,
			sendEmailImpl: sendMock as never,
		})
		const mail = sendMock.mock.calls[0]![0]
		expect(mail.text).toContain('(Estimate · 18.5%)')
		expect(mail.text).toContain('$740.00')
		expect(mail.text).toContain('18.5% delivery-app commission')
	})

	it('lets each person switch it off, and ignores members who are not owners or admins', async () => {
		const { user, organization } = await setup()
		const other = await createTestUser()
		await addOrganizationMember(other.id, organization.id, 'org_role_admin')
		const viewer = await createTestUser()
		await addOrganizationMember(viewer.id, organization.id, 'org_role_member')
		await setMonthlyResultsEmail({
			userId: other.id,
			organizationId: organization.id,
			email: false,
		})
		const sendMock = vi
			.fn()
			.mockResolvedValue({ status: 'success', data: { id: 'm' } })
		await runMonthlyResultsEmails({
			now: NOW,
			post: fakeRegion().post,
			sendEmailImpl: sendMock as never,
		})
		expect(sendMock.mock.calls.map((c) => c[0].to)).toEqual([user.email])
		// The link in the email is the same switch.
		expect(
			new URL(
				reportUnsubscribeUrl({
					kind: 'monthly',
					organizationId: organization.id,
					userId: user.id,
				}),
			).pathname,
		).toBe('/resources/report-unsubscribe')
	})

	it('gives a member without a sales grant no money lines', async () => {
		const { organization } = await setup()
		// A fake region that, like the real one, leaves out what the grants do not cover.
		const noSales = vi.fn(async (input: { body: Record<string, any> }) =>
			Response.json(
				reportFiguresResponseSchema.parse({
					groups: (input.body.groups as Array<{ key: string }>).map((g) => ({
						key: g.key,
						figures: [],
					})),
				}),
			),
		)
		const sendMock = vi
			.fn()
			.mockResolvedValue({ status: 'success', data: { id: 'm' } })
		const result = await runMonthlyResultsEmails({
			now: NOW,
			post: noSales as never,
			sendEmailImpl: sendMock as never,
		})
		void organization
		// Nothing to show: the email is skipped rather than sent empty or with zeros.
		expect(sendMock).not.toHaveBeenCalled()
		expect(result.skipped).toBeGreaterThanOrEqual(1)
	})

	it('puts the first, partial month on the page and the email', async () => {
		await setup(new Date('2027-01-17T12:00:00Z'))
		const sendMock = vi
			.fn()
			.mockResolvedValue({ status: 'success', data: { id: 'm' } })
		await runMonthlyResultsEmails({
			now: NOW,
			post: fakeRegion().post,
			sendEmailImpl: sendMock as never,
		})
		expect(sendMock.mock.calls[0]![0].text).toContain(
			'Partial month: since 2027-01-17.',
		)
	})

	it('keeps the claim off a failed send so the next hour retries', async () => {
		await setup()
		const failing = vi.fn().mockRejectedValue(new Error('smtp down'))
		const first = await runMonthlyResultsEmails({
			now: NOW,
			post: fakeRegion().post,
			sendEmailImpl: failing as never,
		})
		expect(first.failed).toBe(1)
		const ok = vi
			.fn()
			.mockResolvedValue({ status: 'success', data: { id: 'm' } })
		const second = await runMonthlyResultsEmails({
			now: new Date('2027-02-02T16:00:00Z'),
			post: fakeRegion().post,
			sendEmailImpl: ok as never,
		})
		expect(second.sent).toBe(1)
	})
})
