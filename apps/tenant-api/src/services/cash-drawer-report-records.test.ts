import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createReportDefinition } from '@repo/reports'
import {
	mintOperatorAnalyticsToken,
	SALES_STAFF_FIELD_PERMISSION,
} from '@repo/reports/token'
import {
	destroyTenantDb,
	getTenantDb,
	posCashMovements,
	posDevices,
	posOrders,
	posPayments,
	posShifts,
	provisionTenantDb,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { analyticsRoutes } from '../routes/analytics.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(async () => null),
}))

const ORG_ID = 'org_cash_rpt'
const SIGNING_SECRET = 'cash-report-signing-secret-123456'

describe('cash drawer variance & log reports (#380)', () => {
	let directory: string
	let previousAnalyticsToken: string | undefined

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cash-report-'))
		previousAnalyticsToken = process.env.OPERATOR_ANALYTICS_TOKEN
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('OPERATOR_ANALYTICS_TOKEN', SIGNING_SECRET)
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'internal-command-token-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.mocked(findActiveOrganizationById).mockResolvedValue({
			id: ORG_ID,
			slug: 'cash-rpt',
			name: 'Cash Rpt',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		} as Awaited<ReturnType<typeof findActiveOrganizationById>>)
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(
					typeof input === 'string' ? input : input.toString(),
				)
				if (url.pathname.endsWith('/resources/order-context')) {
					return Response.json({
						orgId: ORG_ID,
						dataRegion: 'us',
						menu: {
							organization: { id: ORG_ID, slug: 'cash-rpt', currency: 'USD' },
							locations: [
								{
									id: 'loc-1',
									name: 'Main Street',
									timezone: 'UTC',
									currency: 'USD',
									stationSettings: { cashVarianceFlagCents: 300 },
								},
								{
									id: 'loc-2',
									name: 'Riyadh Kiosk',
									timezone: 'Asia/Riyadh',
									currency: 'SAR',
									stationSettings: { cashVarianceFlagCents: 500 },
								},
							],
							menus: [],
							locationOverrides: {},
						},
						drop: null,
						onlinePayment: { enabled: false, processor: null },
					})
				}
				return new Response('not found', { status: 404 })
			}),
		)
		await provisionTenantDb(ORG_ID)
	})

	afterEach(async () => {
		if (previousAnalyticsToken !== undefined) {
			process.env.OPERATOR_ANALYTICS_TOKEN = previousAnalyticsToken
		} else {
			delete process.env.OPERATOR_ANALYTICS_TOKEN
		}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		await destroyTenantDb(ORG_ID)
		fs.rmSync(directory, { recursive: true, force: true })
	})

	async function seedData() {
		const db = await getTenantDb(ORG_ID)
		const now = Date.now()
		const dev1 = crypto.randomUUID()
		const dev2 = crypto.randomUUID()
		await db.insert(posDevices).values([
			{
				id: dev1,
				terminalCode: 'T1',
				label: 'Front',
				secretHash: 'h1',
				locationId: 'loc-1',
				pairedBy: 'op',
				createdAt: now,
			},
			{
				id: dev2,
				terminalCode: 'T2',
				label: 'Riyadh',
				secretHash: 'h2',
				locationId: 'loc-2',
				pairedBy: 'op',
				createdAt: now,
			},
		])

		const s1 = crypto.randomUUID()
		const s2 = crypto.randomUUID()
		const s3 = crypto.randomUUID()
		// s1: float 100.00 + pay_in 20.00 - drop 50.00 + cash payment 30.00 = expected 100.00, counted 95.00 -> -5.00 short (flagged > 3.00)
		await db.insert(posShifts).values([
			{
				id: s1,
				deviceId: dev1,
				businessDate: '2026-10-21',
				status: 'closed',
				revision: 2,
				openedAt: now - 3600_000,
				openedByStaffId: 'staff_lina',
				openedByStaffName: 'Lina M.',
				openingFloatCents: 10_000,
				closedAt: now - 1000_000,
				closedByStaffId: 'staff_lina',
				closedByStaffName: 'Lina M.',
				countedCashCents: 9_500,
				expectedCashCents: 10_000,
				createdAt: now - 3600_000,
				updatedAt: now - 1000_000,
			},
			// s2: remotely closed from #403 (#403 fields present, balanced 0.00)
			{
				id: s2,
				deviceId: dev1,
				businessDate: '2026-10-21',
				status: 'closed',
				revision: 2,
				openedAt: now - 7200_000,
				openedByStaffId: 'staff_omar',
				openedByStaffName: 'Omar A.',
				openingFloatCents: 5_000,
				closedAt: now - 4000_000,
				countedCashCents: 5_000,
				expectedCashCents: 5_000,
				closedRemotelyById: 'mgr_maya',
				closedRemotelyByName: 'Manager Maya',
				remoteCloseReason: 'Forgot to close drawer',
				createdAt: now - 7200_000,
				updatedAt: now - 4000_000,
			},
			// s3: SAR terminal at loc-2, +1.00 over (multi-currency must never sum with USD)
			{
				id: s3,
				deviceId: dev2,
				businessDate: '2026-10-21',
				status: 'closed',
				revision: 2,
				openedAt: now - 5000_000,
				openedByStaffId: 'staff_nora',
				openedByStaffName: 'Nora S.',
				openingFloatCents: 2_000,
				closedAt: now - 2000_000,
				countedCashCents: 2_100,
				expectedCashCents: 2_000,
				createdAt: now - 5000_000,
				updatedAt: now - 2000_000,
			},
		])

		await db.insert(posCashMovements).values([
			{
				id: crypto.randomUUID(),
				shiftId: s1,
				kind: 'pay_in',
				amountCents: 2_000,
				note: 'Change roll',
				at: now - 3000_000,
				staffId: 'staff_lina',
				staffName: 'Lina M.',
				createdAt: now - 3000_000,
			},
			{
				id: crypto.randomUUID(),
				shiftId: s1,
				kind: 'pay_out',
				amountCents: 1_000,
				note: 'Ice bags',
				at: now - 2500_000,
				staffId: 'staff_lina',
				staffName: 'Lina M.',
				createdAt: now - 2500_000,
			},
			{
				id: crypto.randomUUID(),
				shiftId: s1,
				kind: 'drop',
				amountCents: 5_000,
				note: 'Safe drop',
				at: now - 2000_000,
				staffId: 'staff_lina',
				staffName: 'Lina M.',
				createdAt: now - 2000_000,
			},
		])

		// 100.00 - 10.00 + 20.00 - 50.00 + 40.00 cash sale = 100.00 expected
		const orderId = crypto.randomUUID()
		await db.insert(posOrders).values({
			id: orderId,
			deviceId: dev1,
			number: 'T1-0001',
			businessDate: '2026-10-21',
			revision: 1,
			status: 'paid',
			orderType: 'dine_in',
			locationId: 'loc-1',
			currency: 'USD',
			subtotalCents: 4_000,
			taxCents: 0,
			totalCents: 4_000,
			lines: [],
			adjustments: [],
			rungUpAt: now - 1500_000,
		})
		await db.insert(posPayments).values({
			id: crypto.randomUUID(),
			orderId,
			deviceId: dev1,
			shiftId: s1,
			kind: 'payment',
			method: 'cash',
			amountCents: 4_000,
			tenderedCents: 4_000,
			paidAt: now - 1500_000,
			createdAt: now - 1500_000,
		})
	}

	async function runQuery(
		subjects: string[],
		definition: ReturnType<typeof createReportDefinition>,
		locationIds: string[] | null = null,
	) {
		const { token } = await mintOperatorAnalyticsToken({
			signingSecret: SIGNING_SECRET,
			userId: 'user_1',
			orgId: ORG_ID,
			role: 'operator',
			subjects: subjects as never,
			locationIds,
		})
		return analyticsRoutes.request('/query', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ definition }),
		})
	}

	it('reports -5.00 cashier variance, flags over-threshold, includes remotely closed shifts, and splits currencies', async () => {
		await seedData()
		const byCashierDef = createReportDefinition({
			subject: 'cash_drawer_shifts',
			timeframe: { field: 'closedAt', preset: 'last_7_days' },
			groupBy: ['cashierName'],
			timeBucket: 'day',
			columns: [],
			visualization: {
				chartStyle: 'bar',
				measure: 'sum',
				valueField: 'variance',
				sortBy: 'value_asc',
				hideCounts: false,
			},
			settings: { title: 'Cashier variance', notes: '', timezone: 'user' },
		})
		const res = await runQuery(
			['cash_drawer_shifts', SALES_STAFF_FIELD_PERMISSION],
			byCashierDef,
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			value?: number
			valueInfo?: { currencySplit?: boolean }
			segments: Array<{
				label: string
				value?: number | null
				currency?: string
			}>
		}
		expect(body.value).toBeUndefined()
		expect(body.valueInfo?.currencySplit).toBe(true)
		expect(body.segments).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					label: expect.stringContaining('Lina M.'),
					value: -5,
					currency: 'USD',
				}),
				expect.objectContaining({
					label: expect.stringContaining('Omar A.'),
					value: 0,
					currency: 'USD',
				}),
				expect.objectContaining({
					label: expect.stringContaining('Nora S.'),
					value: 1,
					currency: 'SAR',
				}),
			]),
		)

		const listDef = createReportDefinition({
			subject: 'cash_drawer_shifts',
			timeframe: { field: 'closedAt', preset: 'last_7_days' },
			groupBy: [],
			columns: [
				'terminal',
				'expectedCash',
				'countedCash',
				'variance',
				'varianceFlagged',
				'closedRemotely',
				'remoteCloserName',
				'remoteCloseReason',
			],
			visualization: {
				chartStyle: 'table',
				measure: 'count',
				sortBy: 'none',
				hideCounts: false,
			},
			settings: { title: 'Shift variance list', notes: '', timezone: 'user' },
		})
		const listRes = await runQuery(
			['cash_drawer_shifts', SALES_STAFF_FIELD_PERMISSION],
			listDef,
		)
		expect(listRes.status).toBe(200)
		const listBody = (await listRes.json()) as {
			rows: Array<Record<string, string>>
		}
		const flagged = listBody.rows.find((r) => r.variance === '-$5.00')
		expect(flagged).toMatchObject({
			expectedCash: '$100.00',
			countedCash: '$95.00',
			variance: '-$5.00',
			varianceFlagged: 'Yes',
			closedRemotely: 'No',
		})
		const remote = listBody.rows.find((r) => r.closedRemotely === 'Yes')
		expect(remote).toMatchObject({
			closedRemotely: 'Yes',
			remoteCloserName: 'Manager Maya',
			remoteCloseReason: 'Forgot to close drawer',
		})
	})

	it('lists pay-ins, pay-outs, and drops in cash_drawer_movements and blocks cashier fields without permission', async () => {
		await seedData()
		const logDef = createReportDefinition({
			subject: 'cash_drawer_movements',
			timeframe: { field: 'occurredAt', preset: 'last_7_days' },
			groupBy: [],
			columns: ['kind', 'amount', 'signedAmount', 'note'],
			visualization: {
				chartStyle: 'table',
				measure: 'count',
				sortBy: 'none',
				hideCounts: false,
			},
			settings: { title: 'Cash log', notes: '', timezone: 'user' },
		})
		// Member without SALES_STAFF_FIELD_PERMISSION can still run non-staff cash log.
		const okRes = await runQuery(['cash_drawer_movements'], logDef)
		expect(okRes.status).toBe(200)
		const logBody = (await okRes.json()) as {
			rows: Array<{
				kind: string
				amount: string
				signedAmount: string
				note: string
			}>
		}
		expect(logBody.rows).toHaveLength(3)
		expect(logBody.rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'Pay-in',
					amount: '$20.00',
					signedAmount: '$20.00',
					note: 'Change roll',
				}),
				expect.objectContaining({
					kind: 'Pay-out',
					amount: '$10.00',
					signedAmount: '-$10.00',
					note: 'Ice bags',
				}),
				expect.objectContaining({
					kind: 'Safe drop',
					amount: '$50.00',
					signedAmount: '-$50.00',
					note: 'Safe drop',
				}),
			]),
		)

		// Member without SALES_STAFF_FIELD_PERMISSION cannot query cashier-level rows.
		const deniedDef = createReportDefinition({
			subject: 'cash_drawer_shifts',
			timeframe: { field: 'closedAt', preset: 'last_7_days' },
			groupBy: ['cashierName'],
			timeBucket: 'day',
			columns: [],
			visualization: {
				chartStyle: 'bar',
				measure: 'sum',
				valueField: 'variance',
				sortBy: 'none',
				hideCounts: false,
			},
			settings: {
				title: 'Denied cashier variance',
				notes: '',
				timezone: 'user',
			},
		})
		const deniedRes = await runQuery(['cash_drawer_shifts'], deniedDef)
		expect(deniedRes.status).toBe(403)
	})
})
