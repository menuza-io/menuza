import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	RESERVATIONS_PERMISSIONS,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
} from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvAreas,
	rsvAuditLog,
	rsvBlocks,
	rsvDayVersions,
	rsvReservationEvents,
	rsvGuests,
	rsvLocationSettings,
	rsvReservations,
	rsvTableOccupancies,
	rsvTables,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.js'
import {
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../lib/reservations-context.js'
import { reservationsOperatorRoutes } from './reservations-operator.js'

const OPERATOR_SECRET =
	'test-reservations-operator-secret-key-32-chars-minimum!!'
const ORG_ID = 'org_setup_test'
const LOC_MAIN = 'loc_main'
const LOC_PATIO_STORE = 'loc_patio_store'
const USER_ID = 'usr_setup_operator'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

let tempDir: string

function buildApp() {
	const app = new Hono()
	app.route('/operator/reservations', reservationsOperatorRoutes)
	return app
}

async function mintToken(opts?: {
	grants?: string[]
	locationIds?: string[] | null
	features?: Partial<{
		waitlist: boolean
		experiences: boolean
		payments: boolean
		voice: boolean
	}>
}) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({
		role: 'operator',
		orgId: ORG_ID,
		region: 'us',
		scope: 'setup',
		grants: opts?.grants ?? [
			RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
			RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
		],
		locationIds: opts?.locationIds ?? null,
		features: {
			enabled: true,
			online: true,
			waitlist: opts?.features?.waitlist ?? true,
			experiences: opts?.features?.experiences ?? true,
			payments: opts?.features?.payments ?? true,
			voice: opts?.features?.voice ?? true,
		},
		impersonated: false,
	})
		.setProtectedHeader({
			alg: 'HS256',
			typ: RESERVATIONS_TOKEN_TYP,
		})
		.setSubject(USER_ID)
		.setIssuer(brand.shortName)
		.setAudience(RESERVATIONS_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(OPERATOR_SECRET))
}

describe('/operator/reservations/setup/* routes', () => {
	beforeEach(async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), 'rsv-setup-test-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.TENANT_OPERATOR_TOKEN = OPERATOR_SECRET
		resetReservationsContextCache()

		orgs.set(ORG_ID, {
			id: ORG_ID,
			slug: 'acme-bistro',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: 'Acme Bistro',
		})

		await provisionTenantDb(ORG_ID)

		seedReservationsContextForTest(ORG_ID, {
			orgId: ORG_ID,
			dataRegion: 'us',
			features: {
				enabled: true,
				online: true,
				waitlist: true,
				experiences: true,
				payments: true,
				voice: true,
			},
			organization: {
				name: 'Acme Bistro',
				slug: 'acme-bistro',
				defaultLocale: 'en',
				locales: ['en', 'ar'],
				siteOrigin: 'https://acme-bistro.menuza.test',
				sitePublished: true,
				logoUrl: null,
				emailTheme: {
					organizationName: 'Acme Bistro',
					logoUrl: null,
					appUrl: 'https://app.menuza.test',
					background: '#ffffff',
					card: '#f9fafb',
					foreground: '#111827',
					muted: '#f3f4f6',
					mutedForeground: '#6b7280',
					border: '#e5e7eb',
					primary: '#111827',
					primaryForeground: '#ffffff',
					accent: '#2563eb',
					accentForeground: '#ffffff',
					radius: 8,
					headingFont: 'Inter, sans-serif',
					bodyFont: 'Inter, sans-serif',
				},
			},
			locations: [
				{
					id: LOC_MAIN,
					name: 'Downtown Main',
					slug: 'downtown-main',
					timeZone: 'America/New_York',
					address: '100 Main St',
					phone: '+12125550100',
					active: true,
				},
				{
					id: LOC_PATIO_STORE,
					name: 'Uptown Store',
					slug: 'uptown-store',
					timeZone: 'America/Chicago',
					address: '200 Uptown Ave',
					phone: '+13125550199',
					active: true,
				},
			],
			payments: {
				processor: null,
				deposit: false,
				guarantee: false,
				platformFeeBp: 0,
			},
			staffing: {
				enabled: false,
			},
			voice: {
				enabled: false,
			},
		})
	})

	afterEach(async () => {
		await destroyTenantDb(ORG_ID)
		resetReservationsContextCache()
		rmSync(tempDir, { recursive: true, force: true })
	})

	it('VAL-SETUP-003, VAL-SETUP-004, VAL-SETUP-005, VAL-SETUP-006: gets and updates location settings with full field validation and expectedVersion 409 conflict', async () => {
		const app = buildApp()
		const token = await mintToken()

		// 1. GET initial settings
		const getRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/settings`,
			{
				headers: { Authorization: `Bearer ${token}` },
			},
		)
		expect(getRes.status).toBe(200)
		const initial = (await getRes.json()) as {
			settings: Record<string, unknown>
		}
		expect(initial.settings.locationId).toBe(LOC_MAIN)
		expect(initial.settings.version).toBe(1)
		expect(initial.settings.timeZone).toBe('America/New_York')
		expect(initial.settings.tzMismatch).toBe(false)

		// 2. PUT valid settings update covering booking grid, timing, toggles, party bounds
		const putRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/settings`,
			{
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					expectedVersion: 1,
					enabled: true,
					onlineEnabled: true,
					waitlistEnabled: true,
					waitlistOnline: true,
					notifyMeEnabled: true,
					intervalMin: 15,
					horizonDays: 60,
					releaseLocalMin: 540,
					minNoticeMin: 30,
					sameDayCutoffMin: 1020,
					onlinePartyMin: 2,
					onlinePartyMax: 6,
					partyMax: 12,
					largePartyMode: 'request',
					largePartyNoteI18n: {
						en: 'Large parties require manager approval.',
						ar: 'المجموعات الكبيرة تتطلب موافقة المدير.',
					},
					requestHoldsCapacity: true,
					requestDeadlineHours: 24,
					contactPhone: '+12125550123',
					publicNoteI18n: {
						en: 'Smart casual dress code.',
						ar: 'زي أنيق غير رسمي.',
					},
					seatingPrefMode: 'preferred',
					holdMinutes: 7,
					paymentHoldMinutes: 15,
					voiceHoldMinutes: 10,
					voiceMode: 'hold_link',
					freezeMin: 45,
					lateGraceMin: 15,
					autoNoShowAfterMin: 30,
					maxActivePerPhone: 3,
					blockSamePhoneOverlap: true,
					guestModifyCutoffMin: 120,
					contactStatusesEnabled: true,
					courseStatusesEnabled: true,
					waitlistResponseMin: 10,
					waitlistMaxParties: 25,
				}),
			},
		)
		expect(putRes.status).toBe(200)
		const updated = (await putRes.json()) as {
			settings: Record<string, unknown>
		}
		expect(updated.settings.version).toBe(2)
		expect(updated.settings.onlineEnabled).toBe(true)
		expect(updated.settings.onlinePartyMin).toBe(2)
		expect(updated.settings.onlinePartyMax).toBe(6)
		expect(updated.settings.partyMax).toBe(12)
		expect(updated.settings.largePartyMode).toBe('request')
		expect(updated.settings.seatingPrefMode).toBe('preferred')
		expect(updated.settings.holdMinutes).toBe(7)
		expect(updated.settings.paymentHoldMinutes).toBe(15)
		expect(updated.settings.voiceHoldMinutes).toBe(10)
		expect(updated.settings.autoNoShowAfterMin).toBe(30)

		// 3. Stale expectedVersion returns 409 stale_version with current row
		const staleRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/settings`,
			{
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					expectedVersion: 1,
					horizonDays: 90,
				}),
			},
		)
		expect(staleRes.status).toBe(409)
		const staleBody = (await staleRes.json()) as {
			error: string
			version: number
			current: { version: number; horizonDays: number }
		}
		expect(staleBody.error).toBe('stale_version')
		expect(staleBody.version).toBe(2)
		expect(staleBody.current.horizonDays).toBe(60)

		// 4. Invalid party bounds (onlinePartyMax > partyMax) returns 400
		const badBoundsRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/settings`,
			{
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					expectedVersion: 2,
					onlinePartyMin: 2,
					onlinePartyMax: 14,
					partyMax: 10,
				}),
			},
		)
		expect(badBoundsRes.status).toBe(400)
	})

	it('VAL-SETUP-030: Zod validation errors never echo rejected input values', async () => {
		const app = buildApp()
		const token = await mintToken()
		const rejectedMarker = 'bad-interval-input-marker'

		const res = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/settings`,
			{
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					intervalMin: rejectedMarker,
					holdMinutes: 99999,
					autoNoShowAfterMin: 5,
				}),
			},
		)
		expect(res.status).toBe(400)
		const rawText = await res.text()
		expect(rawText).not.toContain(rejectedMarker)
		expect(rawText).not.toContain('99999')
		const parsed = JSON.parse(rawText) as {
			error: string
			fields?: string[]
		}
		expect(parsed.error).toBe('invalid')
		expect(parsed.fields).toEqual(
			expect.arrayContaining([
				'intervalMin',
				'holdMinutes',
				'autoNoShowAfterMin',
			]),
		)
	})

	it('VAL-SETUP-007 & VAL-SETUP-026: detects time-zone mismatch and re-derives future reservation UTC instants cleanly', async () => {
		const app = buildApp()
		const token = await mintToken()
		const db = await getTenantDb(ORG_ID)

		// Seed location settings in UTC while context is America/New_York
		await db.insert(rsvLocationSettings).values({
			locationId: LOC_MAIN,
			enabled: true,
			onlineEnabled: true,
			timeZone: 'UTC',
			tzSyncedAt: Date.now() - 86_400_000,
			version: 1,
			floorPlanVersion: 1,
		})

		const getRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/settings`,
			{
				headers: { Authorization: `Bearer ${token}` },
			},
		)
		expect(getRes.status).toBe(200)
		const getBody = (await getRes.json()) as {
			settings: {
				timeZone: string
				contextTimeZone: string
				tzMismatch: boolean
			}
		}
		expect(getBody.settings.timeZone).toBe('UTC')
		expect(getBody.settings.contextTimeZone).toBe('America/New_York')
		expect(getBody.settings.tzMismatch).toBe(true)

		// Create an area, table, guest, and a future reservation at 19:00 (1140 min) on 2027-06-15
		const areaRes = await app.request('/operator/reservations/setup/areas', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				locationId: LOC_MAIN,
				name: 'Main Dining',
			}),
		})
		expect(areaRes.status).toBe(201)
		const { area } = (await areaRes.json()) as { area: { id: string } }

		const tableRes = await app.request('/operator/reservations/setup/tables', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				locationId: LOC_MAIN,
				areaId: area.id,
				label: 'T1',
				minCovers: 1,
				maxCovers: 4,
				resetBufferMin: 10,
			}),
		})
		expect(tableRes.status).toBe(201)
		const { table } = (await tableRes.json()) as { table: { id: string } }

		await db.insert(rsvGuests).values({
			id: 'gst_tz_1',
			firstName: 'Layla',
			lastName: 'Guest',
		})

		// Initially derived under UTC: 2027-06-15T19:00:00Z
		const utcStart = Date.UTC(2027, 5, 15, 19, 0, 0)
		const utcEnd = utcStart + 90 * 60_000
		await db.insert(rsvReservations).values({
			id: 'res_tz_1',
			confirmationCode: 'TZTEST01',
			locationId: LOC_MAIN,
			guestId: 'gst_tz_1',
			businessDate: '2027-06-15',
			localStartMin: 1140,
			durationMin: 90,
			startAt: utcStart,
			endAt: utcEnd,
			timeZone: 'UTC',
			partySize: 2,
			status: 'booked',
			channel: 'online',
			assignment: 'soft',
			scheduleVersion: 1,
			version: 1,
		})
		await db.insert(rsvTableOccupancies).values({
			id: 'occ_tz_1',
			locationId: LOC_MAIN,
			tableId: table.id,
			kind: 'reservation',
			reservationId: 'res_tz_1',
			startAt: utcStart,
			endAt: utcEnd + 10 * 60_000,
			active: true,
			overbook: false,
		})

		// Re-derive times to America/New_York (EDT in June is UTC-4 -> 2027-06-15T23:00:00Z)
		const rederiveRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/rederive-times`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({}),
			},
		)
		expect(rederiveRes.status).toBe(200)
		const rederiveBody = (await rederiveRes.json()) as {
			timeZone: string
			updatedReservations: number
			settings: { tzMismatch: boolean }
		}
		expect(rederiveBody.timeZone).toBe('America/New_York')
		expect(rederiveBody.updatedReservations).toBe(1)
		expect(rederiveBody.settings.tzMismatch).toBe(false)

		const expectedEdtStart = Date.UTC(2027, 5, 15, 23, 0, 0)
		const expectedEdtEnd = expectedEdtStart + 90 * 60_000
		const updatedResRow = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, 'res_tz_1'))
			.get()
		expect(updatedResRow?.startAt).toBe(expectedEdtStart)
		expect(updatedResRow?.endAt).toBe(expectedEdtEnd)
		expect(updatedResRow?.timeZone).toBe('America/New_York')
		expect(updatedResRow?.scheduleVersion).toBe(2)

		const updatedOccRow = await db
			.select()
			.from(rsvTableOccupancies)
			.where(eq(rsvTableOccupancies.id, 'occ_tz_1'))
			.get()
		expect(updatedOccRow?.active).toBe(true)
		expect(updatedOccRow?.startAt).toBe(expectedEdtStart)
		expect(updatedOccRow?.endAt).toBe(expectedEdtEnd + 10 * 60_000)

		const dayVer = await db
			.select()
			.from(rsvDayVersions)
			.where(eq(rsvDayVersions.businessDate, '2027-06-15'))
			.get()
		expect(dayVer?.version).toBeGreaterThanOrEqual(1)
	})

	it('VAL-SETUP-008, VAL-SETUP-009, VAL-SETUP-010: areas, tables (unique active label + archive reuse + reflow), and combinations CRUD', async () => {
		const app = buildApp()
		const token = await mintToken()
		const db = await getTenantDb(ORG_ID)

		// 1. Create area
		const areaRes = await app.request('/operator/reservations/setup/areas', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				locationId: LOC_MAIN,
				name: 'Main Floor',
				nameI18n: { en: 'Main Floor', ar: 'الصالة الرئيسية' },
				onlineBookable: true,
				guestSelectable: true,
				canvasW: 1400,
				canvasH: 900,
			}),
		})
		expect(areaRes.status).toBe(201)
		const { area } = (await areaRes.json()) as {
			area: { id: string; name: string }
		}
		expect(area.name).toBe('Main Floor')

		// 2. Create tables T1, T2, T3 (non-combinable)
		const t1Res = await app.request('/operator/reservations/setup/tables', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				locationId: LOC_MAIN,
				areaId: area.id,
				label: 'T1',
				minCovers: 2,
				maxCovers: 4,
				combinable: true,
				shape: 'square',
				x: 100,
				y: 120,
				w: 72,
				h: 72,
				resetBufferMin: 15,
			}),
		})
		expect(t1Res.status).toBe(201)
		const { table: t1 } = (await t1Res.json()) as { table: { id: string } }

		// Duplicate active label T1 at same location is rejected
		const dupLabelRes = await app.request(
			'/operator/reservations/setup/tables',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					areaId: area.id,
					label: 'T1',
					minCovers: 2,
					maxCovers: 4,
				}),
			},
		)
		expect(dupLabelRes.status).toBe(409)

		const t2Res = await app.request('/operator/reservations/setup/tables', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				locationId: LOC_MAIN,
				areaId: area.id,
				label: 'T2',
				minCovers: 2,
				maxCovers: 4,
				combinable: true,
				shape: 'round',
			}),
		})
		expect(t2Res.status).toBe(201)
		const { table: t2 } = (await t2Res.json()) as { table: { id: string } }

		const t3Res = await app.request('/operator/reservations/setup/tables', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				locationId: LOC_MAIN,
				areaId: area.id,
				label: 'T3',
				minCovers: 2,
				maxCovers: 4,
				combinable: false,
				shape: 'booth',
			}),
		})
		expect(t3Res.status).toBe(201)
		const { table: t3 } = (await t3Res.json()) as { table: { id: string } }

		// 3. Combinations validation: <2 tables rejected, non-combinable table rejected
		const singleMemberComboRes = await app.request(
			'/operator/reservations/setup/combos',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					label: 'Bad Combo',
					minCovers: 4,
					maxCovers: 8,
					tableIds: [t1.id],
				}),
			},
		)
		expect(singleMemberComboRes.status).toBe(400)

		const nonCombinableComboRes = await app.request(
			'/operator/reservations/setup/combos',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					label: 'T1+T3',
					minCovers: 4,
					maxCovers: 8,
					tableIds: [t1.id, t3.id],
				}),
			},
		)
		expect(nonCombinableComboRes.status).toBe(400)

		// Valid combo T1+T2
		const validComboRes = await app.request(
			'/operator/reservations/setup/combos',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					label: 'T1+T2',
					minCovers: 5,
					maxCovers: 8,
					onlineBookable: true,
					tableIds: [t2.id, t1.id],
				}),
			},
		)
		expect(validComboRes.status).toBe(201)
		const { combo } = (await validComboRes.json()) as {
			combo: { id: string; tableIds: string[] }
		}
		expect(combo.tableIds).toEqual([t1.id, t2.id].sort())

		// Duplicate canonical member set rejected
		const dupComboRes = await app.request(
			'/operator/reservations/setup/combos',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					label: 'T1+T2 Duplicate',
					minCovers: 5,
					maxCovers: 8,
					tableIds: [t1.id, t2.id],
				}),
			},
		)
		expect(dupComboRes.status).toBe(409)

		// 4. Seed a future soft booking on T1, then archive T1 -> booking reflows to T2 (or T3) and label 'T1' can be reused!
		await db.insert(rsvGuests).values({
			id: 'gst_reflow_1',
			firstName: 'Omar',
			lastName: 'Reflow',
		})
		const startAt = Date.UTC(2027, 7, 10, 22, 0, 0)
		const endAt = startAt + 90 * 60_000
		await db.insert(rsvReservations).values({
			id: 'res_reflow_1',
			confirmationCode: 'RFLW0001',
			locationId: LOC_MAIN,
			guestId: 'gst_reflow_1',
			businessDate: '2027-08-10',
			localStartMin: 1080,
			durationMin: 90,
			startAt,
			endAt,
			timeZone: 'America/New_York',
			partySize: 2,
			status: 'booked',
			channel: 'online',
			assignment: 'soft',
			scheduleVersion: 1,
			version: 1,
		})
		await db.insert(rsvTableOccupancies).values({
			id: 'occ_reflow_1',
			locationId: LOC_MAIN,
			tableId: t1.id,
			kind: 'reservation',
			reservationId: 'res_reflow_1',
			startAt,
			endAt,
			active: true,
			overbook: false,
		})

		const archiveT1Res = await app.request(
			`/operator/reservations/setup/tables/${t1.id}`,
			{
				method: 'DELETE',
				headers: { Authorization: `Bearer ${token}` },
			},
		)
		expect(archiveT1Res.status).toBe(200)
		const archiveT1Body = (await archiveT1Res.json()) as {
			archived: boolean
			reflowedMoves: Array<{ bookingId: string; toTableIds: string[] }>
		}
		expect(archiveT1Body.archived).toBe(true)
		expect(archiveT1Body.reflowedMoves).toHaveLength(1)
		expect(archiveT1Body.reflowedMoves[0]?.bookingId).toBe('res_reflow_1')
		expect([t2.id, t3.id]).toContain(
			archiveT1Body.reflowedMoves[0]?.toTableIds[0],
		)

		// Now creating a new table with label 'T1' succeeds because old T1 is archived
		const reuseT1Res = await app.request(
			'/operator/reservations/setup/tables',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					areaId: area.id,
					label: 'T1',
					minCovers: 2,
					maxCovers: 4,
				}),
			},
		)
		expect(reuseT1Res.status).toBe(201)
	})

	it('VAL-SETUP-011..017: atomic floor-plan save persists tables, combos, and decor elements, enforces floorPlanVersion 409, and reflows shrunk/archived tables', async () => {
		const app = buildApp()
		const token = await mintToken()
		const db = await getTenantDb(ORG_ID)

		// 1. GET initial floor plan
		const getFpRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/floor-plan`,
			{
				headers: { Authorization: `Bearer ${token}` },
			},
		)
		expect(getFpRes.status).toBe(200)
		const initialFp = (await getFpRes.json()) as {
			floorPlanVersion: number
			areas: unknown[]
			tables: unknown[]
			elements: unknown[]
		}
		expect(initialFp.floorPlanVersion).toBe(1)

		// 2. PUT atomic floor plan save with 1 area, 2 tables, 1 combo, and 3 decor elements
		const saveRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/floor-plan`,
			{
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					floorPlanVersion: 1,
					areas: [
						{
							id: 'area_fp_1',
							name: 'Dining Room',
							canvasW: 1200,
							canvasH: 800,
							onlineBookable: true,
							guestSelectable: true,
							sort: 0,
						},
					],
					tables: [
						{
							id: 'tbl_fp_1',
							areaId: 'area_fp_1',
							label: 'A1',
							minCovers: 2,
							maxCovers: 6,
							shape: 'rect',
							x: 120,
							y: 160,
							w: 96,
							h: 64,
							rotation: 90,
							combinable: true,
							onlineBookable: true,
							resetBufferMin: 10,
						},
						{
							id: 'tbl_fp_2',
							areaId: 'area_fp_1',
							label: 'A2',
							minCovers: 2,
							maxCovers: 6,
							shape: 'round',
							x: 260,
							y: 160,
							w: 64,
							h: 64,
							rotation: 0,
							combinable: true,
							onlineBookable: true,
							resetBufferMin: 10,
						},
					],
					combos: [
						{
							id: 'cmb_fp_1',
							label: 'A1+A2',
							minCovers: 6,
							maxCovers: 12,
							onlineBookable: true,
							tableIds: ['tbl_fp_1', 'tbl_fp_2'],
						},
					],
					elements: [
						{
							id: 'elm_wall_1',
							areaId: 'area_fp_1',
							kind: 'wall',
							x: 40,
							y: 40,
							w: 400,
							h: 12,
							rotation: 0,
							label: 'North Wall',
						},
						{
							id: 'elm_bar_1',
							areaId: 'area_fp_1',
							kind: 'bar',
							x: 500,
							y: 100,
							w: 180,
							h: 60,
							rotation: 0,
							label: 'Main Bar',
						},
						{
							id: 'elm_plant_1',
							areaId: 'area_fp_1',
							kind: 'plant',
							x: 80,
							y: 300,
							w: 32,
							h: 32,
							rotation: 15,
						},
					],
				}),
			},
		)
		expect(saveRes.status).toBe(200)
		const savedFp = (await saveRes.json()) as {
			floorPlanVersion: number
			tables: Array<{ id: string; label: string; maxCovers: number }>
			combos: Array<{ id: string; tableIds: string[] }>
			elements: Array<{ id: string; kind: string }>
		}
		expect(savedFp.floorPlanVersion).toBe(2)
		expect(savedFp.tables).toHaveLength(2)
		expect(savedFp.combos).toHaveLength(1)
		expect(savedFp.elements).toHaveLength(3)

		// 3. Stale floorPlanVersion returns 409 stale_version without partial writes
		const staleFpRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/floor-plan`,
			{
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					floorPlanVersion: 1,
					areas: [{ id: 'area_fp_1', name: 'Hacked Room' }],
					tables: [],
					combos: [],
					elements: [],
				}),
			},
		)
		expect(staleFpRes.status).toBe(409)
		const staleFpBody = (await staleFpRes.json()) as {
			error: string
			floorPlanVersion: number
		}
		expect(staleFpBody.error).toBe('stale_version')
		expect(staleFpBody.floorPlanVersion).toBe(2)

		// 4. Seed a 6-cover soft booking on tbl_fp_1, then shrink tbl_fp_1 to maxCovers: 4 in floor-plan save -> booking reflows to tbl_fp_2!
		await db.insert(rsvGuests).values({
			id: 'gst_fp_1',
			firstName: 'Nadia',
			lastName: 'Shrink',
		})
		const startAt = Date.UTC(2027, 8, 15, 22, 0, 0)
		const endAt = startAt + 90 * 60_000
		await db.insert(rsvReservations).values({
			id: 'res_fp_shrink',
			confirmationCode: 'FPSHRK01',
			locationId: LOC_MAIN,
			guestId: 'gst_fp_1',
			businessDate: '2027-09-15',
			localStartMin: 1080,
			durationMin: 90,
			startAt,
			endAt,
			timeZone: 'America/New_York',
			partySize: 6,
			status: 'booked',
			channel: 'online',
			assignment: 'soft',
			scheduleVersion: 1,
			version: 1,
		})
		await db.insert(rsvTableOccupancies).values({
			id: 'occ_fp_shrink',
			locationId: LOC_MAIN,
			tableId: 'tbl_fp_1',
			kind: 'reservation',
			reservationId: 'res_fp_shrink',
			startAt,
			endAt,
			active: true,
			overbook: false,
		})

		const shrinkFpRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/floor-plan`,
			{
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					floorPlanVersion: 2,
					areas: [
						{
							id: 'area_fp_1',
							name: 'Dining Room',
							canvasW: 1200,
							canvasH: 800,
						},
					],
					tables: [
						{
							id: 'tbl_fp_1',
							areaId: 'area_fp_1',
							label: 'A1',
							minCovers: 2,
							maxCovers: 4, // Shrunk from 6 to 4!
							shape: 'rect',
							x: 120,
							y: 160,
							w: 96,
							h: 64,
							rotation: 90,
							combinable: true,
							onlineBookable: true,
						},
						{
							id: 'tbl_fp_2',
							areaId: 'area_fp_1',
							label: 'A2',
							minCovers: 2,
							maxCovers: 6,
							shape: 'round',
							x: 260,
							y: 160,
							w: 64,
							h: 64,
							rotation: 0,
							combinable: true,
							onlineBookable: true,
						},
					],
					combos: [],
					elements: [],
				}),
			},
		)
		expect(shrinkFpRes.status).toBe(200)
		const shrinkFpBody = (await shrinkFpRes.json()) as {
			floorPlanVersion: number
			reflowedMoves: Array<{
				bookingId: string
				fromTableIds: string[]
				toTableIds: string[]
			}>
		}
		expect(shrinkFpBody.floorPlanVersion).toBe(3)
		expect(shrinkFpBody.reflowedMoves).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					bookingId: 'res_fp_shrink',
					fromTableIds: ['tbl_fp_1'],
					toTableIds: ['tbl_fp_2'],
				}),
			]),
		)
	})

	it('VAL-SETUP-018, VAL-SETUP-019, VAL-SETUP-020, VAL-SETUP-021, VAL-SETUP-022: services (including after-midnight), turn times, pacing rules, per-service table modes (XOR target), and special days CRUD', async () => {
		const app = buildApp()
		const token = await mintToken()

		// Create area & table for service availability tests
		const areaRes = await app.request('/operator/reservations/setup/areas', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ locationId: LOC_MAIN, name: 'Patio' }),
		})
		const { area } = (await areaRes.json()) as { area: { id: string } }
		const tblRes = await app.request('/operator/reservations/setup/tables', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				locationId: LOC_MAIN,
				areaId: area.id,
				label: 'P1',
				minCovers: 2,
				maxCovers: 4,
			}),
		})
		const { table } = (await tblRes.json()) as { table: { id: string } }

		// 1. VAL-SETUP-018: Create Dinner service + Late Night after-midnight service (22:00 = 1320 to 02:00 = 1560)
		const dinnerRes = await app.request(
			'/operator/reservations/setup/services',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					name: 'Dinner',
					nameI18n: { en: 'Dinner', ar: 'العشاء' },
					daysMask: 127,
					firstSeatingMin: 1020,
					lastSeatingMin: 1290,
					endMin: 1380,
					onlineEnabled: true,
					onlineCapPerInterval: 20,
					concurrentCoversCap: 60,
					colorToken: 'amber',
				}),
			},
		)
		expect(dinnerRes.status).toBe(201)
		const { service: dinner } = (await dinnerRes.json()) as {
			service: { id: string; firstSeatingMin: number; endMin: number }
		}
		expect(dinner.firstSeatingMin).toBe(1020)
		expect(dinner.endMin).toBe(1380)

		const lateNightRes = await app.request(
			'/operator/reservations/setup/services',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					name: 'Late Lounge',
					daysMask: 96, // Sat + Sun
					firstSeatingMin: 1320, // 22:00
					lastSeatingMin: 1500, // 01:00 (+1d)
					endMin: 1560, // 02:00 (+1d)
					onlineEnabled: true,
				}),
			},
		)
		expect(lateNightRes.status).toBe(201)

		// Invalid service window (firstSeatingMin > lastSeatingMin) rejected
		const badSvcRes = await app.request(
			'/operator/reservations/setup/services',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					name: 'Inverted Service',
					daysMask: 127,
					firstSeatingMin: 1200,
					lastSeatingMin: 1080,
					endMin: 1320,
				}),
			},
		)
		expect(badSvcRes.status).toBe(400)

		// 2. VAL-SETUP-019: Turn-time buckets CRUD
		const ttRes = await app.request('/operator/reservations/setup/turn-times', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				locationId: LOC_MAIN,
				serviceId: dinner.id,
				partyMin: 1,
				partyMax: 2,
				minutes: 75,
			}),
		})
		expect(ttRes.status).toBe(201)
		const { turnTime } = (await ttRes.json()) as {
			turnTime: { id: string; minutes: number }
		}
		expect(turnTime.minutes).toBe(75)

		// Out-of-range turn time (<15 min) rejected
		const badTtRes = await app.request(
			'/operator/reservations/setup/turn-times',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					partyMin: 1,
					partyMax: 2,
					minutes: 10,
				}),
			},
		)
		expect(badTtRes.status).toBe(400)

		// 3. VAL-SETUP-020: Pacing rules CRUD
		const pacingRes = await app.request('/operator/reservations/setup/pacing', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				serviceId: dinner.id,
				bucketMin: 15,
				fromMin: 1080,
				toMin: 1260,
				maxCovers: 16,
				maxParties: 5,
				rollingMin: 60,
				rollingMaxCovers: 48,
				channel: 'online',
			}),
		})
		expect(pacingRes.status).toBe(201)
		const { pacingRule } = (await pacingRes.json()) as {
			pacingRule: { id: string; maxCovers: number; rollingMaxCovers: number }
		}
		expect(pacingRule.maxCovers).toBe(16)
		expect(pacingRule.rollingMaxCovers).toBe(48)

		// 4. VAL-SETUP-021: Per-service table availability modes (XOR target)
		const xorBadRes = await app.request(
			'/operator/reservations/setup/service-availability',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					serviceId: dinner.id,
					areaId: area.id,
					tableId: table.id, // Both set -> violates XOR!
					mode: 'staff_only',
				}),
			},
		)
		expect(xorBadRes.status).toBe(400)

		const saRes = await app.request(
			'/operator/reservations/setup/service-availability',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					serviceId: dinner.id,
					tableId: table.id,
					mode: 'walk_in_only',
					fromMin: 1080,
					toMin: 1260,
				}),
			},
		)
		expect(saRes.status).toBe(201)
		const { serviceAvailability } = (await saRes.json()) as {
			serviceAvailability: { id: string; mode: string; tableId: string }
		}
		expect(serviceAvailability.mode).toBe('walk_in_only')
		expect(serviceAvailability.tableId).toBe(table.id)

		// 5. VAL-SETUP-022: Special days CRUD (closed, online_closed, modified, replace)
		const sdBadRange = await app.request(
			'/operator/reservations/setup/special-days',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					fromDate: '2027-12-26',
					toDate: '2027-12-24', // Inverted range
					kind: 'closed',
				}),
			},
		)
		expect(sdBadRange.status).toBe(400)

		const sdRes = await app.request(
			'/operator/reservations/setup/special-days',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					fromDate: '2027-12-31',
					toDate: '2027-12-31',
					kind: 'replace',
					name: 'New Years Eve Gala',
					publicNoteI18n: { en: 'Special NYE seating only.' },
					services: [
						{
							name: 'NYE Gala Seating',
							daysMask: 127,
							firstSeatingMin: 1140,
							lastSeatingMin: 1260,
							endMin: 1500,
							onlineEnabled: true,
						},
					],
				}),
			},
		)
		expect(sdRes.status).toBe(201)
		const sdBody = (await sdRes.json()) as {
			specialDay: { id: string; kind: string; name: string }
			services?: Array<{ id: string; specialDayId: string }>
		}
		expect(sdBody.specialDay.kind).toBe('replace')
		expect(sdBody.services?.[0]?.specialDayId).toBe(sdBody.specialDay.id)
	})

	it('VAL-SETUP-023, VAL-SETUP-024, VAL-SETUP-025: table/area blocks expand into rsv_table_occupancies, reflow soft bookings, and expose validation & conflicts endpoints', async () => {
		const app = buildApp()
		const token = await mintToken()
		const db = await getTenantDb(ORG_ID)

		// Create area + 2 tables
		const areaRes = await app.request('/operator/reservations/setup/areas', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ locationId: LOC_MAIN, name: 'Main Room' }),
		})
		const { area } = (await areaRes.json()) as { area: { id: string } }

		const t1Res = await app.request('/operator/reservations/setup/tables', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				locationId: LOC_MAIN,
				areaId: area.id,
				label: 'B1',
				minCovers: 2,
				maxCovers: 4,
			}),
		})
		const { table: b1 } = (await t1Res.json()) as { table: { id: string } }

		const t2Res = await app.request('/operator/reservations/setup/tables', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				locationId: LOC_MAIN,
				areaId: area.id,
				label: 'B2',
				minCovers: 2,
				maxCovers: 4,
			}),
		})
		const { table: b2 } = (await t2Res.json()) as { table: { id: string } }

		// Seed a soft booking on B1 and a locked booking on B2 for 2027-10-20
		await db.insert(rsvGuests).values({
			id: 'gst_blk_1',
			firstName: 'Samir',
			lastName: 'BlockTest',
		})
		const startAt = Date.UTC(2027, 9, 20, 22, 0, 0)
		const endAt = startAt + 90 * 60_000
		await db.insert(rsvReservations).values({
			id: 'res_soft_b1',
			confirmationCode: 'BLKSFT01',
			locationId: LOC_MAIN,
			guestId: 'gst_blk_1',
			businessDate: '2027-10-20',
			localStartMin: 1080,
			durationMin: 90,
			startAt,
			endAt,
			timeZone: 'America/New_York',
			partySize: 2,
			status: 'booked',
			channel: 'online',
			assignment: 'soft',
			scheduleVersion: 1,
			version: 1,
		})
		await db.insert(rsvTableOccupancies).values({
			id: 'occ_soft_b1',
			locationId: LOC_MAIN,
			tableId: b1.id,
			kind: 'reservation',
			reservationId: 'res_soft_b1',
			startAt,
			endAt,
			active: true,
			overbook: false,
		})

		// Block table B1 during [startAt, endAt) -> soft booking res_soft_b1 reflows to B2!
		const blkRes = await app.request('/operator/reservations/setup/blocks', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				locationId: LOC_MAIN,
				tableId: b1.id,
				businessDate: '2027-10-20',
				startAt,
				endAt,
				reason: 'Maintenance',
			}),
		})
		expect(blkRes.status).toBe(201)
		const blkBody = (await blkRes.json()) as {
			block: { id: string; tableId: string }
			reflowedMoves: Array<{
				bookingId: string
				fromTableIds: string[]
				toTableIds: string[]
			}>
		}
		expect(blkBody.block.tableId).toBe(b1.id)
		expect(blkBody.reflowedMoves).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					bookingId: 'res_soft_b1',
					fromTableIds: [b1.id],
					toTableIds: [b2.id],
				}),
			]),
		)

		// Now block table B2 as well -> no remaining table for res_soft_b1, so it becomes unassigned and appears in /conflicts!
		const blk2Res = await app.request('/operator/reservations/setup/blocks', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				locationId: LOC_MAIN,
				tableId: b2.id,
				businessDate: '2027-10-20',
				startAt,
				endAt,
				reason: 'VIP Hold',
			}),
		})
		expect(blk2Res.status).toBe(201)

		// Check GET /locations/:id/conflicts
		const conflictsRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/conflicts?date=2027-10-20`,
			{
				headers: { Authorization: `Bearer ${token}` },
			},
		)
		expect(conflictsRes.status).toBe(200)
		const conflictsBody = (await conflictsRes.json()) as {
			conflicts: Array<{ kind: string; bookingId?: string }>
		}
		expect(conflictsBody.conflicts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'unassigned',
					bookingId: 'res_soft_b1',
				}),
			]),
		)

		// Check GET /locations/:id/validate and /validation (party size 5..6 has no table since B1 & B2 max is 4)
		const valRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/validation`,
			{
				headers: { Authorization: `Bearer ${token}` },
			},
		)
		expect(valRes.status).toBe(200)
		const valBody = (await valRes.json()) as {
			valid: boolean
			issues: Array<{ code: string; partySize?: number }>
		}
		expect(valBody.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: 'unseatable_party_size',
				}),
			]),
		)

		// Verify audit log entries were written
		const audits = await db.select().from(rsvAuditLog).all()
		expect(audits.length).toBeGreaterThan(0)
	})

	it('GET /locations/:id/conflicts is a dry run: repeated reads write no events, occupancies, reservation versions, or day versions', async () => {
		const app = buildApp()
		const token = await mintToken()
		const db = await getTenantDb(ORG_ID)

		await db.insert(rsvLocationSettings).values({
			locationId: LOC_MAIN,
			timeZone: 'America/New_York',
			enabled: true,
		})
		await db.insert(rsvAreas).values({
			id: 'area_dry',
			locationId: LOC_MAIN,
			name: 'Main',
		})
		await db.insert(rsvTables).values({
			id: 'tbl_dry_1',
			locationId: LOC_MAIN,
			areaId: 'area_dry',
			label: 'D1',
			minCovers: 1,
			maxCovers: 4,
		})
		await db.insert(rsvGuests).values({
			id: 'gst_dry',
			firstName: 'Dry',
			lastName: 'Run',
		})
		// A soft booking with no table is something a real reflow would assign and record.
		const startAt = Date.UTC(2037, 9, 20, 22, 0, 0)
		await db.insert(rsvReservations).values({
			id: 'res_dry',
			confirmationCode: 'DRYRUN01',
			locationId: LOC_MAIN,
			guestId: 'gst_dry',
			businessDate: '2037-10-20',
			localStartMin: 1080,
			durationMin: 90,
			startAt,
			endAt: startAt + 90 * 60_000,
			timeZone: 'America/New_York',
			partySize: 2,
			status: 'booked',
			channel: 'online',
			assignment: 'soft',
			scheduleVersion: 1,
			version: 1,
		})

		const snapshot = async () => ({
			events: await db.select().from(rsvReservationEvents).all(),
			occupancies: await db.select().from(rsvTableOccupancies).all(),
			dayVersions: await db.select().from(rsvDayVersions).all(),
			reservations: await db.select().from(rsvReservations).all(),
		})
		const before = await snapshot()

		for (let i = 0; i < 2; i++) {
			const res = await app.request(
				`/operator/reservations/setup/locations/${LOC_MAIN}/conflicts?date=2037-10-20`,
				{ headers: { Authorization: `Bearer ${token}` } },
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as { conflicts: unknown[] }
			expect(Array.isArray(body.conflicts)).toBe(true)
		}

		expect(await snapshot()).toEqual(before)
	})

	it('VAL-SETUP-023 & VAL-CROSS-006: POST /locations/:id/blocks accepts the UI payload { date, startMin, endMin }, stores epoch instants, reflows soft bookings and emits auto_reassigned', async () => {
		const app = buildApp()
		const token = await mintToken()
		const db = await getTenantDb(ORG_ID)

		await db.insert(rsvLocationSettings).values({
			locationId: LOC_MAIN,
			timeZone: 'America/New_York',
			enabled: true,
		})
		await db.insert(rsvAreas).values({
			id: 'area_ui_blk',
			locationId: LOC_MAIN,
			name: 'Main',
		})
		await db.insert(rsvTables).values([
			{
				id: 'tbl_ui_1',
				locationId: LOC_MAIN,
				areaId: 'area_ui_blk',
				label: 'U1',
				minCovers: 1,
				maxCovers: 4,
			},
			{
				id: 'tbl_ui_2',
				locationId: LOC_MAIN,
				areaId: 'area_ui_blk',
				label: 'U2',
				minCovers: 1,
				maxCovers: 4,
			},
		])
		await db.insert(rsvGuests).values({
			id: 'gst_ui_blk',
			firstName: 'Una',
			lastName: 'Block',
		})
		const startAt = Date.UTC(2027, 9, 20, 22, 0, 0)
		const endAt = startAt + 90 * 60_000
		await db.insert(rsvReservations).values({
			id: 'res_ui_soft',
			confirmationCode: 'UIBLK001',
			locationId: LOC_MAIN,
			guestId: 'gst_ui_blk',
			businessDate: '2027-10-20',
			localStartMin: 1080,
			durationMin: 90,
			startAt,
			endAt,
			timeZone: 'America/New_York',
			partySize: 2,
			status: 'booked',
			channel: 'online',
			assignment: 'soft',
			scheduleVersion: 1,
			version: 1,
		})
		await db.insert(rsvTableOccupancies).values({
			id: 'occ_ui_soft',
			locationId: LOC_MAIN,
			tableId: 'tbl_ui_1',
			kind: 'reservation',
			reservationId: 'res_ui_soft',
			startAt,
			endAt,
			active: true,
			overbook: false,
		})

		const res = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/blocks`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					date: '2027-10-20',
					startMin: 1080,
					endMin: 1170,
					tableId: 'tbl_ui_1',
					reason: 'Maintenance',
				}),
			},
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as {
			block: { id: string; tableId: string }
			reflowedMoves: Array<{ bookingId: string; toTableIds: string[] }>
		}
		expect(body.reflowedMoves).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					bookingId: 'res_ui_soft',
					toTableIds: ['tbl_ui_2'],
				}),
			]),
		)

		const row = await db
			.select()
			.from(rsvBlocks)
			.where(eq(rsvBlocks.id, body.block.id))
			.get()
		expect(row?.businessDate).toBe('2027-10-20')
		expect(row?.startAt).toBe(startAt)
		expect(row?.endAt).toBe(endAt)

		const events = await db
			.select()
			.from(rsvReservationEvents)
			.where(eq(rsvReservationEvents.reservationId, 'res_ui_soft'))
			.all()
		expect(events.map((e) => e.type)).toContain('auto_reassigned')
	})

	it('POST /blocks whose reflow collides with an occupancy the engine cannot see answers a typed 409 block_conflict without SQL text and rolls back', async () => {
		const app = buildApp()
		const token = await mintToken()
		const db = await getTenantDb(ORG_ID)

		await db.insert(rsvLocationSettings).values({
			locationId: LOC_MAIN,
			timeZone: 'America/New_York',
			enabled: true,
		})
		await db.insert(rsvAreas).values({
			id: 'area_bc',
			locationId: LOC_MAIN,
			name: 'Main',
		})
		await db.insert(rsvTables).values([
			{
				id: 'tbl_bc_1',
				locationId: LOC_MAIN,
				areaId: 'area_bc',
				label: 'C1',
				minCovers: 1,
				maxCovers: 4,
			},
			{
				id: 'tbl_bc_2',
				locationId: LOC_MAIN,
				areaId: 'area_bc',
				label: 'C2',
				minCovers: 1,
				maxCovers: 4,
			},
		])
		await db.insert(rsvGuests).values({
			id: 'gst_bc',
			firstName: 'Bea',
			lastName: 'Conflict',
		})
		const startAt = Date.UTC(2027, 9, 20, 22, 0, 0)
		const endAt = startAt + 90 * 60_000
		const seed = async (
			id: string,
			tableId: string,
			status: 'booked' | 'cancelled',
		) => {
			await db.insert(rsvReservations).values({
				id,
				confirmationCode: id.slice(-8).toUpperCase(),
				locationId: LOC_MAIN,
				guestId: 'gst_bc',
				businessDate: '2027-10-20',
				localStartMin: 1080,
				durationMin: 90,
				startAt,
				endAt,
				timeZone: 'America/New_York',
				partySize: 2,
				status,
				channel: 'phone',
				assignment: 'soft',
				scheduleVersion: 1,
				version: 1,
			})
			await db.insert(rsvTableOccupancies).values({
				id: `occ_${id}`,
				locationId: LOC_MAIN,
				tableId,
				kind: 'reservation',
				reservationId: id,
				startAt,
				endAt,
				active: true,
				overbook: false,
			})
		}
		await seed('res_bc_soft', 'tbl_bc_1', 'booked')
		// Stale active occupancy of a cancelled reservation: invisible to the engine, visible to the trigger.
		await seed('res_bc_stale', 'tbl_bc_2', 'cancelled')

		const res = await app.request('/operator/reservations/setup/blocks', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				locationId: LOC_MAIN,
				tableId: 'tbl_bc_1',
				businessDate: '2027-10-20',
				startAt,
				endAt,
				reason: 'Maintenance',
			}),
		})
		expect(res.status).toBe(409)
		const text = await res.text()
		expect(text).not.toMatch(/Failed query|insert into|rsv_table/i)
		expect(JSON.parse(text)).toMatchObject({
			error: 'block_conflict',
			reservationIds: ['res_bc_soft'],
		})

		expect(await db.select().from(rsvBlocks).all()).toHaveLength(0)
		const soft = await db
			.select()
			.from(rsvTableOccupancies)
			.where(eq(rsvTableOccupancies.reservationId, 'res_bc_soft'))
			.all()
		expect(soft.map((o) => [o.tableId, o.active])).toEqual([['tbl_bc_1', true]])
	})

	it('enforces hold-duration bounds (3..20, 10..60, 5..30), turn-time max 480 & non-overlapping buckets, combo validation on update & saveFloorPlan, and unconditional special-day day-version bumps', async () => {
		const token = await mintToken()
		const app = buildApp()
		const db = await getTenantDb(ORG_ID)

		// 1. Hold duration bounds (VAL-SETUP-005):
		// holdMinutes: 3..20, paymentHoldMinutes: 10..60, voiceHoldMinutes: 5..30
		for (const badBody of [
			{ locationId: LOC_MAIN, holdMinutes: 2 },
			{ locationId: LOC_MAIN, holdMinutes: 21 },
			{ locationId: LOC_MAIN, paymentHoldMinutes: 9 },
			{ locationId: LOC_MAIN, paymentHoldMinutes: 61 },
			{ locationId: LOC_MAIN, voiceHoldMinutes: 4 },
			{ locationId: LOC_MAIN, voiceHoldMinutes: 31 },
		]) {
			const res = await app.request(
				`/operator/reservations/setup/locations/${LOC_MAIN}/settings`,
				{
					method: 'PUT',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(badBody),
				},
			)
			expect(res.status).toBe(400)
		}

		// Valid boundary values succeed
		const validHoldRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/settings`,
			{
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					holdMinutes: 3,
					paymentHoldMinutes: 60,
					voiceHoldMinutes: 30,
				}),
			},
		)
		expect(validHoldRes.status).toBe(200)

		// 2. Turn-time minutes 15..480 and non-overlapping party buckets (VAL-SETUP-019)
		const tooLongTurnRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/turn-times`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					partyMin: 1,
					partyMax: 2,
					minutes: 500,
				}),
			},
		)
		expect(tooLongTurnRes.status).toBe(400)

		const tt1Res = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/turn-times`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					partyMin: 1,
					partyMax: 4,
					minutes: 90,
				}),
			},
		)
		expect(tt1Res.status).toBe(201)

		// Overlapping bucket [3, 6] in same (locationId, serviceId=null) scope -> 400
		const overlapCreateRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/turn-times`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					partyMin: 3,
					partyMax: 6,
					minutes: 120,
				}),
			},
		)
		expect(overlapCreateRes.status).toBe(400)

		// Non-overlapping bucket [5, 8] succeeds -> 201, then updating it to [4, 8] -> 400
		const tt2Res = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/turn-times`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					partyMin: 5,
					partyMax: 8,
					minutes: 120,
				}),
			},
		)
		expect(tt2Res.status).toBe(201)
		const tt2 = ((await tt2Res.json()) as any).turnTime
		const overlapUpdateRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/turn-times/${tt2.id}`,
			{
				method: 'PATCH',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					partyMin: 4,
					partyMax: 8,
				}),
			},
		)
		expect(overlapUpdateRes.status).toBe(400)

		// 3. Special-day create, update, and delete unconditionally bump rsv_day_versions (VAL-SETUP-022)
		const sdCreateRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/special-days`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					fromDate: '2027-12-24',
					toDate: '2027-12-25',
					kind: 'closed',
					name: 'Holiday Closure',
				}),
			},
		)
		expect(sdCreateRes.status).toBe(201)
		const sd = ((await sdCreateRes.json()) as any).specialDay

		const dvAfterCreate24 = await db
			.select()
			.from(rsvDayVersions)
			.where(eq(rsvDayVersions.businessDate, '2027-12-24'))
			.get()
		const dvAfterCreate25 = await db
			.select()
			.from(rsvDayVersions)
			.where(eq(rsvDayVersions.businessDate, '2027-12-25'))
			.get()
		expect(dvAfterCreate24?.version).toBeGreaterThanOrEqual(1)
		expect(dvAfterCreate25?.version).toBeGreaterThanOrEqual(1)

		const v24BeforeUpdate = dvAfterCreate24!.version
		const sdUpdateRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/special-days/${sd.id}`,
			{
				method: 'PATCH',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Updated Holiday Closure',
				}),
			},
		)
		expect(sdUpdateRes.status).toBe(200)
		const dvAfterUpdate24 = await db
			.select()
			.from(rsvDayVersions)
			.where(eq(rsvDayVersions.businessDate, '2027-12-24'))
			.get()
		expect(dvAfterUpdate24!.version).toBeGreaterThan(v24BeforeUpdate)

		const v24BeforeDelete = dvAfterUpdate24!.version
		const sdDeleteRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/special-days/${sd.id}`,
			{
				method: 'DELETE',
				headers: { Authorization: `Bearer ${token}` },
			},
		)
		expect(sdDeleteRes.status).toBe(200)
		const dvAfterDelete24 = await db
			.select()
			.from(rsvDayVersions)
			.where(eq(rsvDayVersions.businessDate, '2027-12-24'))
			.get()
		expect(dvAfterDelete24!.version).toBeGreaterThan(v24BeforeDelete)

		// 4. Combo validation on update and saveFloorPlan (VAL-SETUP-010)
		const areaRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/areas`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ locationId: LOC_MAIN, name: 'Combo Test Area' }),
			},
		)
		const area = ((await areaRes.json()) as any).area
		const createTbl = async (label: string, combinable: boolean) => {
			const r = await app.request(
				`/operator/reservations/setup/locations/${LOC_MAIN}/tables`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						locationId: LOC_MAIN,
						areaId: area.id,
						label,
						minCovers: 1,
						maxCovers: 4,
						combinable,
					}),
				},
			)
			return ((await r.json()) as any).table
		}
		const ct1 = await createTbl('CT1', true)
		const ct2 = await createTbl('CT2', true)
		const ct3 = await createTbl('CT3', true)
		const ctFixed = await createTbl('CT_FIXED', false)

		const c1Res = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/combos`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					label: 'CT1+CT2',
					minCovers: 2,
					maxCovers: 8,
					tableIds: [ct1.id, ct2.id],
				}),
			},
		)
		expect(c1Res.status).toBe(201)

		const c2Res = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/combos`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					label: 'CT2+CT3',
					minCovers: 2,
					maxCovers: 8,
					tableIds: [ct2.id, ct3.id],
				}),
			},
		)
		expect(c2Res.status).toBe(201)
		const c2 = ((await c2Res.json()) as any).combo

		// Updating c2 to duplicate c1's member set [ct2.id, ct1.id] -> 400 or 409
		const dupPatchRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/combos/${c2.id}`,
			{
				method: 'PATCH',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					tableIds: [ct2.id, ct1.id],
				}),
			},
		)
		expect([400, 409]).toContain(dupPatchRes.status)

		// Updating c2 to include non-combinable table ctFixed -> 400
		const nonCombPatchRes = await app.request(
			`/operator/reservations/setup/locations/${LOC_MAIN}/combos/${c2.id}`,
			{
				method: 'PATCH',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					tableIds: [ct2.id, ctFixed.id],
				}),
			},
		)
		expect(nonCombPatchRes.status).toBe(400)
	})
})
