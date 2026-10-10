import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createReportDefinition,
	organizationTemplates,
	type TimeframePreset,
} from '@repo/reports'
import { mintOperatorAnalyticsToken } from '@repo/reports/token'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	shopOrders,
	voiceCalls,
} from '@repo/tenant-db'
import { findActiveOrganizationById } from '../lib/origin.ts'
import {
	analyticsRoutes,
	loadPhoneCallRecords,
	mapPhoneCalls,
	type PhoneCallReportRow,
} from './analytics.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
}))

const day = 86_400_000
const base = new Date('2026-03-01T12:00:00Z').getTime()

function row(overrides: Partial<PhoneCallReportRow> = {}): PhoneCallReportRow {
	return {
		startedAt: new Date(base),
		callerPhone: '+15550001111',
		channel: 'phone',
		purpose: 'ordering',
		outcome: 'resolved',
		transferResult: 'none',
		calledWhileOpen: true,
		durationSeconds: 30,
		linkSent: false,
		followUpStatus: 'resolved',
		rating: null,
		sentiment: null,
		...overrides,
	}
}

describe('mapPhoneCalls', () => {
	it('maps call rows to report fields with fallbacks', () => {
		const [record] = mapPhoneCalls([
			row({
				purpose: null,
				outcome: null,
				calledWhileOpen: null,
				callerPhone: null,
				durationSeconds: null,
			}),
		])
		expect(record).toEqual({
			startedAt: new Date(base),
			callerPhone: '',
			channel: 'phone',
			purpose: 'unknown',
			outcome: 'unknown',
			resolvedByAssistant: false,
			transferResult: 'none',
			calledWhileOpen: false,
			durationBucket: 'under_1',
			linkSent: false,
			repeatCaller: false,
			followUpStatus: 'resolved',
			rating: 'none',
			sentiment: 'unknown',
		})
	})

	it('buckets durations', () => {
		const buckets = mapPhoneCalls(
			[59, 60, 179, 180, 299, 300].map((durationSeconds, index) =>
				row({ durationSeconds, callerPhone: `+1555000000${index}` }),
			),
		).map((record) => record.durationBucket)
		expect(buckets).toEqual([
			'under_1',
			'1_to_3',
			'1_to_3',
			'3_to_5',
			'3_to_5',
			'over_5',
		])
	})

	it('counts calls handled without staff', () => {
		const records = mapPhoneCalls([
			row({ outcome: 'resolved' }),
			row({ outcome: 'link_sent' }),
			row({ outcome: 'resolved', transferResult: 'answered' }),
			row({ outcome: 'message_taken' }),
		])
		expect(records.map((record) => record.resolvedByAssistant)).toEqual([
			true,
			true,
			false,
			false,
		])
	})

	it('maps ratings and sentiment', () => {
		const records = mapPhoneCalls([
			row({ rating: 4, sentiment: 'negative', followUpStatus: 'open' }),
		])
		expect(records[0]).toMatchObject({
			rating: '4',
			sentiment: 'negative',
			followUpStatus: 'open',
		})
	})

	it('flags repeat callers within the previous 30 days', () => {
		const records = mapPhoneCalls([
			row({ startedAt: new Date(base + 10 * day) }),
			row({ startedAt: new Date(base) }),
			row({ startedAt: new Date(base + 45 * day) }),
			row({
				startedAt: new Date(base + 46 * day),
				callerPhone: '+15550002222',
			}),
		])
		expect(records.map((record) => record.repeatCaller)).toEqual([
			true,
			false,
			false,
			false,
		])
	})

	it('finds repeat callers in calls from before the report window', () => {
		const records = mapPhoneCalls(
			[
				row({ startedAt: new Date(base + 40 * day) }),
				row({ startedAt: new Date(base + 40 * day), callerPhone: '+1555' }),
			],
			[{ startedAt: new Date(base + 20 * day), callerPhone: '+15550001111' }],
		)
		expect(records).toHaveLength(2)
		expect(records.map((record) => record.repeatCaller)).toEqual([true, false])
	})
})

describe('loadPhoneCallRecords', () => {
	const orgId = 'clw9x0a12000008l00report01'
	const now = new Date('2026-03-20T12:00:00Z')
	let tempDir: string

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-report-'))
		process.env.TENANT_DB_DIR = tempDir
		await provisionTenantDb(orgId)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function definition(preset: TimeframePreset) {
		return createReportDefinition({
			subject: 'phone_calls',
			timeframe: { field: 'startedAt', preset },
			visualization: {
				chartStyle: 'single_number',
				measure: 'count',
				sortBy: 'none',
				hideCounts: false,
			},
			settings: { title: 'Calls', notes: '', timezone: 'user' },
		})
	}

	async function insertCalls(
		calls: Array<{ daysAgo: number; phone: string | null }>,
	) {
		const db = await getTenantDb(orgId)
		await db.insert(voiceCalls).values(
			calls.map(({ daysAgo, phone }, index) => ({
				channel: 'phone' as const,
				roomName: `room-${index}`,
				callerPhone: phone,
				startedAt: new Date(now.getTime() - daysAgo * day),
			})),
		)
		return db
	}

	it('reads only the window plus a 30 day repeat-caller lookback', async () => {
		const db = await insertCalls([
			{ daysAgo: 1, phone: '+15550000001' },
			{ daysAgo: 2, phone: '+15550000002' },
			{ daysAgo: 3, phone: '+15550000003' },
			// Before the window, inside the lookback: makes 0001 a repeat.
			{ daysAgo: 20, phone: '+15550000001' },
			// Older than the lookback: 0002 is not a repeat.
			{ daysAgo: 45, phone: '+15550000002' },
		])
		const { records, truncated } = await loadPhoneCallRecords(
			db,
			definition('last_7_days'),
			now,
		)
		expect(truncated).toBe(false)
		expect(
			records.map((record) => [record.callerPhone, record.repeatCaller]),
		).toEqual([
			['+15550000001', true],
			['+15550000002', false],
			['+15550000003', false],
		])
	})

	it('keeps the most recent calls when the cap is hit', async () => {
		const db = await insertCalls([
			{ daysAgo: 1, phone: '+15550000001' },
			{ daysAgo: 2, phone: '+15550000002' },
			// Dropped by the cap, but still an earlier call for 0002.
			{ daysAgo: 3, phone: '+15550000002' },
			{ daysAgo: 400, phone: null },
		])
		const { records, truncated } = await loadPhoneCallRecords(
			db,
			definition('all_time'),
			now,
			2,
		)
		expect(truncated).toBe(true)
		expect(
			records.map((record) => [record.callerPhone, record.repeatCaller]),
		).toEqual([
			['+15550000001', false],
			['+15550000002', true],
		])
	})

	it('serves phone call reports from the bounded loader', async () => {
		await insertCalls([
			{ daysAgo: 0, phone: '+15550000001' },
			{ daysAgo: 40, phone: '+15550000002' },
		])
		const internalCommandToken = 'analytics-internal-token-1234567890'
		const previousToken = process.env.INTERNAL_COMMAND_TOKEN
		process.env.INTERNAL_COMMAND_TOKEN = internalCommandToken
		process.env.DATA_REGION = 'us'
		vi.mocked(findActiveOrganizationById).mockResolvedValue({
			id: orgId,
			slug: 'report',
			name: 'Report',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		} as Awaited<ReturnType<typeof findActiveOrganizationById>>)
		vi.useFakeTimers({ now, toFake: ['Date'] })
		try {
			const { token } = await mintOperatorAnalyticsToken({
				internalCommandToken,
				userId: 'user_1',
				orgId,
				role: 'admin',
				subjects: ['phone_calls'],
			})
			const res = await analyticsRoutes.request('/query', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ definition: definition('last_30_days') }),
			})
			expect(res.status).toBe(200)
			const body = (await res.json()) as Record<string, unknown>
			expect(body).toMatchObject({ total: 1 })
			expect(body).not.toHaveProperty('sourceTruncated')
		} finally {
			vi.useRealTimers()
			process.env.INTERNAL_COMMAND_TOKEN = previousToken ?? ''
		}
	})
})

describe('POST /query', () => {
	const internalCommandToken = 'analytics-internal-token-1234567890'
	const previousToken = process.env.INTERNAL_COMMAND_TOKEN
	afterEach(() => {
		process.env.INTERNAL_COMMAND_TOKEN = previousToken
	})

	it('refuses phone call reports without the phone call permission', async () => {
		process.env.INTERNAL_COMMAND_TOKEN = internalCommandToken
		const definition = organizationTemplates().find(
			(template) => template.definition.subject === 'phone_calls',
		)!.definition
		const { token } = await mintOperatorAnalyticsToken({
			internalCommandToken,
			userId: 'user_1',
			orgId: 'org_1',
			role: 'admin',
		})
		const res = await analyticsRoutes.request('/query', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ definition }),
		})
		expect(res.status).toBe(403)
		expect(await res.json()).toMatchObject({ error: 'forbidden_subject' })
	})
})

describe('POST /query shop reports', () => {
	const internalCommandToken = 'analytics-internal-token-1234567890'
	const orgId = 'clw9x0a12000008l00report03'
	const now = new Date('2026-03-20T12:00:00Z')
	const previousToken = process.env.INTERNAL_COMMAND_TOKEN
	let tempDir: string

	beforeEach(async () => {
		process.env.INTERNAL_COMMAND_TOKEN = internalCommandToken
		process.env.DATA_REGION = 'us'
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-shop-report-'))
		process.env.TENANT_DB_DIR = tempDir
		await provisionTenantDb(orgId)
		vi.mocked(findActiveOrganizationById).mockResolvedValue({
			id: orgId,
			slug: 'shop',
			name: 'Shop',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		} as Awaited<ReturnType<typeof findActiveOrganizationById>>)
		vi.useFakeTimers({ now, toFake: ['Date'] })
	})

	afterEach(async () => {
		vi.useRealTimers()
		process.env.INTERNAL_COMMAND_TOKEN = previousToken ?? ''
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	async function queryTemplate(id: string) {
		const { definition } = organizationTemplates().find(
			(template) => template.id === id,
		)!
		const { token } = await mintOperatorAnalyticsToken({
			internalCommandToken,
			userId: 'user_1',
			orgId,
			role: 'operator',
		})
		const res = await analyticsRoutes.request('/query', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ definition }),
		})
		return {
			status: res.status,
			body: (await res.json()) as Record<string, unknown>,
		}
	}

	async function insertShopOrders() {
		const db = await getTenantDb(orgId)
		const order = (
			productName: string,
			amountCents: number,
			status: 'pending' | 'paid',
			daysAgo: number,
		): typeof shopOrders.$inferInsert => ({
			productName,
			amountCents,
			platformFeeCents: amountCents / 10,
			orgPayoutCents: amountCents - amountCents / 10,
			status,
			createdAt: new Date(now.getTime() - daysAgo * day),
		})
		await db.insert(shopOrders).values([
			order('Mug', 650, 'paid', 1),
			order('Hoodie', 2500, 'paid', 2),
			order('Mug', 650, 'pending', 3),
			// Paid, but outside the last 30 days.
			order('Hoodie', 2500, 'paid', 45),
		])
	}

	it('adds up paid shop sales as amounts', async () => {
		await insertShopOrders()
		const { status, body } = await queryTemplate('shop-sales')
		expect(status).toBe(200)
		expect(body).toMatchObject({
			total: 2,
			value: 31.5,
			valueInfo: {
				measure: 'sum',
				field: 'amount',
				label: 'Shop sales',
				type: 'currency',
				currency: 'USD',
			},
		})
	})

	it('lists shop order amounts as money', async () => {
		await insertShopOrders()
		const { status, body } = await queryTemplate('shop-order-list')
		expect(status).toBe(200)
		const rows = body.rows as Array<Record<string, string>>
		expect(rows.map((row) => [row.productName, row.amount])).toEqual([
			['Mug', '$6.50'],
			['Hoodie', '$25.00'],
			['Mug', '$6.50'],
			['Hoodie', '$25.00'],
		])
	})
})
