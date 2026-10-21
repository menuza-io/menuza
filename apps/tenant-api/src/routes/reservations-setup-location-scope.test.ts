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
	rsvFloorElements,
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

describe('setup mutations never cross a location boundary', () => {
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

	const base = '/operator/reservations/setup'

	async function call(
		method: string,
		pathName: string,
		body: unknown,
		token: string,
	) {
		const res = await buildApp().request(`${base}${pathName}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		})
		const json = (await res.json()) as any
		return { status: res.status, json }
	}

	async function seed() {
		const admin = await mintToken({ locationIds: null })
		const first = await call(
			'PUT',
			`/locations/${LOC_PATIO_STORE}/floor-plan`,
			{
				areas: [{ id: 'a_other', name: 'Other room' }],
				tables: [
					{ id: 't_other1', areaId: 'a_other', label: 'B1', combinable: true },
					{ id: 't_other2', areaId: 'a_other', label: 'B2', combinable: true },
				],
				combos: [
					{ id: 'c_other', label: 'B1+B2', tableIds: ['t_other1', 't_other2'] },
				],
				elements: [{ id: 'el_other', areaId: 'a_other', kind: 'wall' }],
			},
			admin,
		)
		expect(first.status).toBe(200)
		const mine = await call(
			'PUT',
			`/locations/${LOC_MAIN}/floor-plan`,
			{
				areas: [{ id: 'a_main', name: 'Main room' }],
				tables: [
					{ id: 't_main1', areaId: 'a_main', label: 'A1', combinable: true },
					{ id: 't_main2', areaId: 'a_main', label: 'A2', combinable: true },
				],
			},
			admin,
		)
		expect(mine.status).toBe(200)
		const svc = (loc: string) =>
			call(
				'POST',
				'/services',
				{
					locationId: loc,
					name: 'Dinner',
					daysMask: 127,
					firstSeatingMin: 1000,
					lastSeatingMin: 1200,
					endMin: 1300,
				},
				admin,
			)
		const a = await svc(LOC_MAIN)
		const b = await svc(LOC_PATIO_STORE)
		expect(a.status).toBe(201)
		expect(b.status).toBe(201)
		return {
			restricted: await mintToken({ locationIds: [LOC_MAIN] }),
			svcMain: (a.json.service?.id ?? a.json.id) as string,
			svcOther: (b.json.service?.id ?? b.json.id) as string,
		}
	}

	async function otherLocationSnapshot() {
		const db = await getTenantDb(ORG_ID)
		const settings = await db
			.select()
			.from(rsvLocationSettings)
			.where(eq(rsvLocationSettings.locationId, LOC_PATIO_STORE))
			.get()
		const elements = await db.select().from(rsvFloorElements).all()
		const tables = await db.select().from(rsvTables).all()
		return {
			floorPlanVersion: settings?.floorPlanVersion,
			elements: elements.map((e) => `${e.id}:${e.areaId}`).sort(),
			tables: tables.map((t) => `${t.id}:${t.locationId}:${t.areaId}`).sort(),
		}
	}

	it.each([
		[
			'an element in another location area',
			{ elements: [{ areaId: 'a_other', kind: 'wall' }] },
			'invalid_area',
		],
		[
			'a table in another location area',
			{ tables: [{ areaId: 'a_other', label: 'X1' }] },
			'invalid_area',
		],
		[
			'an existing table moved into another location area',
			{ tables: [{ id: 't_main1', areaId: 'a_other', label: 'A1' }] },
			'invalid_area',
		],
		[
			'another location area id',
			{ areas: [{ id: 'a_other', name: 'Hijacked' }] },
			'invalid_area',
		],
		[
			'another location table id',
			{ tables: [{ id: 't_other1', areaId: 'a_main', label: 'Hijack' }] },
			'invalid_table',
		],
		[
			'another location element id',
			{ elements: [{ id: 'el_other', areaId: 'a_main', kind: 'wall' }] },
			'invalid_element',
		],
		[
			'another location combo id',
			{
				combos: [
					{ id: 'c_other', label: 'Hijack', tableIds: ['t_main1', 't_main2'] },
				],
			},
			'invalid_combination',
		],
		[
			'a combo over another location tables',
			{ combos: [{ label: 'Mix', tableIds: ['t_main1', 't_other1'] }] },
			'invalid_combination_tables',
		],
	])(
		'floor plan save refuses %s and changes nothing',
		async (_name, payload, code) => {
			const { restricted } = await seed()
			const before = await otherLocationSnapshot()
			const res = await call(
				'PUT',
				`/locations/${LOC_MAIN}/floor-plan`,
				payload,
				restricted,
			)
			expect(res.status).toBe(400)
			expect(res.json.error).toBe(code)
			expect(await otherLocationSnapshot()).toEqual(before)
		},
	)

	it('floor plan save still accepts areas, tables and elements of its own location', async () => {
		const { restricted } = await seed()
		const res = await call(
			'PUT',
			`/locations/${LOC_MAIN}/floor-plan`,
			{
				areas: [{ id: 'a_new', name: 'Terrace' }],
				tables: [{ id: 't_new', areaId: 'a_new', label: 'T1' }],
				elements: [{ areaId: 'a_main', kind: 'wall' }],
			},
			restricted,
		)
		expect(res.status).toBe(200)
	})

	it('a table update cannot move the table into another location area', async () => {
		const { restricted } = await seed()
		const before = await otherLocationSnapshot()
		const res = await call(
			'PATCH',
			'/tables/t_main1',
			{ areaId: 'a_other' },
			restricted,
		)
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid_area')
		expect(await otherLocationSnapshot()).toEqual(before)
		const ok = await call(
			'PATCH',
			'/tables/t_main1',
			{ areaId: 'a_main' },
			restricted,
		)
		expect(ok.status).toBe(200)
	})

	it('service availability targets must belong to the service location', async () => {
		const { restricted, svcMain } = await seed()
		for (const [target, code] of [
			[{ areaId: 'a_other' }, 'invalid_area'],
			[{ tableId: 't_other1' }, 'invalid_table'],
			[{ comboId: 'c_other' }, 'invalid_combination'],
		] as const) {
			const res = await call(
				'POST',
				'/service-availability',
				{ serviceId: svcMain, mode: 'unavailable', ...target },
				restricted,
			)
			expect(res.status, JSON.stringify(target)).toBe(400)
			expect(res.json.error).toBe(code)
		}
		const ok = await call(
			'POST',
			'/service-availability',
			{ serviceId: svcMain, mode: 'unavailable', areaId: 'a_main' },
			restricted,
		)
		expect(ok.status).toBe(201)
	})

	it('turn times and special days cannot name another location service', async () => {
		const { restricted, svcMain, svcOther } = await seed()
		const turn = await call(
			'POST',
			'/turn-times',
			{
				locationId: LOC_MAIN,
				serviceId: svcOther,
				partyMin: 1,
				partyMax: 2,
				minutes: 60,
			},
			restricted,
		)
		expect(turn.status).toBe(400)
		expect(turn.json.error).toBe('invalid_service')
		const day = await call(
			'POST',
			'/special-days',
			{
				locationId: LOC_MAIN,
				serviceId: svcOther,
				businessDate: '2031-03-10',
				kind: 'closed',
			},
			restricted,
		)
		expect(day.status).toBe(400)
		expect(day.json.error).toBe('invalid_service')
		const ok = await call(
			'POST',
			'/turn-times',
			{
				locationId: LOC_MAIN,
				serviceId: svcMain,
				partyMin: 1,
				partyMax: 2,
				minutes: 60,
			},
			restricted,
		)
		expect(ok.status).toBe(201)
	})
})
