import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	RESERVATIONS_PERMISSIONS,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
	type ReservationsScope,
} from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvAreas,
	rsvAuditLog,
	rsvGuests,
	rsvBlocks,
	rsvHolds,
	rsvLocationSettings,
	rsvPacingRules,
	rsvReservationTags,
	rsvServices,
	rsvSpecialDays,
	rsvTableOccupancies,
	rsvTables,
	rsvTags,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../lib/reservations-context.ts'
import { reservationsInternalRoutes } from './reservations-internal.ts'
import { reservationsOperatorRoutes } from './reservations-operator.ts'

const OPERATOR_SECRET =
	'test-reservations-operator-secret-key-32-chars-minimum!!'
const INTERNAL_SECRET =
	'test-reservations-internal-secret-key-32-chars-minimum!!'
const ORG_ID = 'org_book_route_test'
const LOC_MAIN = 'loc_main'
const LOC_OTHER = 'loc_other'
const USER_ID = 'usr_book_operator'
const DATE = '2027-08-20'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

let tempDir: string

function buildApp() {
	const app = new Hono()
	app.route('/operator/reservations', reservationsOperatorRoutes)
	app.route('/internal/reservations', reservationsInternalRoutes)
	return app
}

async function mintToken(opts?: {
	scope?: ReservationsScope
	grants?: string[]
	locationIds?: string[] | null
	sub?: string
}) {
	const now = Math.floor(Date.now() / 1000)
	const scope = opts?.scope ?? 'book'
	const defaultGrants =
		scope === 'guests'
			? [
					RESERVATIONS_PERMISSIONS.READ_RESERVATION,
					RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
					RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
				]
			: scope === 'setup'
				? [
						RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
						RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
					]
				: [
						RESERVATIONS_PERMISSIONS.READ_RESERVATION,
						RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
						RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
					]
	return new jose.SignJWT({
		role: 'operator',
		orgId: ORG_ID,
		region: 'us',
		scope,
		grants: opts?.grants ?? defaultGrants,
		locationIds: opts?.locationIds ?? null,
		features: {
			enabled: true,
			online: true,
			waitlist: true,
			experiences: true,
			payments: true,
			voice: false,
		},
		impersonated: false,
	})
		.setProtectedHeader({
			alg: 'HS256',
			typ: RESERVATIONS_TOKEN_TYP,
		})
		.setSubject(opts?.sub ?? USER_ID)
		.setIssuer(brand.shortName)
		.setAudience(RESERVATIONS_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(OPERATOR_SECRET))
}

describe('/operator/reservations/book/*, /guests/*, and /internal/reservations/summary routes', () => {
	beforeEach(async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), 'rsv-book-route-test-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.TENANT_OPERATOR_TOKEN = OPERATOR_SECRET
		process.env.INTERNAL_COMMAND_TOKEN = INTERNAL_SECRET
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
		const db = await getTenantDb(ORG_ID)
		const now = Date.now()

		await db.insert(rsvLocationSettings).values({
			locationId: LOC_MAIN,
			timeZone: 'America/New_York',
			dayStartMin: 240,
			intervalMin: 15,
			freezeMin: 30,
			contactStatusesEnabled: true,
			courseStatusesEnabled: true,
			enabled: true,
			version: 1,
			updatedAt: now,
		})

		await db.insert(rsvAreas).values({
			id: 'area_main',
			locationId: LOC_MAIN,
			name: 'Main Room',
			sort: 0,
			onlineBookable: true,
			guestSelectable: true,
		})

		await db.insert(rsvTables).values([
			{
				id: 'tbl_1',
				locationId: LOC_MAIN,
				areaId: 'area_main',
				label: 'T1',
				minCovers: 1,
				maxCovers: 2,
				onlineBookable: true,
				resetBufferMin: 15,
			},
			{
				id: 'tbl_2',
				locationId: LOC_MAIN,
				areaId: 'area_main',
				label: 'T2',
				minCovers: 1,
				maxCovers: 4,
				onlineBookable: true,
				resetBufferMin: 15,
			},
		])

		await db.insert(rsvServices).values({
			id: 'svc_dinner',
			locationId: LOC_MAIN,
			name: 'Dinner',
			daysMask: 127,
			firstSeatingMin: 17 * 60,
			lastSeatingMin: 21 * 60 + 30,
			endMin: 22 * 60,
			onlineEnabled: true,
			sort: 0,
		})

		seedReservationsContextForTest(ORG_ID, {
			orgId: ORG_ID,
			dataRegion: 'us',
			features: {
				enabled: true,
				online: true,
				waitlist: true,
				experiences: true,
				payments: true,
				voice: false,
			},
			organization: {
				name: 'Acme Bistro',
				slug: 'acme-bistro',
				defaultLocale: 'en',
				locales: ['en'],
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
					name: 'Main',
					slug: 'main',
					timeZone: 'America/New_York',
					address: '100 Main St',
					phone: '+12125550100',
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
				scheduling: false,
				labor: false,
			},
		})
	})

	afterEach(async () => {
		await destroyTenantDb(ORG_ID)
		rmSync(tempDir, { recursive: true, force: true })
	})

	it('GET /book/day returns composite ETag and 304 Not Modified on match, and GET /book/changes tracks dayVersion', async () => {
		const app = buildApp()
		const token = await mintToken()

		const res1 = await app.request(
			`/operator/reservations/book/day?locationId=${LOC_MAIN}&date=${DATE}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		)
		expect(res1.status).toBe(200)
		const etag1 = res1.headers.get('ETag')
		// `.g`: this token reads guest details, which changes what the day says.
		expect(etag1).toBe(`"${LOC_MAIN}:${DATE}:0:1:1.g"`)
		const body1 = (await res1.json()) as {
			dayVersion: number
			settingsVersion: number
			etag: string
		}
		expect(body1.dayVersion).toBe(0)
		expect(body1.settingsVersion).toBe(1)

		// Conditional GET with matching ETag -> 304
		const res304 = await app.request(
			`/operator/reservations/book/day?locationId=${LOC_MAIN}&date=${DATE}`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					'If-None-Match': etag1!,
				},
			},
		)
		expect(res304.status).toBe(304)

		// Conditional GET with short ETag "<dayVersion>.<settingsVersion>.<floorPlanVersion>" -> 304
		const res304Short = await app.request(
			`/operator/reservations/book/day?locationId=${LOC_MAIN}&date=${DATE}`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					'If-None-Match': `"0.1.1.g"`,
				},
			},
		)
		expect(res304Short.status).toBe(304)

		// A floor-plan edit bumps floorPlanVersion, so the old ETag no longer matches.
		const db = await getTenantDb(ORG_ID)
		await db
			.update(rsvLocationSettings)
			.set({ floorPlanVersion: 2 })
			.where(eq(rsvLocationSettings.locationId, LOC_MAIN))
		try {
			const resFloor = await app.request(
				`/operator/reservations/book/day?locationId=${LOC_MAIN}&date=${DATE}`,
				{
					headers: {
						Authorization: `Bearer ${token}`,
						'If-None-Match': etag1!,
					},
				},
			)
			expect(resFloor.status).toBe(200)
			expect(resFloor.headers.get('ETag')).toBe(`"${LOC_MAIN}:${DATE}:0:1:2.g"`)
		} finally {
			await db
				.update(rsvLocationSettings)
				.set({ floorPlanVersion: 1 })
				.where(eq(rsvLocationSettings.locationId, LOC_MAIN))
		}

		// Changes endpoint before mutation
		const chg0 = await app.request(
			`/operator/reservations/book/changes?locationId=${LOC_MAIN}&date=${DATE}&since=0`,
			{ headers: { Authorization: `Bearer ${token}` } },
		)
		expect(chg0.status).toBe(200)
		expect(await chg0.json()).toMatchObject({ dayVersion: 0, changed: false })
	})

	it('keeps guest allergy notes out of every book response unless the caller holds the guest grant', async () => {
		const app = buildApp()
		const token = await mintToken()
		const noGuestGrant = await mintToken({
			grants: [
				RESERVATIONS_PERMISSIONS.READ_RESERVATION,
				RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
			],
		})
		const SECRET = 'sweep-allergy-secret'
		const send = (tok: string, method: string, url: string, body?: unknown) =>
			app.request(`/operator/reservations/book${url}`, {
				method,
				headers: {
					Authorization: `Bearer ${tok}`,
					'Content-Type': 'application/json',
					'Idempotency-Key': `sweep-${Math.random()}`,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			})

		const created = await send(token, 'POST', '/reservations', {
			locationId: LOC_MAIN,
			date: DATE,
			time: '18:30',
			partySize: 2,
			guest: {
				firstName: 'Sweep',
				lastName: 'Guest',
				phone: '+14155550188',
				allergyNotes: SECRET,
			},
		})
		expect(created.status).toBe(201)
		expect(await created.clone().text()).toContain(SECRET)
		const id = ((await created.json()) as any).reservation.id as string

		// Guest lookup: redacted without the grant, full with it, and no tiny queries.
		const lookupNo = await send(noGuestGrant, 'GET', '/guests/lookup?q=Sweep')
		expect(lookupNo.status).toBe(200)
		expect(await lookupNo.text()).not.toContain(SECRET)
		const lookupYes = await send(token, 'GET', '/guests/lookup?q=Sweep')
		expect(await lookupYes.text()).toContain(SECRET)
		const tooShort = await send(token, 'GET', '/guests/lookup?q=S')
		expect(tooShort.status).toBe(400)
		const empty = await send(token, 'GET', '/guests/lookup')
		expect(empty.status).toBe(400)

		// Every mutation response is redacted without the grant.
		const calls: Array<[string, string, unknown]> = [
			['POST', `/reservations/${id}/status`, { status: 'confirmed' }],
			['PATCH', `/reservations/${id}`, { staffNotes: 'hello' }],
			['POST', `/reservations/${id}/assign`, { tableIds: ['tbl_1'] }],
			[
				'POST',
				`/reservations/${id}/contact-status`,
				{ contactStatus: 'left_message' },
			],
			['POST', `/reservations/${id}/running-late`, { runningLateNote: 'soon' }],
			['POST', `/reservations/${id}/notes`, { internalNotes: 'note' }],
		]
		for (const [method, url, body] of calls) {
			const res = await send(noGuestGrant, method, url, body)
			const text = await res.text()
			expect(text, `${method} ${url} -> ${res.status}`).not.toContain(SECRET)
		}
		// With the grant a mutation keeps the notes.
		const yes = await send(token, 'POST', `/reservations/${id}/notes`, {
			internalNotes: 'again',
		})
		expect(yes.status).toBe(200)
		expect(await yes.text()).toContain(SECRET)

		// Nor can they overwrite or clear the health notes they cannot see.
		for (const [method, url] of [
			['POST', `/reservations/${id}/notes`],
			['PATCH', `/reservations/${id}`],
		] as const) {
			const res = await send(noGuestGrant, method, url, { dietaryNotes: null })
			expect(res.status, `${method} ${url}`).toBe(403)
			expect(((await res.json()) as { error: string }).error).toBe(
				'guest_permission_required',
			)
		}
		const kept = await send(token, 'POST', `/reservations/${id}/notes`, {
			dietaryNotes: 'No sesame',
		})
		expect(kept.status).toBe(200)
	})

	it('creates booking via POST /book/reservations, transitions status, supports undo, and enforces expectedVersion (409 stale_version)', async () => {
		const app = buildApp()
		const token = await mintToken()

		// Create booking
		const createRes = await app.request(
			'/operator/reservations/book/reservations',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
					'Idempotency-Key': 'route-idem-1',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					date: DATE,
					time: '18:30',
					partySize: 2,
					guest: {
						firstName: 'Clara',
						lastName: 'Vance',
						phone: '+14155550177',
					},
				}),
			},
		)
		expect(createRes.status).toBe(201)
		const created = (await createRes.json()) as {
			reservation: { id: string; version: number; status: string }
		}
		expect(created.reservation.status).toBe('booked')
		const rsvId = created.reservation.id

		// Stale expectedVersion on PATCH -> 409 stale_version
		const stalePatch = await app.request(
			`/operator/reservations/book/reservations/${rsvId}`,
			{
				method: 'PATCH',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					partySize: 3,
					expectedVersion: 999,
				}),
			},
		)
		expect(stalePatch.status).toBe(409)
		const staleBody = (await stalePatch.json()) as { error: string }
		expect(staleBody.error).toBe('stale_version')

		// Transition booked -> seated -> finished, then undo finished -> seated
		const seatRes = await app.request(
			`/operator/reservations/book/reservations/${rsvId}/status`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					status: 'seated',
					expectedVersion: created.reservation.version,
				}),
			},
		)
		expect(seatRes.status).toBe(200)
		const seated = (await seatRes.json()) as {
			reservation: { version: number; status: string }
		}
		expect(seated.reservation.status).toBe('seated')

		const finRes = await app.request(
			`/operator/reservations/book/reservations/${rsvId}/status`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					status: 'finished',
					expectedVersion: seated.reservation.version,
				}),
			},
		)
		expect(finRes.status).toBe(200)
		const finished = (await finRes.json()) as {
			reservation: { version: number; status: string }
		}
		expect(finished.reservation.status).toBe('finished')

		const undoRes = await app.request(
			`/operator/reservations/book/reservations/${rsvId}/undo`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					expectedVersion: finished.reservation.version,
				}),
			},
		)
		expect(undoRes.status).toBe(200)
		const undone = (await undoRes.json()) as {
			reservation: { status: string }
		}
		expect(undone.reservation.status).toBe('seated')
	})

	it('enforces guest export sensitive grant (VAL-GUEST-021, VAL-GUEST-022) and guest erase (VAL-BOOK-027, VAL-GUEST-025)', async () => {
		const app = buildApp()
		const db = await getTenantDb(ORG_ID)
		const now = Date.now()
		await db.insert(rsvGuests).values({
			id: 'gst_export_1',
			firstName: 'Diana',
			lastName: 'Prince',
			phoneE164: '+14155550188',
			emailNorm: 'diana@example.com',
			allergyNotes: 'contract-allergy-export-secret',
			createdAt: now,
			updatedAt: now,
		})

		const readOnlyGuestToken = await mintToken({
			scope: 'guests',
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST],
		})
		const fullGuestToken = await mintToken({
			scope: 'guests',
			grants: [
				RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
				RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
			],
		})

		// Default export omits sensitive allergyNotes
		const expDefault = await app.request(
			'/operator/reservations/guests/gst_export_1/export',
			{ headers: { Authorization: `Bearer ${readOnlyGuestToken}` } },
		)
		expect(expDefault.status).toBe(200)
		const expDefaultText = await expDefault.text()
		expect(expDefaultText).not.toContain('contract-allergy-export-secret')

		// Read-only guest token requesting includeSensitive=1 -> 403
		const expForbidden = await app.request(
			'/operator/reservations/guests/gst_export_1/export?includeSensitive=1',
			{ headers: { Authorization: `Bearer ${readOnlyGuestToken}` } },
		)
		expect(expForbidden.status).toBe(403)

		// Update guest token requesting includeSensitive=1 -> 200 with allergyNotes
		const expAllowed = await app.request(
			'/operator/reservations/guests/gst_export_1/export?includeSensitive=1',
			{ headers: { Authorization: `Bearer ${fullGuestToken}` } },
		)
		expect(expAllowed.status).toBe(200)
		const expAllowedText = await expAllowed.text()
		expect(expAllowedText).toContain('contract-allergy-export-secret')

		// Check audit log for guest.export: 2 rows (default + allowed), none for forbidden, no PII
		const exportAudits = await db
			.select()
			.from(rsvAuditLog)
			.where(eq(rsvAuditLog.action, 'guest.export'))
			.all()
		expect(exportAudits).toHaveLength(2)
		for (const row of exportAudits) {
			expect(JSON.stringify(row.changes)).not.toContain('Diana')
			expect(JSON.stringify(row.changes)).not.toContain('contract-allergy')
		}

		// Erase guest -> 200
		const eraseRes = await app.request(
			'/operator/reservations/guests/gst_export_1/erase',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${fullGuestToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({}),
			},
		)
		expect(eraseRes.status).toBe(200)
		const erasedGuest = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, 'gst_export_1'))
			.get()
		expect(erasedGuest?.firstName).toBe('Erased')
		expect(erasedGuest?.lastName).toBe('guest')
		expect(erasedGuest?.phoneE164).toBeNull()
		expect(erasedGuest?.allergyNotes).toBeNull()
	})

	it('POST /internal/reservations/summary returns counts only with no PII', async () => {
		const app = buildApp()
		const res = await app.request('/internal/reservations/summary', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${INTERNAL_SECRET}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ orgId: ORG_ID }),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body).toMatchObject({
			reservations: expect.any(Number),
			upcomingReservations: expect.any(Number),
			guests: expect.any(Number),
			tables: 2,
			auditEntries: expect.any(Number),
		})
	})

	it('never echoes rejected input values in 400 validation errors', async () => {
		const app = buildApp()
		const token = await mintToken()
		const marker = 'BAD_DATE_MARKER_99999'

		const res = await app.request(
			`/operator/reservations/book/day?locationId=${LOC_MAIN}&date=${marker}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		)
		expect(res.status).toBe(400)
		const text = await res.text()
		expect(text).not.toContain(marker)
	})

	it('supports walk-ins, assign/lock/swap/reflow, contact/late/course/notes, calendar, overview allergy redaction, service-notes, and section assignments', async () => {
		const app = buildApp()
		const token = await mintToken()
		const noGuestGrantToken = await mintToken({
			grants: [
				RESERVATIONS_PERMISSIONS.READ_RESERVATION,
				RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
			],
		})

		// 1. Staff availability with pacing warnings
		const availRes = await app.request(
			`/operator/reservations/book/availability?locationId=${LOC_MAIN}&date=${DATE}&partySize=2`,
			{ headers: { Authorization: `Bearer ${token}` } },
		)
		expect(availRes.status).toBe(200)
		const availBody = (await availRes.json()) as {
			slots: Array<{ slotLocal: string }>
		}
		expect(availBody.slots.length).toBeGreaterThan(0)

		// 2. Create two bookings and swap their tables via POST /reservations/:id/assign
		const r1Res = await app.request(
			'/operator/reservations/book/reservations',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
					'Idempotency-Key': 'idem-book-test-r1',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					businessDate: DATE,
					slotLocal: '19:00',
					partySize: 2,
					tableIds: ['tbl_1'],
					guest: { firstName: 'Grace', allergyNotes: 'Peanut allergy' },
					dietaryNotes: 'No peanuts',
				}),
			},
		)
		expect(r1Res.status).toBe(201)
		const r1 = ((await r1Res.json()) as any).reservation

		const r2Res = await app.request(
			'/operator/reservations/book/reservations',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
					'Idempotency-Key': 'idem-book-test-r2',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					businessDate: DATE,
					slotLocal: '19:00',
					partySize: 2,
					tableIds: ['tbl_2'],
					guest: { firstName: 'Hank' },
				}),
			},
		)
		expect(r2Res.status).toBe(201)
		const r2 = ((await r2Res.json()) as any).reservation

		// Swap r1 and r2
		const swapRes = await app.request(
			`/operator/reservations/book/reservations/${r1.id}/assign`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					expectedVersion: r1.version,
					swapWithReservationId: r2.id,
					lock: true,
				}),
			},
		)
		expect(swapRes.status).toBe(200)
		const swapped = ((await swapRes.json()) as any).reservation
		expect(swapped.tableIds).toEqual(['tbl_2'])
		expect(swapped.tableLocked).toBe(true)

		// Unlock r1
		const unlockRes = await app.request(
			`/operator/reservations/book/reservations/${r1.id}/assign`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					expectedVersion: swapped.version,
					unlock: true,
				}),
			},
		)
		expect(unlockRes.status).toBe(200)
		const unlocked = ((await unlockRes.json()) as any).reservation
		expect(unlocked.tableLocked).toBe(false)

		// 3. Contact, running-late, course, notes endpoints
		const contactRes = await app.request(
			`/operator/reservations/book/reservations/${r1.id}/contact`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					expectedVersion: unlocked.version,
					contactStatus: 'confirmed',
				}),
			},
		)
		expect(contactRes.status).toBe(200)
		const afterContact = ((await contactRes.json()) as any).reservation
		expect(afterContact.contactStatus).toBe('confirmed')

		const lateRes = await app.request(
			`/operator/reservations/book/reservations/${r1.id}/running-late`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					expectedVersion: afterContact.version,
					runningLateMinutes: 15,
				}),
			},
		)
		expect(lateRes.status).toBe(200)
		const afterLate = ((await lateRes.json()) as any).reservation
		expect(afterLate.runningLateMinutes).toBe(15)

		// Create a walk-in (starts in seated status) and tag its course progress
		const walkInRes = await app.request(
			'/operator/reservations/book/walk-ins',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
					'Idempotency-Key': 'idem-book-test-walkin',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					businessDate: DATE,
					slotLocal: '21:15',
					partySize: 2,
					tableIds: ['tbl_1'],
					guest: { firstName: 'Henry' },
				}),
			},
		)
		expect(walkInRes.status).toBe(201)
		const walkIn = ((await walkInRes.json()) as any).reservation
		expect(walkIn.status).toBe('seated')

		const courseRes = await app.request(
			`/operator/reservations/book/reservations/${walkIn.id}/course`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					expectedVersion: walkIn.version,
					courseStatus: 'mains',
				}),
			},
		)
		expect(courseRes.status).toBe(200)
		const afterCourse = ((await courseRes.json()) as any).reservation
		expect(afterCourse.courseStatus).toBe('mains')

		const notesRes = await app.request(
			`/operator/reservations/book/reservations/${r1.id}/notes`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					expectedVersion: afterLate.version,
					staffNotes: 'Window seat requested',
				}),
			},
		)
		expect(notesRes.status).toBe(200)
		const afterNotes = ((await notesRes.json()) as any).reservation
		expect(afterNotes.staffNotes).toBe('Window seat requested')

		// 4. Calendar summary
		const calRes = await app.request(
			`/operator/reservations/book/calendar?locationId=${LOC_MAIN}&month=${DATE.slice(0, 7)}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		)
		expect(calRes.status).toBe(200)
		const calBody = (await calRes.json()) as {
			days: Array<{ date: string; totalBookings: number }>
		}
		const daySummary = calBody.days.find((d) => d.date === DATE)
		expect(daySummary?.totalBookings).toBe(3)

		// 5. Pre-service overview redacts allergy text without read:reservation_guest:any
		const ovRedactedRes = await app.request(
			`/operator/reservations/book/overview?locationId=${LOC_MAIN}&date=${DATE}`,
			{ headers: { Authorization: `Bearer ${noGuestGrantToken}` } },
		)
		expect(ovRedactedRes.status).toBe(200)
		const ovRedacted = (await ovRedactedRes.json()) as {
			allergyList: Array<{
				hasAllergy: boolean
				dietaryNotes: string | null
				allergyNotes: string | null
			}>
		}
		expect(ovRedacted.allergyList).toHaveLength(1)
		expect(ovRedacted.allergyList[0]?.hasAllergy).toBe(true)
		expect(ovRedacted.allergyList[0]?.dietaryNotes).toBeNull()
		expect(ovRedacted.allergyList[0]?.allergyNotes).toBeNull()

		const ovFullRes = await app.request(
			`/operator/reservations/book/overview?locationId=${LOC_MAIN}&date=${DATE}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		)
		expect(ovFullRes.status).toBe(200)
		const ovFull = (await ovFullRes.json()) as {
			allergyList: Array<{
				hasAllergy: boolean
				dietaryNotes: string | null
				allergyNotes: string | null
			}>
		}
		expect(ovFull.allergyList[0]?.dietaryNotes).toBe('No peanuts')
		expect(ovFull.allergyList[0]?.allergyNotes).toBe('Peanut allergy')

		// 6. Service notes GET/PUT
		const putNotesRes = await app.request(
			'/operator/reservations/book/service-notes',
			{
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					date: DATE,
					serviceId: 'svc_dinner',
					notes: '86 halibut tonight',
				}),
			},
		)
		expect(putNotesRes.status).toBe(200)

		const getNotesRes = await app.request(
			`/operator/reservations/book/service-notes?locationId=${LOC_MAIN}&date=${DATE}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		)
		expect(getNotesRes.status).toBe(200)
		const notesJson = (await getNotesRes.json()) as {
			serviceNotes: Array<{ notes: string }>
		}
		expect(notesJson.serviceNotes[0]?.notes).toBe('86 halibut tonight')

		// 7. Section layouts CRUD (VAL-HOST-018, VAL-HOST-019) & section assignments (VAL-HOST-020)
		const setupToken = await mintToken({ scope: 'setup' })
		const dupLayoutRes = await app.request(
			'/operator/reservations/setup/sections/layouts',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${setupToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					name: 'Dup Layout',
					sections: [
						{ name: 'Sec A', colorToken: '1', tableIds: ['tbl_1'] },
						{ name: 'Sec B', colorToken: '2', tableIds: ['tbl_1'] },
					],
				}),
			},
		)
		expect(dupLayoutRes.status).toBe(409)
		expect(((await dupLayoutRes.json()) as any).error).toBe(
			'table_in_multiple_sections',
		)

		const createLayoutRes = await app.request(
			'/operator/reservations/setup/sections/layouts',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${setupToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					name: 'Dinner 2-Server',
					sections: [
						{ name: 'Section A', colorToken: '1', tableIds: ['tbl_1'] },
						{ name: 'Section B', colorToken: '2', tableIds: ['tbl_2'] },
					],
				}),
			},
		)
		expect(createLayoutRes.status).toBe(201)
		const createdLayout = ((await createLayoutRes.json()) as any).layout
		expect(createdLayout.sections).toHaveLength(2)

		const secAId = createdLayout.sections[0].id
		const secBId = createdLayout.sections[1].id

		const putAssignRes = await app.request(
			'/operator/reservations/book/sections/assignments',
			{
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					date: DATE,
					serviceId: 'svc_dinner',
					layoutId: createdLayout.id,
					assignments: [
						{ sectionId: secAId, serverLabel: 'Samir' },
						{ sectionId: secBId, staffId: 'stf_demo_1', serverLabel: 'Nadia' },
					],
				}),
			},
		)
		expect(putAssignRes.status).toBe(200)
		const assignedJson = (await putAssignRes.json()) as {
			assignments: Array<{
				sectionId: string
				staffId: string | null
				serverLabel: string | null
			}>
		}
		expect(assignedJson.assignments).toHaveLength(2)
	})

	it('satisfies scrutiny findings: location-summary schema, book/conflicts, reservations/:id/events, seated covers propagation, contact/course-status routes & enabled flags, auto_reassigned events, and service-notes expectedVersion', async () => {
		const token = await mintToken()
		const app = buildApp()
		const db = await getTenantDb(ORG_ID)

		// 1. Create a booking on tbl_1 (soft) for 2 guests
		const createRes = await app.request(
			'/operator/reservations/book/reservations',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
					'Idempotency-Key': 'scrutiny-idem-1',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					date: DATE,
					time: '19:00',
					partySize: 2,
					guest: {
						firstName: 'Tariq',
						lastName: 'Mansour',
						phone: '+14155550177',
					},
				}),
			},
		)
		expect(createRes.status).toBe(201)
		const created = ((await createRes.json()) as any).reservation

		// 2. POST /internal/reservations/location-summary returns locationReservationsSummarySchema shape (VAL-BOOK-031)
		const locSummaryRes = await app.request(
			'/internal/reservations/location-summary',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${INTERNAL_SECRET}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					orgId: ORG_ID,
					locationId: LOC_MAIN,
				}),
			},
		)
		expect(locSummaryRes.status).toBe(200)
		const locSummary = (await locSummaryRes.json()) as {
			ok: boolean
			orgId: string
			region: string
			locationId: string
			futureReservations: number
			activeWaitlist: number
			activeHolds: number
			tables: number
		}
		expect(locSummary.ok).toBe(true)
		expect(locSummary.locationId).toBe(LOC_MAIN)
		expect(typeof locSummary.futureReservations).toBe('number')
		expect(locSummary.futureReservations).toBeGreaterThanOrEqual(1)
		expect(typeof locSummary.tables).toBe('number')

		// Empty location returns futureReservations === 0
		const emptyLocSummaryRes = await app.request(
			'/internal/reservations/location-summary',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${INTERNAL_SECRET}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					orgId: ORG_ID,
					locationId: LOC_OTHER,
				}),
			},
		)
		expect(emptyLocSummaryRes.status).toBe(200)
		const emptyLocSummary = (await emptyLocSummaryRes.json()) as {
			locationId: string
			futureReservations: number
		}
		expect(emptyLocSummary.locationId).toBe(LOC_OTHER)
		expect(emptyLocSummary.futureReservations).toBe(0)

		// 3. Soft reflow emits type = 'auto_reassigned' event (VAL-HOST-008)
		// Create a second booking explicitly locked onto tbl_1 at 19:00 so soft booking on tbl_1 reflows to tbl_2
		const lockCreateRes = await app.request(
			'/operator/reservations/book/reservations',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
					'Idempotency-Key': 'scrutiny-idem-2',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					date: DATE,
					time: '19:00',
					partySize: 2,
					tableIds: ['tbl_1'],
					locked: true,
					guest: {
						firstName: 'Locked',
						lastName: 'VIP',
						phone: '+14155550178',
					},
				}),
			},
		)
		expect(lockCreateRes.status).toBe(201)

		// 4. GET /operator/reservations/book/reservations/:id/events returns chronological events including auto_reassigned (VAL-BOOK-013, VAL-HOST-008)
		const eventsRes = await app.request(
			`/operator/reservations/book/reservations/${created.id}/events`,
			{
				headers: { Authorization: `Bearer ${token}` },
			},
		)
		expect(eventsRes.status).toBe(200)
		const eventsBody = (await eventsRes.json()) as {
			events: Array<{
				type: string
				data: { fromTableIds?: string[]; toTableIds?: string[] } | null
			}>
		}
		expect(eventsBody.events.map((e) => e.type)).toContain('auto_reassigned')

		// 5. GET /operator/reservations/book/conflicts?locationId=&date= (VAL-BOOK-012)
		const conflictsRes = await app.request(
			`/operator/reservations/book/conflicts?locationId=${LOC_MAIN}&date=${DATE}`,
			{
				headers: { Authorization: `Bearer ${token}` },
			},
		)
		expect(conflictsRes.status).toBe(200)
		const conflictsJson = (await conflictsRes.json()) as {
			unassigned: unknown[]
			conflicts: unknown[]
		}
		expect(Array.isArray(conflictsJson.unassigned)).toBe(true)
		expect(Array.isArray(conflictsJson.conflicts)).toBe(true)

		// 6. Contact status via /contact-status route & contact_statuses_enabled enforcement (VAL-BOOK-022)
		const detail1Res = await app.request(
			`/operator/reservations/book/reservations/${created.id}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		)
		const curV1 = ((await detail1Res.json()) as any).reservation.version
		const contactRouteRes = await app.request(
			`/operator/reservations/book/reservations/${created.id}/contact-status`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					status: 'confirmed',
					expectedVersion: curV1,
				}),
			},
		)
		expect(contactRouteRes.status).toBe(200)
		expect(
			((await contactRouteRes.json()) as any).reservation.contactStatus,
		).toBe('confirmed')

		// Disable contact_statuses_enabled -> 409
		await db
			.update(rsvLocationSettings)
			.set({ contactStatusesEnabled: false })
			.where(eq(rsvLocationSettings.locationId, LOC_MAIN))

		const disabledContactRes = await app.request(
			`/operator/reservations/book/reservations/${created.id}/contact-status`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ status: 'left_message' }),
			},
		)
		expect(disabledContactRes.status).toBe(409)

		await db
			.update(rsvLocationSettings)
			.set({ contactStatusesEnabled: true })
			.where(eq(rsvLocationSettings.locationId, LOC_MAIN))

		// 7. Seating with { status: 'seated', covers: 4, expectedVersion } writes covers_actual=4 and increments rsv_guests.covers by 4 (VAL-BOOK-017)
		const detail2Res = await app.request(
			`/operator/reservations/book/reservations/${created.id}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		)
		const curV2 = ((await detail2Res.json()) as any).reservation.version
		const seatRes = await app.request(
			`/operator/reservations/book/reservations/${created.id}/status`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					status: 'seated',
					covers: 4,
					expectedVersion: curV2,
				}),
			},
		)
		expect(seatRes.status).toBe(200)
		const seatedRsv = ((await seatRes.json()) as any).reservation
		expect(seatedRsv.coversActual).toBe(4)
		expect(seatedRsv.seatedCovers).toBe(4)

		// 8. Course status via /course-status route & course_statuses_enabled enforcement (VAL-BOOK-023)
		const courseRouteRes = await app.request(
			`/operator/reservations/book/reservations/${created.id}/course-status`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					course: 'starters',
					expectedVersion: seatedRsv.version,
				}),
			},
		)
		expect(courseRouteRes.status).toBe(200)
		const afterCourseRsv = ((await courseRouteRes.json()) as any).reservation
		expect(afterCourseRsv.courseStatus).toBe('starters')

		// Disable course_statuses_enabled -> 409
		await db
			.update(rsvLocationSettings)
			.set({ courseStatusesEnabled: false })
			.where(eq(rsvLocationSettings.locationId, LOC_MAIN))

		const disabledCourseRes = await app.request(
			`/operator/reservations/book/reservations/${created.id}/course-status`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ course: 'dessert' }),
			},
		)
		expect(disabledCourseRes.status).toBe(409)

		await db
			.update(rsvLocationSettings)
			.set({ courseStatusesEnabled: true })
			.where(eq(rsvLocationSettings.locationId, LOC_MAIN))

		// Finish reservation and verify guest.covers == 4
		const finishRes = await app.request(
			`/operator/reservations/book/reservations/${created.id}/status`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					status: 'finished',
					expectedVersion: afterCourseRsv.version,
				}),
			},
		)
		expect(finishRes.status).toBe(200)
		const guestRow = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, created.guestId))
			.get()
		expect(guestRow?.covers).toBe(4)

		// 9. upsertServiceNotes enforces expectedVersion (409 stale_version)
		const note1Res = await app.request(
			'/operator/reservations/book/service-notes',
			{
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					date: DATE,
					serviceId: 'svc_dinner',
					body: 'First note',
				}),
			},
		)
		expect(note1Res.status).toBe(200)

		const staleNoteRes = await app.request(
			'/operator/reservations/book/service-notes',
			{
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: LOC_MAIN,
					date: DATE,
					serviceId: 'svc_dinner',
					body: 'Stale note',
					expectedVersion: 99,
				}),
			},
		)
		expect(staleNoteRes.status).toBe(409)
	})

	describe('day feed and seating (foh-core UT fixes)', () => {
		async function post(
			app: ReturnType<typeof buildApp>,
			token: string,
			url: string,
			body: unknown,
			headers: Record<string, string> = {},
		) {
			return app.request(`/operator/reservations/book${url}`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
					...headers,
				},
				body: JSON.stringify(body),
			})
		}

		async function book(
			app: ReturnType<typeof buildApp>,
			token: string,
			key: string,
			extra: Record<string, unknown>,
		) {
			const res = await post(
				app,
				token,
				'/reservations',
				{
					locationId: LOC_MAIN,
					date: DATE,
					time: '19:00',
					partySize: 2,
					guest: {
						firstName: key,
						lastName: 'Guest',
						phone: `+1415555${String(Math.abs(hash(key)))
							.slice(0, 4)
							.padStart(4, '0')}`,
					},
					...extra,
				},
				{ 'Idempotency-Key': key },
			)
			expect(res.status).toBe(201)
			return ((await res.json()) as any).reservation as {
				id: string
				version: number
			}
		}

		function hash(value: string) {
			let h = 0
			for (const ch of value) h = (h * 31 + ch.charCodeAt(0)) | 0
			return h
		}

		async function getDay(
			app: ReturnType<typeof buildApp>,
			token: string,
			query = '',
			headers: Record<string, string> = {},
		) {
			return app.request(
				`/operator/reservations/book/day?locationId=${LOC_MAIN}&date=${DATE}${query}`,
				{ headers: { Authorization: `Bearer ${token}`, ...headers } },
			)
		}

		it('day feed gives a host token coded dietary values and the allergy flag, but never free text or guest notes', async () => {
			const app = buildApp()
			const full = await mintToken()
			const hostToken = await mintToken({
				grants: [
					RESERVATIONS_PERMISSIONS.READ_RESERVATION,
					RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
				],
			})
			const coded = await book(app, full, 'allergy-coded', {
				dietaryNotes: 'nut_allergy, vegan',
				time: '17:00',
			})
			const free = await book(app, full, 'allergy-free-text', {
				dietaryNotes: 'Severe peanut reaction, carries EpiPen',
				time: '19:00',
			})
			const plain = await book(app, full, 'allergy-none', { time: '21:00' })

			const res = await getDay(app, hostToken)
			expect(res.status).toBe(200)
			const body = (await res.json()) as {
				reservations: Array<{
					id: string
					allergyFlag: boolean
					hasAllergy: boolean
					dietaryCodes: string[]
					dietaryNotes: string | null
				}>
			}
			const byId = new Map(body.reservations.map((r) => [r.id, r]))
			expect(byId.get(coded.id)?.allergyFlag).toBe(true)
			expect(byId.get(coded.id)?.dietaryCodes).toEqual(['nut_allergy', 'vegan'])
			expect(byId.get(coded.id)?.dietaryNotes).toBeNull()
			expect(byId.get(free.id)?.allergyFlag).toBe(true)
			expect(byId.get(free.id)?.dietaryCodes).toEqual([])
			expect(byId.get(free.id)?.dietaryNotes).toBeNull()
			expect(byId.get(plain.id)?.allergyFlag).toBe(false)
			expect(JSON.stringify(body)).not.toContain('EpiPen')

			const fullBody = (await (await getDay(app, full)).json()) as typeof body
			expect(
				fullBody.reservations.find((r) => r.id === free.id)?.dietaryNotes,
			).toContain('EpiPen')
		})

		it('an allergen chip written as dietary text flags the day feed, and an update that removes it clears the flag', async () => {
			const app = buildApp()
			const full = await mintToken()
			const hostToken = await mintToken({
				grants: [
					RESERVATIONS_PERMISSIONS.READ_RESERVATION,
					RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
				],
			})
			// What the booking sheet sends: chip codes, then the typed words.
			const created = await book(app, full, 'chip-roundtrip', {
				dietaryNotes: 'nut_allergy, vegan, No sesame',
			})
			const flagFor = async () => {
				const res = await getDay(app, hostToken)
				const body = (await res.json()) as {
					reservations: Array<{
						id: string
						allergyFlag: boolean
						dietaryCodes: string[]
					}>
				}
				return body.reservations.find((r) => r.id === created.id)!
			}
			expect(await flagFor()).toMatchObject({
				allergyFlag: true,
				dietaryCodes: ['nut_allergy', 'vegan'],
			})
			const patch = await app.request(
				`/operator/reservations/book/reservations/${created.id}`,
				{
					method: 'PATCH',
					headers: {
						Authorization: `Bearer ${full}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ dietaryNotes: 'vegan, No sesame' }),
				},
			)
			expect(patch.status).toBe(200)
			const after = await flagFor()
			expect(after.dietaryCodes).toEqual(['vegan'])
			expect(after.allergyFlag).toBe(true) // free text still counts as an allergy note
			const cleared = await app.request(
				`/operator/reservations/book/reservations/${created.id}`,
				{
					method: 'PATCH',
					headers: {
						Authorization: `Bearer ${full}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ dietaryNotes: null }),
				},
			)
			expect(cleared.status).toBe(200)
			expect(await flagFor()).toMatchObject({
				allergyFlag: false,
				dietaryCodes: [],
			})
		})

		it('seats from arrived with tableIds: writes an active occupancy row, shows the table in the day feed, and 409s when the table is taken (VAL-HOST-014)', async () => {
			const app = buildApp()
			const token = await mintToken()
			const db = await getTenantDb(ORG_ID)

			const walkIn = await book(app, token, 'seat-a', { time: '18:00' })
			const arrivedRes = await post(
				app,
				token,
				`/reservations/${walkIn.id}/status`,
				{ status: 'arrived', expectedVersion: walkIn.version },
			)
			expect(arrivedRes.status).toBe(200)
			const arrived = ((await arrivedRes.json()) as any).reservation
			// Release any table auto-assignment so the seat call must assign.
			await db
				.update(rsvTableOccupancies)
				.set({ active: false })
				.where(eq(rsvTableOccupancies.reservationId, walkIn.id))

			const seatRes = await post(
				app,
				token,
				`/reservations/${walkIn.id}/status`,
				{
					status: 'seated',
					expectedVersion: arrived.version,
					tableIds: ['tbl_2'],
				},
			)
			expect(seatRes.status).toBe(200)
			expect(((await seatRes.json()) as any).reservation.status).toBe('seated')

			const occRows = await db
				.select()
				.from(rsvTableOccupancies)
				.where(
					and(
						eq(rsvTableOccupancies.reservationId, walkIn.id),
						eq(rsvTableOccupancies.active, true),
					),
				)
				.all()
			expect(occRows.map((o) => o.tableId)).toEqual(['tbl_2'])
			expect(occRows[0]!.kind).toBe('reservation')

			const dayBody = (await (await getDay(app, token)).json()) as any
			const row = dayBody.reservations.find((r: any) => r.id === walkIn.id)
			expect(row.status).toBe('seated')
			expect(row.tableIds).toEqual(['tbl_2'])

			// A second party cannot be seated at the same table in the same window.
			const other = await book(app, token, 'seat-b', { time: '18:00' })
			const otherArrivedRes = await post(
				app,
				token,
				`/reservations/${other.id}/status`,
				{ status: 'arrived', expectedVersion: other.version },
			)
			const otherArrived = ((await otherArrivedRes.json()) as any).reservation
			const conflictRes = await post(
				app,
				token,
				`/reservations/${other.id}/status`,
				{
					status: 'seated',
					expectedVersion: otherArrived.version,
					tableIds: ['tbl_2'],
				},
			)
			expect(conflictRes.status).toBe(409)
			const after = (await (await getDay(app, token)).json()) as any
			expect(
				after.reservations.find((r: any) => r.id === other.id).status,
			).toBe('arrived')
		})

		it('filters the day feed by serviceId, areaId, source and tag, returns { parties, covers } counters and a per-query ETag (VAL-BOOK-008/009)', async () => {
			const app = buildApp()
			const token = await mintToken()
			const db = await getTenantDb(ORG_ID)

			const phone = await book(app, token, 'flt-phone', {
				channel: 'phone',
				partySize: 3,
				time: '18:00',
			})
			await book(app, token, 'flt-online', {
				channel: 'online',
				partySize: 2,
				time: '18:30',
			})
			await db.insert(rsvServices).values({
				id: 'svc_lunch',
				locationId: LOC_MAIN,
				name: 'Lunch',
				daysMask: 127,
				firstSeatingMin: 11 * 60,
				lastSeatingMin: 14 * 60,
				endMin: 15 * 60,
				onlineEnabled: true,
				sort: 1,
			})
			await book(app, token, 'flt-early', {
				channel: 'host',
				serviceId: 'svc_lunch',
				partySize: 4,
				time: '12:00',
			})

			await db.insert(rsvTags).values({
				id: 'tag_window',
				scope: 'reservation',
				category: 'custom',
				name: 'Window',
			})
			await db
				.insert(rsvReservationTags)
				.values({ reservationId: phone.id, tagId: 'tag_window' })

			const unfilteredRes = await getDay(app, token)
			const unfiltered = (await unfilteredRes.json()) as any
			expect(unfilteredRes.headers.get('ETag')).toBe(
				`"${LOC_MAIN}:${DATE}:${unfiltered.dayVersion}:1:1.g"`,
			)
			expect(unfiltered.counters).toEqual({ parties: 3, covers: 9 })

			const bySource = (await (
				await getDay(app, token, '&source=phone')
			).json()) as any
			expect(bySource.reservations.map((r: any) => r.id)).toEqual([phone.id])
			expect(bySource.counters).toEqual({ parties: 1, covers: 3 })

			const byService = (await (
				await getDay(app, token, '&serviceId=svc_dinner')
			).json()) as any
			expect(byService.counters).toEqual({ parties: 2, covers: 5 })
			const byLunch = (await (
				await getDay(app, token, '&serviceId=svc_lunch')
			).json()) as any
			expect(byLunch.counters).toEqual({ parties: 1, covers: 4 })

			const byArea = (await (
				await getDay(app, token, '&areaId=area_main')
			).json()) as any
			expect(byArea.reservations.length).toBeGreaterThan(0)
			const byOtherArea = (await (
				await getDay(app, token, '&areaId=area_missing')
			).json()) as any
			expect(byOtherArea.counters).toEqual({ parties: 0, covers: 0 })

			const byTag = (await (
				await getDay(app, token, '&tag=Window')
			).json()) as any
			expect(byTag.reservations.map((r: any) => r.id)).toEqual([phone.id])
			expect(byTag.counters).toEqual({ parties: 1, covers: 3 })

			// ETag differs per query and a matching conditional GET returns 304.
			const filteredRes = await getDay(app, token, '&source=phone')
			const filteredEtag = filteredRes.headers.get('ETag')!
			expect(filteredEtag).not.toBe(unfilteredRes.headers.get('ETag'))
			const otherEtag = (
				await getDay(app, token, '&source=online')
			).headers.get('ETag')
			expect(otherEtag).not.toBe(filteredEtag)
			const notModified = await getDay(app, token, '&source=phone', {
				'If-None-Match': filteredEtag,
			})
			expect(notModified.status).toBe(304)
			const crossQuery = await getDay(app, token, '&source=online', {
				'If-None-Match': filteredEtag,
			})
			expect(crossQuery.status).toBe(200)
		})

		it('returns the bare occasion value in occasion and keeps the tag id only in occasionTagId on create, detail, and the day feed', async () => {
			const app = buildApp()
			const token = await mintToken()
			const db = await getTenantDb(ORG_ID)
			await db.insert(rsvTags).values({
				id: 'tag_acme_anniversary',
				scope: 'visit',
				category: 'occasion',
				name: 'Anniversary',
				systemKey: 'anniversary',
			})

			const created = await book(app, token, 'occ-1', {
				occasion: 'anniversary',
			})
			const expected = {
				occasion: 'anniversary',
				occasionTagId: 'tag_acme_anniversary',
			}
			expect(created).toMatchObject(expected)

			const detailRes = await app.request(
				`/operator/reservations/book/reservations/${created.id}`,
				{ headers: { Authorization: `Bearer ${token}` } },
			)
			expect(detailRes.status).toBe(200)
			const detail = (await detailRes.json()) as any
			expect(detail.reservation).toMatchObject(expected)

			const day = (await (await getDay(app, token)).json()) as any
			expect(
				day.reservations.find((r: any) => r.id === created.id),
			).toMatchObject(expected)

			const adHoc = await book(app, token, 'occ-2', { occasion: 'Pre-theatre' })
			expect(adHoc.occasion).toBe('Pre-theatre')
		})

		it('defaults the business date from the location time zone, not the UTC date, on the day, changes, overview, availability, and service-notes routes', async () => {
			const app = buildApp()
			const realNow = Date.now()
			const token = await mintToken()
			const booked = await book(app, token, 'tz-default', { time: '19:00' })

			// 21:00 on DATE in New York is already the next calendar day in UTC.
			const eveningUtcNextDay = Date.UTC(2027, 7, 21, 1, 0, 0)
			vi.useFakeTimers({ toFake: ['Date'], now: eveningUtcNextDay })
			try {
				const eveningToken = await mintToken()
				const get = async (path: string) => {
					const res = await app.request(
						`/operator/reservations/book/${path}${path.includes('?') ? '&' : '?'}locationId=${LOC_MAIN}`,
						{ headers: { Authorization: `Bearer ${eveningToken}` } },
					)
					expect(res.status).toBe(200)
					return (await res.json()) as any
				}

				const day = await get('day')
				expect(day.businessDate).toBe(DATE)
				expect(day.reservations.map((r: any) => r.id)).toContain(booked.id)
				expect((await get('changes')).businessDate).toBe(DATE)
				expect((await get('overview')).date).toBe(DATE)
				expect((await get('availability?partySize=2')).businessDate).toBe(DATE)
				expect((await get('service-notes')).businessDate).toBe(DATE)
			} finally {
				vi.useRealTimers()
				expect(Date.now()).toBeGreaterThanOrEqual(realNow)
			}
		})

		it('includes moveNotices for auto_reassigned bookings and locked bookings displaced by a block as blocked_table conflicts (VAL-CROSS-006)', async () => {
			const app = buildApp()
			const token = await mintToken()
			const db = await getTenantDb(ORG_ID)

			const soft = await book(app, token, 'mv-soft', { time: '19:00' })
			await book(app, token, 'mv-locked', {
				time: '19:00',
				tableIds: ['tbl_1'],
				locked: true,
			})

			const day = (await (await getDay(app, token)).json()) as any
			expect(day.moveNotices.length).toBeGreaterThan(0)
			const notice = day.moveNotices.find(
				(n: any) => n.reservationId === soft.id,
			)
			expect(notice).toMatchObject({
				reservationId: soft.id,
				toTableIds: ['tbl_2'],
			})
			expect(notice.fromTableIds).toEqual(['tbl_1'])
			expect(typeof notice.at).toBe('number')
			expect(day.conflicts).toEqual([])

			const locked = day.reservations.find((r: any) => r.locked === true)
			await db.insert(rsvBlocks).values({
				id: 'blk_displace',
				locationId: LOC_MAIN,
				tableId: 'tbl_1',
				businessDate: DATE,
				startAt: locked.startAt - 15 * 60_000,
				endAt: locked.endAt + 15 * 60_000,
				reason: 'maintenance',
			})

			const after = (await (await getDay(app, token)).json()) as any
			const blocked = after.conflicts.filter(
				(c: any) => c.kind === 'blocked_table',
			)
			expect(blocked).toHaveLength(1)
			expect(blocked[0]).toMatchObject({
				reservationId: locked.id,
				tableIds: ['tbl_1'],
				blockId: 'blk_displace',
			})
		})
	})

	describe('staff availability and booking honour special days, pacing overrides and live holds', () => {
		type Slot = {
			slotLocal: string
			available: boolean
			held: boolean
			heldTableIds: string[]
			suggestedTableIds: string[]
		}

		async function availability(token: string, partySize = 2) {
			const res = await buildApp().request(
				`/operator/reservations/book/availability?locationId=${LOC_MAIN}&date=${DATE}&partySize=${partySize}`,
				{ headers: { Authorization: `Bearer ${token}` } },
			)
			expect(res.status).toBe(200)
			return (await res.json()) as {
				closed: boolean
				onlineClosed: boolean
				dayState: { state: string; name?: string | null }
				slots: Slot[]
			}
		}

		async function bookAt(
			token: string,
			key: string,
			extra: Record<string, unknown> = {},
		) {
			const res = await buildApp().request(
				'/operator/reservations/book/reservations',
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
						'Idempotency-Key': key,
					},
					body: JSON.stringify({
						locationId: LOC_MAIN,
						date: DATE,
						time: '19:00',
						partySize: 2,
						guest: { firstName: key, lastName: 'Guest' },
						...extra,
					}),
				},
			)
			return { status: res.status, body: (await res.json()) as any }
		}

		async function addSpecialDay(kind: 'closed' | 'online_closed') {
			const db = await getTenantDb(ORG_ID)
			await db.insert(rsvSpecialDays).values({
				id: `sp_${kind}`,
				locationId: LOC_MAIN,
				fromDate: DATE,
				toDate: DATE,
				kind,
				name: kind === 'closed' ? 'Private buyout' : 'Phone only',
			})
		}

		it('returns no slots and a closed day state on a closed special day, and refuses a staff booking without an explicit overbook', async () => {
			const token = await mintToken()
			await addSpecialDay('closed')

			const avail = await availability(token)
			expect(avail.slots).toEqual([])
			expect(avail.closed).toBe(true)
			expect(avail.dayState).toMatchObject({
				state: 'closed',
				name: 'Private buyout',
			})

			const refused = await bookAt(token, 'closed-refused')
			expect(refused.status).toBe(409)
			expect(refused.body.error).toBe('closed_day')

			const overridden = await bookAt(token, 'closed-override', {
				overbook: true,
				overbookReason: 'Owner asked for a table',
			})
			expect(overridden.status).toBe(201)
			expect(overridden.body.warnings).toEqual([
				expect.objectContaining({ code: 'closed_day' }),
			])
		})

		it('still offers slots on an online_closed day but flags the day, and a staff booking needs no override', async () => {
			const token = await mintToken()
			await addSpecialDay('online_closed')

			const avail = await availability(token)
			expect(avail.slots.length).toBeGreaterThan(0)
			expect(avail.closed).toBe(false)
			expect(avail.onlineClosed).toBe(true)
			expect(avail.dayState.state).toBe('online_closed')

			const booked = await bookAt(token, 'online-closed-book')
			expect(booked.status).toBe(201)
			expect(booked.body.warnings).toEqual([])
		})

		it('carries a pacing warning when staff overbook past a pacing limit and still refuses without the override', async () => {
			const token = await mintToken()
			const db = await getTenantDb(ORG_ID)
			await db.insert(rsvPacingRules).values({
				id: 'pace_parties',
				serviceId: 'svc_dinner',
				bucketMin: 15,
				maxParties: 1,
				channel: 'all',
			})

			expect((await bookAt(token, 'pace-first')).status).toBe(201)

			const refused = await bookAt(token, 'pace-refused')
			expect(refused.status).toBe(409)
			expect(refused.body.error).toBe('pacing_parties_exceeded')

			const over = await bookAt(token, 'pace-over', {
				overbook: true,
				overbookReason: 'Regular guest',
			})
			expect(over.status).toBe(201)
			expect(over.body.warnings).toEqual([
				expect.objectContaining({ code: 'pacing_parties_exceeded' }),
			])
		})

		it('withholds a slot while a guest hold on every table is live and offers it again after the hold expires', async () => {
			const token = await mintToken()
			const db = await getTenantDb(ORG_ID)
			const startAt = Date.UTC(2027, 7, 20, 23, 0, 0)
			await db.insert(rsvHolds).values({
				id: 'hold_live',
				locationId: LOC_MAIN,
				tokenHash: 'hold-live-token-hash',
				businessDate: DATE,
				localStartMin: 19 * 60,
				startAt,
				endAt: startAt + 90 * 60_000,
				partySize: 2,
				serviceId: 'svc_dinner',
				status: 'active',
				expiresAt: Date.now() + 3 * 60_000,
			})
			for (const tableId of ['tbl_1', 'tbl_2']) {
				await db.insert(rsvTableOccupancies).values({
					id: `occ_hold_${tableId}`,
					locationId: LOC_MAIN,
					tableId,
					kind: 'hold',
					holdId: 'hold_live',
					startAt,
					endAt: startAt + 90 * 60_000,
				})
			}

			const during = await availability(token)
			const held = during.slots.find((s) => s.slotLocal === '19:00')!
			expect(held).toMatchObject({
				available: false,
				held: true,
				suggestedTableIds: [],
			})
			expect(held.heldTableIds.sort()).toEqual(['tbl_1', 'tbl_2'])
			expect(during.slots.find((s) => s.slotLocal === '17:00')).toMatchObject({
				available: true,
				held: false,
			})

			await db
				.update(rsvHolds)
				.set({ status: 'expired', expiresAt: Date.now() - 1_000 })
				.where(eq(rsvHolds.id, 'hold_live'))
			await db
				.update(rsvTableOccupancies)
				.set({ active: false })
				.where(eq(rsvTableOccupancies.holdId, 'hold_live'))

			const after = await availability(token)
			expect(after.slots.find((s) => s.slotLocal === '19:00')).toMatchObject({
				available: true,
				held: false,
			})
		})

		it('ignores a hold whose expiry has passed even before the sweep marks it expired', async () => {
			const token = await mintToken()
			const db = await getTenantDb(ORG_ID)
			const startAt = Date.UTC(2027, 7, 20, 23, 0, 0)
			await db.insert(rsvHolds).values({
				id: 'hold_stale',
				locationId: LOC_MAIN,
				tokenHash: 'hold-stale-token-hash',
				businessDate: DATE,
				localStartMin: 19 * 60,
				startAt,
				endAt: startAt + 90 * 60_000,
				partySize: 2,
				status: 'active',
				expiresAt: Date.now() - 60_000,
			})
			await db.insert(rsvTableOccupancies).values({
				id: 'occ_hold_stale',
				locationId: LOC_MAIN,
				tableId: 'tbl_1',
				kind: 'hold',
				holdId: 'hold_stale',
				startAt,
				endAt: startAt + 90 * 60_000,
			})

			const avail = await availability(token)
			expect(avail.slots.find((s) => s.slotLocal === '19:00')).toMatchObject({
				available: true,
				held: false,
			})
		})
	})
})
