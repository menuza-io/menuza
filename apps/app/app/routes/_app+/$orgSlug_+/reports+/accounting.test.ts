import {
	AccountingExport,
	AccountingSettings,
	ConfigFlag,
	db,
	eq,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { type AccountingDayFacts } from '@repo/reports'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	signAccountingLink,
	verifyAccountingLink,
	runWeeklyAccountingEmails,
} from '#app/utils/reports/accounting.server.ts'
import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader as exportLoader } from '../../../resources+/accounting-export.ts'
import { action, loader } from './accounting.tsx'

const regional = vi.hoisted(() => ({ days: [] as unknown[], status: 200 }))
vi.mock('#app/utils/reports/regional-reports.server.ts', () => ({
	postRegionalReports: vi.fn(async () =>
		Response.json({ days: regional.days }, { status: regional.status }),
	),
}))

function day(over: Partial<AccountingDayFacts> = {}): AccountingDayFacts {
	return {
		locationId: 'loc_main',
		locationName: 'Main St',
		businessDate: '2027-01-04',
		currency: 'USD',
		closed: true,
		categories: [{ key: 'mains', label: 'Mains', minor: 10_000 }],
		grossMinor: 10_000,
		serviceFeesMinor: 0,
		discountsMinor: 0,
		loyaltyMinor: 0,
		cashDiscountsMinor: 0,
		refundsNetMinor: 0,
		taxByRate: [{ rateBp: 1500, minor: 1500 }],
		tipsMinor: 0,
		giftCardsSoldMinor: 0,
		tenders: [
			{ tender: 'cash', minor: 4000 },
			{ tender: 'card_till', minor: 7500 },
		],
		processingFeesMinor: 0,
		payoutMinor: 0,
		...over,
	}
}

let flagIds: string[] = []
async function setup(flag = true) {
	const { user, organization, cookie } = await setupTestOrgWithUser('admin')
	await db
		.update(Organization)
		.set({ hasProvisionedDb: true, dataRegion: 'us' })
		.where(eq(Organization.id, organization.id))
	await db.insert(OrganizationLocation).values({
		organizationId: organization.id,
		name: 'Main',
		slug: 'main',
		timezone: 'America/Chicago',
	} as never)
	if (flag) {
		const [row] = await db
			.insert(ConfigFlag)
			.values({
				key: 'reports.accounting',
				value: true,
				level: 'organization',
				organizationId: organization.id,
			})
			.returning({ id: ConfigFlag.id })
		flagIds.push(row!.id)
	}
	regional.days = [day()]
	regional.status = 200
	return { user, organization, cookie }
}

afterEach(async () => {
	for (const id of flagIds)
		await db.delete(ConfigFlag).where(eq(ConfigFlag.id, id))
	flagIds = []
	await db.update(Organization).set({ hasProvisionedDb: false })
	await db.delete(AccountingSettings)
})

const call = (
	organizationSlug: string,
	cookie: string,
	body: Record<string, unknown>,
) =>
	action({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${organizationSlug}/reports/accounting`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			},
			cookie,
		),
		params: { orgSlug: organizationSlug },
		context: {},
	} as never)

describe('the Accounting page (#189)', () => {
	it('does not exist while the flag is off', async () => {
		const { organization, cookie } = await setup(false)
		await expect(
			loader({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${organization.slug}/reports/accounting`,
					{},
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as never),
		).rejects.toMatchObject({ status: 404 })
	})

	it('exports the day once, records it, and a later export of a changed day is an adjusting entry', async () => {
		const { organization, cookie } = await setup()
		const range = { from: '2027-01-04', to: '2027-01-04', layout: 'generic' }
		const first = (await (
			await call(organization.slug, cookie, { intent: 'export', ...range })
		).data) as {
			ok: boolean
			csv: string
			entries: number
			adjustments: number
		}
		expect(first).toMatchObject({ ok: true, entries: 1, adjustments: 0 })
		expect(first.csv.split('\n')[0]).toBe(
			'Date,Location,Reference,Status,Account code,Account name,Debit,Credit,Currency,Memo',
		)
		expect(first.csv).toContain('Sales: Mains')
		const rows = await db
			.select()
			.from(AccountingExport)
			.where(eq(AccountingExport.organizationId, organization.id))
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			sequence: 1,
			status: 'final',
			locationId: 'loc_main',
		})

		// Same data again: nothing to export.
		const quiet = (await (
			await call(organization.slug, cookie, { intent: 'export', ...range })
		).data) as unknown as { entries: number; unchanged: number }
		expect(quiet).toMatchObject({ entries: 0, unchanged: 1 })

		// A late refund changes the day: the export is an adjusting entry.
		regional.days = [
			day({
				refundsNetMinor: -1000,
				taxByRate: [{ rateBp: 1500, minor: 1350 }],
				tenders: [
					{ tender: 'cash', minor: 4000 - 1150 },
					{ tender: 'card_till', minor: 7500 },
				],
			}),
		]
		const adjusted = (await (
			await call(organization.slug, cookie, { intent: 'export', ...range })
		).data) as unknown as { entries: number; adjustments: number; csv: string }
		expect(adjusted).toMatchObject({ entries: 1, adjustments: 1 })
		expect(adjusted.csv).toContain('-ADJ1')
		expect(adjusted.csv).toContain('Refunds')
	})

	it('saves the account mapping once and uses it in the file', async () => {
		const { organization, cookie } = await setup()
		await call(organization.slug, cookie, {
			intent: 'save-mapping',
			rows: [
				{
					lineKey: 'sales:mains',
					accountCode: '4000',
					accountName: 'Food sales',
				},
			],
		})
		const result = (await (
			await call(organization.slug, cookie, {
				intent: 'export',
				from: '2027-01-04',
				to: '2027-01-04',
				layout: 'quickbooks',
			})
		).data) as unknown as { csv: string }
		expect(result.csv).toContain('Food sales')
	})

	it('refuses an invalid range, a bad layout and a bookkeeper address that is not an email', async () => {
		const { organization, cookie } = await setup()
		const bad = (await call(organization.slug, cookie, {
			intent: 'export',
			from: '2027-01-04',
			to: '2026-01-01',
			layout: 'generic',
		})) as { init?: { status: number } }
		expect(bad.init?.status).toBe(400)
		const layout = (await call(organization.slug, cookie, {
			intent: 'export',
			from: '2027-01-04',
			to: '2027-01-04',
			layout: 'excel',
		})) as { init?: { status: number } }
		expect(layout.init?.status).toBe(400)
		const email = (await call(organization.slug, cookie, {
			intent: 'save-settings',
			layout: 'xero',
			bookkeeperEmail: 'nope',
			weeklyEmail: true,
		})) as { init?: { status: number } }
		expect(email.init?.status).toBe(400)
	})
})

describe('the weekly bookkeeper email and file link (#189)', () => {
	const MONDAY = new Date('2027-01-11T14:00:00Z') // 08:00 in Chicago

	async function weeklyOrg() {
		const { organization } = await setup()
		await db.insert(AccountingSettings).values({
			organizationId: organization.id,
			layout: 'xero',
			bookkeeperEmail: 'books@example.com',
			weeklyEmail: true,
		})
		return organization
	}
	const post = vi.fn(async () => Response.json({ days: [day()] }))

	it("sends last week's journal once on Monday with a signed link to the file", async () => {
		const organization = await weeklyOrg()
		const send = vi
			.fn()
			.mockResolvedValue({ status: 'success', data: { id: 'm' } })
		const deps = {
			now: MONDAY,
			post: post as never,
			sendEmailImpl: send as never,
			providerDays: async () => [],
		}
		expect(
			(
				await runWeeklyAccountingEmails({
					...deps,
					now: new Date('2027-01-12T14:00:00Z'),
				})
			).sent,
		).toBe(0) // Tuesday
		expect(
			(
				await runWeeklyAccountingEmails({
					...deps,
					now: new Date('2027-01-11T12:00:00Z'),
				})
			).sent,
		).toBe(0) // 06:00
		const result = await runWeeklyAccountingEmails(deps)
		expect(result.sent).toBe(1)
		const mail = send.mock.calls[0]![0]
		expect(mail.to).toBe('books@example.com')
		expect(mail.subject).toContain('Weekly sales journal')
		expect(mail.text).toContain('2027-01-04')
		expect(mail.text).toContain('Final')
		const link = /\/resources\/accounting-export\?token=([^\s"]+)/.exec(
			mail.text,
		)![1]!
		const parsed = verifyAccountingLink(decodeURIComponent(link))
		expect(parsed).toMatchObject({
			organizationId: organization.id,
			from: '2027-01-04',
			to: '2027-01-10',
			layout: 'xero',
		})
		// Never twice in the same week.
		await runWeeklyAccountingEmails(deps)
		expect(send).toHaveBeenCalledTimes(1)
	})

	it('stays off without the flag or a bookkeeper address', async () => {
		const organization = await weeklyOrg()
		const send = vi
			.fn()
			.mockResolvedValue({ status: 'success', data: { id: 'm' } })
		await db
			.delete(ConfigFlag)
			.where(eq(ConfigFlag.organizationId, organization.id))
		flagIds = []
		await runWeeklyAccountingEmails({
			now: MONDAY,
			post: post as never,
			sendEmailImpl: send as never,
			providerDays: async () => [],
		})
		expect(send).not.toHaveBeenCalled()
	})

	it('signs a link that lapses after 7 days and refuses forgeries', () => {
		const link = {
			organizationId: 'org_1',
			from: '2027-01-04',
			to: '2027-01-10',
			layout: 'generic' as const,
		}
		const token = signAccountingLink(link, 1_000)
		expect(verifyAccountingLink(token, 2_000)).toEqual(link)
		expect(verifyAccountingLink(token, 1_000 + 8 * 86_400_000)).toBeNull()
		const [payload, mac] = token.split('.')
		const forged = Buffer.from(
			JSON.stringify({ ...link, organizationId: 'org_2', exp: 9e15 }),
		).toString('base64url')
		for (const bad of [
			`${forged}.${mac}`,
			`${payload}.AAAA`,
			'x',
			'',
			`${token}.x`,
		]) {
			expect(verifyAccountingLink(bad, 2_000)).toBeNull()
		}
	})

	it('serves the bookkeeper file without a login, and 404s a forged or flag-off link', async () => {
		const organization = await weeklyOrg()
		const token = signAccountingLink({
			organizationId: organization.id,
			from: '2027-01-04',
			to: '2027-01-10',
			layout: 'generic',
		})
		const ok = await exportLoader({
			request: new Request(
				`http://localhost/resources/accounting-export?token=${encodeURIComponent(token)}`,
			),
			params: {},
			context: {},
		} as never)
		expect(ok.status).toBe(200)
		expect(ok.headers.get('content-type')).toContain('text/csv')
		expect(await ok.text()).toContain('Sales: Mains')
		const forged = await exportLoader({
			request: new Request(
				`http://localhost/resources/accounting-export?token=${encodeURIComponent(`${token}x`)}`,
			),
			params: {},
			context: {},
		} as never)
		expect(forged.status).toBe(404)
		await db
			.delete(ConfigFlag)
			.where(eq(ConfigFlag.organizationId, organization.id))
		flagIds = []
		const off = await exportLoader({
			request: new Request(
				`http://localhost/resources/accounting-export?token=${encodeURIComponent(token)}`,
			),
			params: {},
			context: {},
		} as never)
		expect(off.status).toBe(404)
	})
})
