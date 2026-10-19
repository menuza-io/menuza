import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	RESERVATIONS_PERMISSIONS,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
	restrictGrantsForImpersonation,
} from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	rsvAreas,
	rsvAuditLog,
	rsvDayVersions,
	rsvExperiences,
	rsvLocationSettings,
	rsvPolicies,
	rsvReservations,
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
import { resetPublicRateLimits } from '../lib/reservations-public-auth.ts'
import { clearReservationDayCacheForTest } from '../lib/reservations-write.ts'
import {
	dateAhead,
	PUBLIC_LOC,
	publicContext,
	seedPublicOrg,
	US_ORIGIN,
} from './reservations-public-fixture.ts'
import { reservationsOperatorRoutes } from './reservations-operator.ts'
import { reservationsPublicRoutes } from './reservations-public.ts'

const ORG = 'org_exp_routes'
const OPERATOR_SECRET = 'test-experiences-operator-secret-key-32-chars!!'
const JWT_SECRET = 'test-experiences-customer-jwt-secret-123456'
const BASE = `/operator/reservations/setup/locations/${PUBLIC_LOC}/experiences`
const DAY = dateAhead(10)
const H19 = 19 * 60

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
	resolveOrganizationForPublicOrigin: vi.fn(async (origin?: string) =>
		origin === 'http://acme.menuza.test:3008' ? (orgs.get(ORG) ?? null) : null,
	),
}))

let tempDir: string
const app = new Hono()
app.route('/reservations', reservationsPublicRoutes)
app.route('/operator/reservations', reservationsOperatorRoutes)

type Mint = {
	grants?: string[]
	impersonated?: boolean
	locationIds?: string[] | null
	experiences?: boolean
}

async function mint(options: Mint = {}) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({
		role: 'operator',
		orgId: ORG,
		region: 'us',
		scope: 'setup',
		grants:
			options.grants ??
			restrictGrantsForImpersonation(
				[
					RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
					RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
				],
				options.impersonated ?? false,
			),
		locationIds: options.locationIds ?? null,
		features: {
			enabled: true,
			online: true,
			waitlist: true,
			experiences: options.experiences ?? true,
			payments: false,
			voice: false,
		},
		impersonated: options.impersonated ?? false,
	})
		.setProtectedHeader({ alg: 'HS256', typ: RESERVATIONS_TOKEN_TYP })
		.setSubject('usr_exp_operator')
		.setIssuer(brand.shortName)
		.setAudience(RESERVATIONS_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + (options.impersonated ? 200 : 300))
		.sign(new TextEncoder().encode(OPERATOR_SECRET))
}

async function op(
	method: string,
	suffix: string,
	body?: unknown,
	options: Mint = {},
) {
	const res = await app.request(`${BASE}${suffix}`, {
		method,
		headers: {
			Authorization: `Bearer ${await mint(options)}`,
			'Content-Type': 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await res.text()
	return { status: res.status, text, body: text ? JSON.parse(text) : null }
}

async function pub(
	method: string,
	urlPath: string,
	body?: unknown,
	extra: Record<string, string> = {},
) {
	const res = await app.request(urlPath, {
		method,
		headers: {
			Origin: US_ORIGIN,
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			...extra,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await res.text()
	return { res, status: res.status, text, body: text ? JSON.parse(text) : null }
}

const newExperience = (slug: string, extra: Record<string, unknown> = {}) => ({
	slug,
	kind: 'ticketed',
	nameI18n: { en: `Chef ${slug}`, ar: `تجربة ${slug}` },
	descriptionI18n: { en: 'Tasting menu' },
	priceMinor: 7500,
	partyMin: 2,
	partyMax: 6,
	usesTables: true,
	...extra,
})

const newSchedule = (extra: Record<string, unknown> = {}) => ({
	fromDate: DAY,
	toDate: DAY,
	seatingMins: [H19],
	coversCapPerSeating: 8,
	...extra,
})

async function createAndPublish(
	slug: string,
	extra: Record<string, unknown> = {},
) {
	const created = await op('POST', '', newExperience(slug, extra))
	expect(created.status).toBe(201)
	const id = created.body.experience.id as string
	expect((await op('POST', `/${id}/schedules`, newSchedule())).status).toBe(201)
	const published = await op('POST', `/${id}/publish`)
	expect(published.status).toBe(200)
	return id
}

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-experiences-test-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.TENANT_OPERATOR_TOKEN = OPERATOR_SECRET
	process.env.JWT_SECRET = JWT_SECRET
	process.env.AUTH_HMAC_SECRET = 'test-experiences-auth-hmac-secret-0123456789'
	process.env.RESERVATIONS_PUBLIC_ENABLED = 'true'
	delete process.env.TURNSTILE_SECRET_KEY
	resetReservationsContextCache()
	clearReservationDayCacheForTest()
	resetPublicRateLimits()
	orgs.set(ORG, {
		id: ORG,
		slug: 'acme',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: 'Acme Bistro',
	})
	await seedPublicOrg(ORG, { seedContext: false })
	seedReservationsContextForTest(
		ORG,
		publicContext(ORG, { experiences: true, locales: ['en', 'ar'] }),
	)
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => undefined)
	fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('operator Experiences setup', () => {
	describe('languages follow the organization Website settings', () => {
		const useLocales = (locales: string[], defaultLocale = locales[0]!) =>
			seedReservationsContextForTest(
				ORG,
				publicContext(ORG, { experiences: true, locales, defaultLocale }),
			)

		it('requires the default-language name and refuses a language that is not enabled', async () => {
			useLocales(['ar', 'en'])
			const noDefault = await op(
				'POST',
				'',
				newExperience('no-default', { nameI18n: { en: 'Only English' } }),
			)
			expect(noDefault.status).toBe(400)
			expect(noDefault.body.error).toBe('default_locale_required')
			useLocales(['en'])
			const disabled = await op(
				'POST',
				'',
				newExperience('disabled', { nameI18n: { en: 'x', zh: '体验' } }),
			)
			expect(disabled.status).toBe(400)
			expect(disabled.body.error).toBe('locale_not_enabled')
		})

		it.each(['es', 'fr', 'de', 'zh'])(
			'stores a %s name and description when enabled',
			async (lang) => {
				useLocales(['en', lang], 'en')
				const created = await op(
					'POST',
					'',
					newExperience(`exp-${lang}`, {
						nameI18n: { en: 'Tasting', [lang]: `Tasting ${lang}` },
						descriptionI18n: { en: 'Menu', [lang]: `Menu ${lang}` },
					}),
				)
				expect(created.status).toBe(201)
				expect(created.body.experience.nameI18n[lang]).toBe(`Tasting ${lang}`)
				expect(created.body.experience.descriptionI18n[lang]).toBe(
					`Menu ${lang}`,
				)
			},
		)
	})

	it('creates a draft that operators see and guests never do (VAL-EXP-001)', async () => {
		const created = await op('POST', '', newExperience('chefs-counter'))
		expect(created.status).toBe(201)
		expect(created.body.experience).toMatchObject({
			slug: 'chefs-counter',
			status: 'draft',
			version: 1,
			currency: 'USD',
			pricePerCover: true,
			usesTables: true,
			exclusive: false,
		})
		const list = await op('GET', '')
		expect(list.body.experiences.map((e: { slug: string }) => e.slug)).toEqual([
			'chefs-counter',
		])
		const publicList = await pub('GET', '/reservations/experiences')
		expect(publicList.status).toBe(200)
		expect(publicList.body.experiences).toEqual([])
		expect(
			(await pub('GET', '/reservations/experiences/chefs-counter')).status,
		).toBe(404)
	})

	it('takes the currency from the location and refuses a client currency', async () => {
		const db = await getTenantDb(ORG)
		await db
			.update(rsvLocationSettings)
			.set({ currency: 'SAR' })
			.where(eq(rsvLocationSettings.locationId, PUBLIC_LOC))
		const ok = await op('POST', '', newExperience('sar-one'))
		expect(ok.body.experience.currency).toBe('SAR')
		const bad = await op(
			'POST',
			'',
			newExperience('sar-two', { currency: 'EUR' }),
		)
		expect(bad.status).toBe(400)
	})

	it('rejects invalid definitions with field errors that never echo values and persists nothing (VAL-EXP-002)', async () => {
		const cases: Array<[Record<string, unknown>, string, string]> = [
			[{ partyMin: 6, partyMax: 2 }, 'partyMin', '"partyMin":6'],
			[{ priceMinor: -4242 }, 'priceMinor', '-4242'],
			[{ slug: 'Bad Slug!' }, 'slug', 'Bad Slug!'],
			[
				{ imageUrl: 'http://leak.example/secret.png' },
				'imageUrl',
				'leak.example',
			],
		]
		for (const [patch, field, echoed] of cases) {
			const res = await op('POST', '', newExperience('valid-one', patch))
			expect(res.status, field).toBe(400)
			expect(res.body.issues.map((i: { path: string }) => i.path)).toContain(
				field,
			)
			expect(res.text).not.toContain(echoed)
		}
		const db = await getTenantDb(ORG)
		expect(await db.select().from(rsvExperiences).all()).toHaveLength(0)

		const created = await op('POST', '', newExperience('valid-one'))
		const id = created.body.experience.id
		const badSchedule = await op('POST', `/${id}/schedules`, {
			fromDate: DAY,
			toDate: DAY,
			startMin: 1200,
			endMin: 1100,
			intervalMin: 30,
		})
		expect(badSchedule.status).toBe(400)
		expect(
			badSchedule.body.issues.map((i: { path: string }) => i.path),
		).toContain('endMin')
		expect(badSchedule.text).not.toContain('1100')
		const after = await op('GET', `/${id}`)
		expect(after.body.experience.schedules).toEqual([])
		expect(after.body.experience.version).toBe(1)
		// The corrected definition saves.
		expect((await op('POST', `/${id}/schedules`, newSchedule())).status).toBe(
			201,
		)
	})

	it('keeps slugs unique per location while not archived (VAL-EXP-003)', async () => {
		const first = await op('POST', '', newExperience('dup'))
		expect(first.status).toBe(201)
		const dup = await op('POST', '', newExperience('dup'))
		expect(dup.status).toBe(409)
		expect(dup.body.error).toBe('slug_taken')
		const id = first.body.experience.id
		expect((await op('POST', `/${id}/archive`)).status).toBe(200)
		expect((await op('POST', '', newExperience('dup'))).status).toBe(201)
	})

	it('answers a stale expectedVersion with 409 stale_version and changes nothing', async () => {
		const created = await op('POST', '', newExperience('versioned'))
		const id = created.body.experience.id
		const ok = await op('PATCH', `/${id}`, { partyMax: 4, expectedVersion: 1 })
		expect(ok.status).toBe(200)
		expect(ok.body.experience).toMatchObject({ partyMax: 4, version: 2 })
		const stale = await op('PATCH', `/${id}`, {
			partyMax: 5,
			expectedVersion: 1,
		})
		expect(stale.status).toBe(409)
		expect(stale.body.error).toBe('stale_version')
		expect(stale.body.version).toBe(2)
		const missing = await op('PATCH', `/${id}`, { partyMax: 5 })
		expect(missing.status).toBe(400)
		expect((await op('GET', `/${id}`)).body.experience.partyMax).toBe(4)
	})

	it('checks every referenced id against the same location', async () => {
		const db = await getTenantDb(ORG)
		await db.insert(rsvAreas).values({
			id: 'area_elsewhere',
			locationId: 'loc_elsewhere',
			name: 'Other',
			sort: 0,
		})
		await db.insert(rsvPolicies).values([
			{ id: 'pol_elsewhere', locationId: 'loc_elsewhere', name: 'Other' },
			{
				id: 'pol_archived',
				locationId: PUBLIC_LOC,
				name: 'Old',
				archivedAt: Date.now(),
			},
			{ id: 'pol_ok', locationId: PUBLIC_LOC, name: 'Ok' },
		])
		for (const policyId of ['pol_elsewhere', 'pol_archived', 'pol_missing']) {
			const res = await op(
				'POST',
				'',
				newExperience('with-policy', { policyId }),
			)
			expect(res.status, policyId).toBe(400)
			expect(res.body.issues).toEqual([
				{ path: 'policyId', code: 'invalid_reference' },
			])
		}
		const good = await op(
			'POST',
			'',
			newExperience('with-policy', { policyId: 'pol_ok' }),
		)
		expect(good.status).toBe(201)
		const id = good.body.experience.id
		const badArea = await op(
			'POST',
			`/${id}/schedules`,
			newSchedule({ areaIds: ['area_elsewhere'] }),
		)
		expect(badArea.status).toBe(400)
		expect(badArea.body.issues).toEqual([
			{ path: 'areaIds', code: 'invalid_reference' },
		])
		const badService = await op(
			'POST',
			`/${id}/schedules`,
			newSchedule({ serviceId: 'svc_missing' }),
		)
		expect(badService.status).toBe(400)
		const goodArea = await op(
			'POST',
			`/${id}/schedules`,
			newSchedule({ areaIds: ['area_pub_main'], serviceId: 'svc_pub_dinner' }),
		)
		expect(goodArea.status).toBe(201)
	})

	it('scopes experience and schedule ids to the path location', async () => {
		const created = await op('POST', '', newExperience('scoped'))
		const id = created.body.experience.id
		const db = await getTenantDb(ORG)
		await db
			.insert(rsvLocationSettings)
			.values({ locationId: 'loc_second', enabled: true, timeZone: 'UTC' })
		const otherBase =
			'/operator/reservations/setup/locations/loc_second/experiences'
		const res = await app.request(`${otherBase}/${id}`, {
			headers: { Authorization: `Bearer ${await mint()}` },
		})
		expect(res.status).toBe(404)
	})

	it('edits schedules as sub-resources and switches seating modes', async () => {
		const created = await op('POST', '', newExperience('sched'))
		const id = created.body.experience.id
		const added = await op('POST', `/${id}/schedules`, newSchedule())
		const scheduleId = added.body.experience.schedules[0].id
		expect(added.body.experience.version).toBe(2)
		const stepped = await op('PATCH', `/${id}/schedules/${scheduleId}`, {
			startMin: 1080,
			endMin: 1200,
			intervalMin: 60,
		})
		expect(stepped.status).toBe(200)
		expect(stepped.body.experience.schedules[0]).toMatchObject({
			seatingMins: null,
			seatings: [1080, 1140, 1200],
		})
		const stale = await op('PATCH', `/${id}/schedules/${scheduleId}`, {
			turnMin: 60,
			expectedVersion: 1,
		})
		expect(stale.status).toBe(409)
		const bad = await op('PATCH', `/${id}/schedules/${scheduleId}`, {
			endMin: 1000,
		})
		expect(bad.status).toBe(400)
		const del = await app.request(`${BASE}/${id}/schedules/${scheduleId}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${await mint()}` },
		})
		expect(del.status).toBe(200)
		expect((await op('GET', `/${id}`)).body.experience.schedules).toEqual([])
		expect(
			(await op('PATCH', `/${id}/schedules/missing`, { turnMin: 60 })).status,
		).toBe(404)
	})

	it('publishes only a valid definition, unpublishes to draft and archives for good', async () => {
		const created = await op(
			'POST',
			'',
			newExperience('lifecycle', { usesTables: false }),
		)
		const id = created.body.experience.id
		const empty = await op('POST', `/${id}/publish`)
		expect(empty.status).toBe(400)
		expect(empty.body.issues).toEqual([
			{ path: 'schedules', code: 'schedules_required' },
		])

		await op(
			'POST',
			`/${id}/schedules`,
			newSchedule({ coversCapPerSeating: null }),
		)
		const uncapped = await op('POST', `/${id}/publish`)
		expect(uncapped.status).toBe(400)
		expect(uncapped.body.issues[0].code).toBe('cap_required')

		const scheduleId = (await op('GET', `/${id}`)).body.experience.schedules[0]
			.id
		await op('PATCH', `/${id}/schedules/${scheduleId}`, { coversCapPerDay: 10 })
		const published = await op('POST', `/${id}/publish`)
		expect(published.status).toBe(200)
		expect(published.body.experience.status).toBe('published')
		expect((await op('POST', `/${id}/publish`)).body.error).toBe(
			'invalid_status_transition',
		)

		// A published table-less experience cannot lose its last cap.
		const dropCap = await op('PATCH', `/${id}/schedules/${scheduleId}`, {
			coversCapPerDay: null,
		})
		expect(dropCap.status).toBe(400)

		const un = await op('POST', `/${id}/unpublish`)
		expect(un.body.experience.status).toBe('draft')
		expect((await op('POST', `/${id}/unpublish`)).status).toBe(409)
		const archived = await op('POST', `/${id}/archive`)
		expect(archived.body.experience.status).toBe('archived')
		expect((await op('POST', `/${id}/publish`)).status).toBe(409)
		expect(
			(
				await op('PATCH', `/${id}`, {
					sort: 3,
					expectedVersion: archived.body.experience.version,
				})
			).status,
		).toBe(409)
	})

	it('audits every change without personal data and bumps the affected day versions', async () => {
		const db = await getTenantDb(ORG)
		const versionOf = async () =>
			(
				await db
					.select()
					.from(rsvDayVersions)
					.where(
						and(
							eq(rsvDayVersions.locationId, PUBLIC_LOC),
							eq(rsvDayVersions.businessDate, DAY),
						),
					)
					.get()
			)?.version ?? 0
		const id = await createAndPublish('audited')
		const afterPublish = await versionOf()
		expect(afterPublish).toBeGreaterThan(0)
		await op('POST', `/${id}/unpublish`)
		expect(await versionOf()).toBeGreaterThan(afterPublish)

		const actions = (await db.select().from(rsvAuditLog).all())
			.filter((r) => r.entityType === 'experience')
			.map((r) => r.action)
		expect(actions).toEqual(
			expect.arrayContaining([
				'experience.create',
				'experience.update',
				'experience.publish',
				'experience.unpublish',
			]),
		)
		const serialized = JSON.stringify(await db.select().from(rsvAuditLog).all())
		expect(serialized).not.toContain('Chef audited')
	})

	it('enforces the grant, impersonation, location and feature checks', async () => {
		const grantless = await op('GET', '', undefined, { grants: [] })
		expect(grantless.status).toBe(403)
		const readOnly = await op('POST', '', newExperience('ro'), {
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS],
		})
		expect(readOnly.status).toBe(403)
		expect(
			(
				await op('GET', '', undefined, {
					grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS],
				})
			).status,
		).toBe(200)
		const impersonated = await op('POST', '', newExperience('imp'), {
			impersonated: true,
		})
		expect(impersonated.status).toBe(403)
		const excluded = await op('GET', '', undefined, {
			locationIds: ['loc_other'],
		})
		expect(excluded.status).toBe(403)
		const off = await op('GET', '', undefined, { experiences: false })
		expect(off.status).toBe(404)
	})
})

describe('public Experiences', () => {
	it('lists and details published experiences with policy terms and no internals (VAL-EXP-004)', async () => {
		const db = await getTenantDb(ORG)
		await db.insert(rsvPolicies).values({
			id: 'pol_terms',
			locationId: PUBLIC_LOC,
			name: 'Prepay',
			kind: 'prepay',
			amountMinor: 7500,
			termsI18n: { en: 'Cancel 48h before.', ar: 'الإلغاء قبل 48 ساعة.' },
			termsVersion: 3,
		})
		const id = await createAndPublish('terms-one', { policyId: 'pol_terms' })
		const list = await pub('GET', '/reservations/experiences')
		expect(list.status).toBe(200)
		expect(list.res.headers.get('Cache-Control')).toBe('public, max-age=60')
		expect(list.res.headers.get('Vary')).toContain('Origin')
		const [item] = list.body.experiences
		expect(item).toMatchObject({
			id,
			slug: 'terms-one',
			locationId: PUBLIC_LOC,
			name: 'Chef terms-one',
			description: 'Tasting menu',
			price: { priceMinor: 7500, perCover: true, currency: 'USD' },
			partyMin: 2,
			partyMax: 6,
			policy: { terms: 'Cancel 48h before.', termsVersion: 3 },
		})
		expect(item.seatings).toEqual([
			{ date: DAY, times: [{ localMin: H19, time: '19:00' }] },
		])
		for (const secret of [
			'usesTables',
			'exclusive',
			'coversCap',
			'amountMinor',
			'areaIds',
			'kind":"prepay',
		]) {
			expect(list.text).not.toContain(secret)
		}
		const ar = await pub(
			'GET',
			'/reservations/experiences/terms-one',
			undefined,
			{ 'Accept-Language': 'ar' },
		)
		expect(ar.status).toBe(200)
		expect(ar.body.experience.name).toContain('تجربة')
		expect(ar.body.experience.policy.terms).toBe('الإلغاء قبل 48 ساعة.')
		// Archiving removes it from both routes.
		await op('POST', `/${id}/archive`)
		expect(
			(await pub('GET', '/reservations/experiences')).body.experiences,
		).toEqual([])
		expect(
			(await pub('GET', '/reservations/experiences/terms-one')).status,
		).toBe(404)
	})

	it('books a seating end to end through holds, caps and the manage view (VAL-EXP-006, VAL-EXP-011)', async () => {
		const id = await createAndPublish('e2e', { usesTables: false })
		// Table-less: cap 8 per seating.
		const scheduleId = (await op('GET', `/${id}`)).body.experience.schedules[0]
			.id
		void scheduleId
		const slots = await pub(
			'GET',
			`/reservations/availability?locationId=${PUBLIC_LOC}&date=${DAY}&partySize=2&experienceId=${id}`,
		)
		expect(slots.status).toBe(200)
		expect(slots.body.slots).toMatchObject([
			{ localMin: H19, experienceId: id },
		])

		const holdFor = (partySize: number) =>
			pub('POST', '/reservations/holds', {
				locationId: PUBLIC_LOC,
				experienceId: id,
				slot: { date: DAY, localMin: H19, partySize },
			})
		const first = await holdFor(6)
		expect(first.status).toBe(201)
		expect(first.body.experienceId).toBe(id)
		const booked = await pub(
			'POST',
			'/reservations',
			{
				holdToken: first.body.holdToken,
				guest: { firstName: 'Pat', lastName: 'One', phone: '+14155551234' },
				locale: 'en',
			},
			{ 'Idempotency-Key': 'exp-book-key-1-abcdefgh' },
		)
		expect(booked.status).toBe(201)
		expect(booked.body.reservation.status).toBe('booked')

		const db = await getTenantDb(ORG)
		const row = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, booked.body.reservation.id))
			.get()
		expect(row?.experienceId).toBe(id)
		expect(row?.paymentStatus).toBe('none')

		const manage = await pub('GET', '/reservations/manage', undefined, {
			'X-Reservation-Token': booked.body.manageToken,
		})
		expect(manage.status).toBe(200)
		expect(manage.body.reservation.experience).toMatchObject({
			id,
			slug: 'e2e',
		})
		expect(manage.body.canModify).toBe(false)

		// Two more covers fit (6 + 2 = 8), then the seating is sold out.
		expect((await holdFor(2)).status).toBe(201)
		const full = await holdFor(2)
		expect(full.status).toBe(409)
		expect(full.body.error).toBe('slot_unavailable')
		const after = await pub(
			'GET',
			`/reservations/availability?locationId=${PUBLIC_LOC}&date=${DAY}&partySize=2&experienceId=${id}`,
		)
		expect(after.body.slots).toEqual([])
		expect(after.body.soldOut).toEqual([{ localMin: H19, time: '19:00' }])
	})

	it('refuses experience holds and availability with the experiences flag off or for another location', async () => {
		const id = await createAndPublish('flagged', { usesTables: false })
		seedReservationsContextForTest(
			ORG,
			publicContext(ORG, { experiences: false, locales: ['en', 'ar'] }),
		)
		const avail = await pub(
			'GET',
			`/reservations/availability?locationId=${PUBLIC_LOC}&date=${DAY}&partySize=2&experienceId=${id}`,
		)
		expect(avail.status).toBe(404)
		const hold = await pub('POST', '/reservations/holds', {
			locationId: PUBLIC_LOC,
			experienceId: id,
			slot: { date: DAY, localMin: H19, partySize: 2 },
		})
		expect(hold.status).toBe(404)
		seedReservationsContextForTest(
			ORG,
			publicContext(ORG, { experiences: true, locales: ['en', 'ar'] }),
		)
		const unknown = await pub(
			'GET',
			`/reservations/availability?locationId=${PUBLIC_LOC}&date=${DAY}&partySize=2&experienceId=exp_missing`,
		)
		expect(unknown.status).toBe(404)
	})
})
