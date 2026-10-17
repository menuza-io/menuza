import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createReportDefinition, organizationCatalog } from '@repo/reports'
import {
	mintOperatorAnalyticsToken,
	RESTRICTED_REPORT_SUBJECTS,
	type RestrictedReportSubject,
} from '@repo/reports/token'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvAuditLog,
	rsvGuests,
	rsvLocationSettings,
	rsvPayments,
	rsvReservations,
	rsvServices,
	rsvWaitlistEntries,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../lib/reservations-context.ts'
import { analyticsRoutes } from './analytics.ts'
import { publicContext } from './reservations-public-fixture.ts'

const INTERNAL = 'test-reservations-analytics-internal-token-32chars!!'
const ORG = 'org_rsv_analytics'
const LOC = 'loc_a'
const LOC_B = 'loc_b'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

const app = new Hono()
app.route('/analytics', analyticsRoutes)

const RANGE = {
	preset: 'custom' as const,
	start: '2031-03-09T00:00:00.000Z',
	end: '2031-03-12T00:00:00.000Z',
}

function definition(subject: string, field: string, columns: string[] = []) {
	return createReportDefinition({
		subject,
		timeframe: { field, ...RANGE },
		columns,
		visualization: {
			chartStyle: columns.length > 0 ? 'table' : 'single_number',
			measure: 'count',
			sortBy: 'none',
			hideCounts: false,
		},
		settings: { title: 'Test', notes: '', timezone: 'UTC' },
	})
}

async function query(
	def: ReturnType<typeof definition>,
	options: {
		subjects?: readonly RestrictedReportSubject[]
		scopeIds?: readonly string[] | null
	} = {},
) {
	const { token } = await mintOperatorAnalyticsToken({
		internalCommandToken: INTERNAL,
		userId: 'usr_analytics',
		orgId: ORG,
		role: 'operator',
		subjects: options.subjects ?? ['bookings', 'waitlist_entries'],
		scopeIds: options.scopeIds === undefined ? null : options.scopeIds,
	})
	const res = await app.request('/analytics/query', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify({ definition: def }),
	})
	const text = await res.text()
	return { status: res.status, text, body: JSON.parse(text) as any }
}

let tempDir: string
let seq = 0

describe('/analytics/query on reservations subjects', () => {
	beforeEach(async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), 'rsv-analytics-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.INTERNAL_COMMAND_TOKEN = INTERNAL
		resetReservationsContextCache()
		orgs.set(ORG, {
			id: ORG,
			slug: 'acme',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: 'Acme',
		})
		await provisionTenantDb(ORG)
		const db = await getTenantDb(ORG)
		for (const loc of [LOC, LOC_B]) {
			await db.insert(rsvLocationSettings).values({
				locationId: loc,
				timeZone: 'UTC',
				enabled: true,
				version: 1,
			})
		}
		await db.insert(rsvServices).values({
			id: 'svc_a',
			locationId: LOC,
			name: 'Dinner',
			daysMask: 127,
			firstSeatingMin: 17 * 60,
			lastSeatingMin: 21 * 60,
			endMin: 22 * 60,
			sort: 0,
		})
		await db.insert(rsvGuests).values({
			id: 'gst_probe',
			firstName: 'Reportprobe',
			lastName: 'Zed',
			phoneE164: '+14155550177',
			emailNorm: 'reportprobe@example.com',
			allergyNotes: 'peanut allergy',
		})
		const base = Date.parse('2031-03-10T19:00:00Z')
		const row = (id: string, patch: Record<string, unknown>) => ({
			id,
			locationId: LOC,
			guestId: 'gst_probe',
			confirmationCode: `C${(seq += 1)}`,
			businessDate: '2031-03-10',
			localStartMin: 19 * 60,
			timeZone: 'UTC',
			startAt: base,
			endAt: base + 90 * 60_000,
			durationMin: 90,
			partySize: 2,
			serviceId: 'svc_a',
			channel: 'online' as const,
			staffNotes: 'seat by the secret window',
			...patch,
		})
		await db.insert(rsvReservations).values([
			row('r1', {
				status: 'finished',
				seatedAt: base,
				finishedAt: base + 3_000_000,
			}),
			row('r2', { status: 'no_show', partySize: 5, channel: 'phone' }),
			row('r3', { status: 'cancelled', channel: 'host' }),
			row('r_other_loc', { locationId: LOC_B, serviceId: null }),
			row('r_other_day', {
				businessDate: '2031-04-20',
				startAt: base + 40 * 86_400_000,
				endAt: base + 40 * 86_400_000 + 90 * 60_000,
			}),
		])
		await db.insert(rsvPayments).values({
			id: 'pay1',
			locationId: LOC,
			reservationId: 'r1',
			provider: 'stripe',
			kind: 'deposit_charge',
			amountMinor: 2500,
			status: 'succeeded',
			idempotencyKey: 'idem-1',
		} as never)
		await db.insert(rsvWaitlistEntries).values({
			id: 'w1',
			locationId: LOC,
			businessDate: '2031-03-10',
			displayName: 'Waitprobe Person',
			phoneE164: '+14155550188',
			emailNorm: 'waitprobe@example.com',
			partySize: 4,
			joinedAt: base,
			quotedMin: 15,
			status: 'left',
		})
		seedReservationsContextForTest(ORG, {
			...publicContext(ORG),
			locations: [
				{
					id: LOC,
					name: 'Acme Downtown',
					slug: 'a',
					timeZone: 'UTC',
					currency: 'USD',
					phone: null,
					address: null,
					storeHours: null,
					specialHours: null,
					isActive: true,
				},
			],
		})
	})

	afterEach(async () => {
		await destroyTenantDb(ORG)
		rmSync(tempDir, { recursive: true, force: true })
	})

	it('registers both subjects as restricted and in the catalog', () => {
		expect(RESTRICTED_REPORT_SUBJECTS).toContain('bookings')
		expect(RESTRICTED_REPORT_SUBJECTS).toContain('waitlist_entries')
		const ids = organizationCatalog.subjects.map((s) => s.id)
		expect(ids).toContain('bookings')
		expect(ids).toContain('waitlist_entries')
	})

	it('refuses both subjects without the grant and runs them with it', async () => {
		for (const [subject, field] of [
			['bookings', 'startsAt'],
			['waitlist_entries', 'joinedAt'],
		] as const) {
			const denied = await query(definition(subject, field), { subjects: [] })
			expect(denied.status, subject).toBe(403)
			expect(denied.body.error).toBe('forbidden_subject')
			const ok = await query(definition(subject, field))
			expect(ok.status, subject).toBe(200)
		}
	})

	it('returns one correct row per reservation, without contact columns', async () => {
		const columns = organizationCatalog.subjects
			.find((s) => s.id === 'bookings')!
			.fields.filter((f) => f.listable !== false)
			.map((f) => f.id)
			.slice(0, 8)
		const res = await query(definition('bookings', 'startsAt', columns))
		expect(res.status).toBe(200)
		const rows = res.body.rows as Array<Record<string, unknown>>
		expect(rows).toHaveLength(4)
		for (const marker of [
			'Reportprobe',
			'Zed',
			'+14155550177',
			'reportprobe@example.com',
			'peanut',
			'secret window',
		]) {
			expect(res.text, marker).not.toContain(marker)
		}
		expect(rows.some((r) => r.status === 'No-show')).toBe(true)
		expect(res.text).toContain('Acme Downtown')
	})

	it('limits rows to the locations in the token', async () => {
		const res = await query(definition('bookings', 'startsAt'), {
			scopeIds: [LOC_B],
		})
		expect(res.status).toBe(200)
		expect(res.body.value ?? res.body.total ?? res.body.count).toBe(1)
		const none = await query(definition('bookings', 'startsAt'), {
			scopeIds: [],
		})
		expect(none.body.value ?? none.body.total ?? none.body.count).toBe(0)
	})

	it('returns one row per waitlist entry with quoted wait and outcome, no contact data', async () => {
		const columns = organizationCatalog.subjects
			.find((s) => s.id === 'waitlist_entries')!
			.fields.filter((f) => f.listable !== false)
			.map((f) => f.id)
		const res = await query(definition('waitlist_entries', 'joinedAt', columns))
		expect(res.status).toBe(200)
		expect(res.body.rows).toHaveLength(1)
		for (const marker of [
			'Waitprobe',
			'+14155550188',
			'waitprobe@example.com',
		]) {
			expect(res.text, marker).not.toContain(marker)
		}
		expect(res.text).toContain('Left')
	})

	it('writes a report.run audit row naming the subject and no guest data', async () => {
		const db = await getTenantDb(ORG)
		await query(definition('bookings', 'startsAt'))
		const rows = await db
			.select()
			.from(rsvAuditLog)
			.where(eq(rsvAuditLog.action, 'report.run'))
		expect(rows).toHaveLength(1)
		expect(rows[0]!.entityId).toBe('bookings')
		expect(JSON.stringify(rows[0]!.changes)).not.toContain('Reportprobe')
	})
})
