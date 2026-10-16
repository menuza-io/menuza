import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
	and,
	ConfigFlag,
	db,
	desc,
	eq,
	Organization,
	OrganizationLocation,
	User,
	UserOrganization,
} from '@repo/database'
import { RESERVATIONS_FLAG_KEYS } from '@repo/reservations'
import { businessDayStartMs } from '@repo/zoned-time'
import {
	getTenantDb,
	provisionTenantDb,
	rsvAreas,
	rsvDayVersions,
	rsvExperiences,
	rsvGuests,
	rsvLocationSettings,
	rsvPacingRules,
	rsvReservationEvents,
	rsvReservations,
	rsvServices,
	rsvTableComboMembers,
	rsvTableCombos,
	rsvTableOccupancies,
	rsvTables,
	rsvTurnTimes,
	rsvWaitlistEntries,
} from '@repo/tenant-db'

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

type OrgPreset = {
	id: string
	name: string
	slug: string
	dataRegion: 'us' | 'ksa'
	timeZone: string
	currency: string
	locationId: string
	locationSlug: string
	locationName: string
	city: string
	address: string
	phone: string
}

const ORG_PRESETS: Record<string, OrgPreset> = {
	acme: {
		id: 'org_acme_demo_us',
		name: 'Acme Bistro',
		slug: 'acme',
		dataRegion: 'us',
		timeZone: 'America/New_York',
		currency: 'USD',
		locationId: 'loc_acme_soho',
		locationSlug: 'soho',
		locationName: 'Acme SoHo',
		city: 'New York',
		address: '123 Mercer St, New York, NY 10012',
		phone: '+12125550100',
	},
	'riyadh-grill': {
		id: 'ru0dm42cud9scs4g2duep21c',
		name: 'Riyadh Readiness Grill',
		slug: 'riyadh-grill',
		dataRegion: 'ksa',
		timeZone: 'Asia/Riyadh',
		currency: 'SAR',
		locationId: 'oi97w1dxwcpnkpq9m9s8cnu8',
		locationSlug: 'main',
		locationName: 'Riyadh Readiness Grill',
		city: 'Riyadh',
		address: 'King Fahd Rd, Al Olaya, Riyadh 12214',
		phone: '+966115550199',
	},
}

const FLAG_KEYS = Object.values(RESERVATIONS_FLAG_KEYS)

async function ensureControlPlaneOrgAndLocation(slug: string): Promise<{
	orgId: string
	orgName: string
	dataRegion: 'us' | 'ksa'
	locationId: string
	locationName: string
	timeZone: string
	currency: string
}> {
	const preset = ORG_PRESETS[slug]
	let [org] = await db
		.select({
			id: Organization.id,
			name: Organization.name,
			dataRegion: Organization.dataRegion,
		})
		.from(Organization)
		.where(eq(Organization.slug, slug))
		.limit(1)

	if (!org) {
		if (!preset) {
			fail(`No organization with slug "${slug}".`)
		}
		await db.insert(Organization).values({
			id: preset.id,
			name: preset.name,
			slug: preset.slug,
			dataRegion: preset.dataRegion,
			hasProvisionedDb: true,
			staffingTimeZone: preset.timeZone,
			active: true,
		})
		org = {
			id: preset.id,
			name: preset.name,
			dataRegion: preset.dataRegion,
		}
		console.info(`Created organization "${preset.name}" (${preset.id}).`)
	} else {
		await db
			.update(Organization)
			.set({
				hasProvisionedDb: true,
				...(preset
					? {
							dataRegion: preset.dataRegion,
							staffingTimeZone: preset.timeZone,
						}
					: {}),
			})
			.where(eq(Organization.id, org.id))
	}

	// Ensure kody is a member of this organization if kody exists
	const [kody] = await db
		.select({ id: User.id })
		.from(User)
		.where(eq(User.username, 'kody'))
		.limit(1)
	if (kody) {
		const [membership] = await db
			.select({ userId: UserOrganization.userId })
			.from(UserOrganization)
			.where(
				and(
					eq(UserOrganization.userId, kody.id),
					eq(UserOrganization.organizationId, org.id),
				),
			)
			.limit(1)
		if (!membership) {
			await db.insert(UserOrganization).values({
				userId: kody.id,
				organizationId: org.id,
				organizationRoleId: 'org_role_admin',
				active: true,
				isDefault: slug === 'acme',
			})
		}
	}

	// Ensure active location
	let [location] = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
			slug: OrganizationLocation.slug,
			timeZone: OrganizationLocation.timezone,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, org.id),
				eq(OrganizationLocation.isActive, true),
			),
		)
		.orderBy(desc(OrganizationLocation.isDefault), OrganizationLocation.name)
		.limit(1)

	const defaultTz =
		preset?.timeZone ??
		(org.dataRegion === 'ksa' ? 'Asia/Riyadh' : 'America/New_York')
	const defaultCurrency =
		preset?.currency ?? (org.dataRegion === 'ksa' ? 'SAR' : 'USD')

	if (!location) {
		const locId =
			preset?.locationId ?? `loc_${slug.replace(/[^a-z0-9]/g, '_')}_main`
		const locName = preset?.locationName ?? `${org.name} Main`
		const locSlug = preset?.locationSlug ?? 'main'
		await db.insert(OrganizationLocation).values({
			id: locId,
			organizationId: org.id,
			name: locName,
			slug: locSlug,
			timezone: defaultTz,
			formattedAddress: preset?.address ?? null,
			city: preset?.city ?? null,
			phone: preset?.phone ?? null,
			isActive: true,
			isDefault: true,
		})
		location = {
			id: locId,
			name: locName,
			slug: locSlug,
			timeZone: defaultTz,
		}
		console.info(`Created location "${locName}" (${locId}).`)
	} else if (preset && location.timeZone !== preset.timeZone) {
		await db
			.update(OrganizationLocation)
			.set({ timezone: preset.timeZone })
			.where(eq(OrganizationLocation.id, location.id))
		location = { ...location, timeZone: preset.timeZone }
	}

	// Enable all reservations.* flags for the organization
	for (const key of FLAG_KEYS) {
		const flagWhere = and(
			eq(ConfigFlag.key, key),
			eq(ConfigFlag.level, 'organization'),
			eq(ConfigFlag.organizationId, org.id),
		)
		const [existing] = await db
			.select({ id: ConfigFlag.id, value: ConfigFlag.value })
			.from(ConfigFlag)
			.where(flagWhere)
			.limit(1)
		if (existing) {
			if (existing.value !== true) {
				await db
					.update(ConfigFlag)
					.set({ value: true })
					.where(eq(ConfigFlag.id, existing.id))
			}
		} else {
			await db.insert(ConfigFlag).values({
				key,
				value: true,
				level: 'organization',
				organizationId: org.id,
			})
		}
	}

	syncToLocalD1IfPresent({
		orgId: org.id,
		orgName: org.name,
		slug,
		dataRegion: org.dataRegion === 'ksa' ? 'ksa' : 'us',
		locationId: location.id,
		locationName: location.name,
		locationSlug: location.slug,
		timeZone: location.timeZone || defaultTz,
	})

	return {
		orgId: org.id,
		orgName: org.name,
		dataRegion: org.dataRegion === 'ksa' ? 'ksa' : 'us',
		locationId: location.id,
		locationName: location.name,
		timeZone: location.timeZone || defaultTz,
		currency: defaultCurrency,
	}
}

function sqlLiteral(val: string | number | null): string {
	if (val === null) return 'NULL'
	if (typeof val === 'number') return String(val)
	return `'${val.replace(/'/g, "''")}'`
}

function syncToLocalD1IfPresent(params: {
	orgId: string
	orgName: string
	slug: string
	dataRegion: 'us' | 'ksa'
	locationId: string
	locationName: string
	locationSlug: string
	timeZone: string
}) {
	const d1Dir = path.resolve(
		import.meta.dirname,
		'../../app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject',
	)
	if (!fs.existsSync(d1Dir)) return
	const files = fs
		.readdirSync(d1Dir)
		.filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
	const now = Date.now()
	for (const file of files) {
		const sqlitePath = path.join(d1Dir, file)
		const statements = [
			`INSERT INTO Organization (id, name, slug, active, dataRegion, hasProvisionedDb, staffingTimeZone, createdAt, updatedAt) VALUES (${sqlLiteral(params.orgId)}, ${sqlLiteral(params.orgName)}, ${sqlLiteral(params.slug)}, 1, ${sqlLiteral(params.dataRegion)}, 1, ${sqlLiteral(params.timeZone)}, ${now}, ${now}) ON CONFLICT(slug) DO UPDATE SET dataRegion = excluded.dataRegion, hasProvisionedDb = 1, staffingTimeZone = excluded.staffingTimeZone, updatedAt = excluded.updatedAt;`,
			`INSERT INTO OrganizationLocation (id, organizationId, name, slug, timezone, isActive, isDefault, createdAt, updatedAt) SELECT ${sqlLiteral(params.locationId)}, id, ${sqlLiteral(params.locationName)}, ${sqlLiteral(params.locationSlug)}, ${sqlLiteral(params.timeZone)}, 1, 1, ${now}, ${now} FROM Organization WHERE slug = ${sqlLiteral(params.slug)} ON CONFLICT(organizationId, slug) DO UPDATE SET timezone = excluded.timezone, isActive = 1, updatedAt = excluded.updatedAt;`,
			`INSERT OR IGNORE INTO UserOrganization (userId, organizationId, organizationRoleId, active, isDefault, createdAt, updatedAt) SELECT u.id, o.id, 'org_role_admin', 1, 0, ${now}, ${now} FROM User u, Organization o WHERE u.username = 'kody' AND o.slug = ${sqlLiteral(params.slug)};`,
			...FLAG_KEYS.flatMap((key) => [
				`DELETE FROM ConfigFlag WHERE key = ${sqlLiteral(key)} AND level = 'organization' AND organizationId = (SELECT id FROM Organization WHERE slug = ${sqlLiteral(params.slug)});`,
				`INSERT INTO ConfigFlag (id, key, value, level, organizationId, createdAt, updatedAt) SELECT 'cf_' || id || '_' || ${sqlLiteral(key)}, ${sqlLiteral(key)}, 'true', 'organization', id, ${now}, ${now} FROM Organization WHERE slug = ${sqlLiteral(params.slug)};`,
			]),
		]
		const res = spawnSync('sqlite3', [sqlitePath, statements.join('\n')], {
			encoding: 'utf8',
		})
		if (res.status !== 0 && res.stderr) {
			console.warn(`D1 sync warning (${file}): ${res.stderr.trim()}`)
		}
	}
}

async function seedTenantReservations(params: {
	orgId: string
	slug: string
	locationId: string
	timeZone: string
	currency: string
}) {
	await provisionTenantDb(params.orgId)
	const tenantDb = await getTenantDb(params.orgId)
	const now = Date.now()
	const prefix = params.slug.replace(/[^a-z0-9]/g, '_')
	const locId = params.locationId

	// 1. Location settings
	await tenantDb
		.insert(rsvLocationSettings)
		.values({
			locationId: locId,
			enabled: true,
			onlineEnabled: true,
			waitlistEnabled: true,
			waitlistOnline: true,
			timeZone: params.timeZone,
			currency: params.currency,
			intervalMin: 15,
			horizonDays: 60,
			minNoticeMin: 30,
			onlinePartyMin: 1,
			onlinePartyMax: 8,
			partyMax: 20,
			holdMinutes: 7,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: rsvLocationSettings.locationId,
			set: {
				enabled: true,
				onlineEnabled: true,
				waitlistEnabled: true,
				waitlistOnline: true,
				timeZone: params.timeZone,
				currency: params.currency,
				updatedAt: now,
			},
		})

	// 2. 3 Areas (Main Dining, Patio / Terrace, Bar / Lounge)
	const areaMainId = `area_${prefix}_main`
	const areaPatioId = `area_${prefix}_patio`
	const areaBarId = `area_${prefix}_bar`

	const areas = [
		{
			id: areaMainId,
			locationId: locId,
			name: 'Main Dining Room',
			sort: 0,
			onlineBookable: true,
			guestSelectable: true,
		},
		{
			id: areaPatioId,
			locationId: locId,
			name: 'Garden Terrace',
			sort: 1,
			onlineBookable: true,
			guestSelectable: true,
		},
		{
			id: areaBarId,
			locationId: locId,
			name: 'Chef Counter & Lounge',
			sort: 2,
			onlineBookable: true,
			guestSelectable: true,
		},
	]
	for (const area of areas) {
		await tenantDb
			.insert(rsvAreas)
			.values({ ...area, createdAt: now, updatedAt: now })
			.onConflictDoUpdate({
				target: rsvAreas.id,
				set: {
					name: area.name,
					sort: area.sort,
					onlineBookable: area.onlineBookable,
					guestSelectable: area.guestSelectable,
					updatedAt: now,
				},
			})
	}

	// 3. 12 Tables across the 3 areas
	const tables = [
		{
			id: `tbl_${prefix}_m1`,
			areaId: areaMainId,
			label: 'M1',
			minCovers: 1,
			maxCovers: 2,
			shape: 'round' as const,
			x: 80,
			y: 80,
			priority: 10,
			combinable: false,
		},
		{
			id: `tbl_${prefix}_m2`,
			areaId: areaMainId,
			label: 'M2',
			minCovers: 1,
			maxCovers: 2,
			shape: 'round' as const,
			x: 200,
			y: 80,
			priority: 9,
			combinable: false,
		},
		{
			id: `tbl_${prefix}_m3`,
			areaId: areaMainId,
			label: 'M3',
			minCovers: 2,
			maxCovers: 4,
			shape: 'square' as const,
			x: 80,
			y: 200,
			priority: 10,
			combinable: true,
		},
		{
			id: `tbl_${prefix}_m4`,
			areaId: areaMainId,
			label: 'M4',
			minCovers: 2,
			maxCovers: 4,
			shape: 'square' as const,
			x: 200,
			y: 200,
			priority: 9,
			combinable: true,
		},
		{
			id: `tbl_${prefix}_m5`,
			areaId: areaMainId,
			label: 'M5',
			minCovers: 4,
			maxCovers: 6,
			shape: 'rect' as const,
			x: 340,
			y: 120,
			priority: 10,
			combinable: false,
		},
		{
			id: `tbl_${prefix}_m6`,
			areaId: areaMainId,
			label: 'M6',
			minCovers: 4,
			maxCovers: 8,
			shape: 'booth' as const,
			x: 340,
			y: 240,
			priority: 8,
			combinable: false,
		},
		{
			id: `tbl_${prefix}_p1`,
			areaId: areaPatioId,
			label: 'T1',
			minCovers: 1,
			maxCovers: 2,
			shape: 'round' as const,
			x: 100,
			y: 100,
			priority: 8,
			combinable: false,
		},
		{
			id: `tbl_${prefix}_p2`,
			areaId: areaPatioId,
			label: 'T2',
			minCovers: 2,
			maxCovers: 4,
			shape: 'square' as const,
			x: 220,
			y: 100,
			priority: 8,
			combinable: true,
		},
		{
			id: `tbl_${prefix}_p3`,
			areaId: areaPatioId,
			label: 'T3',
			minCovers: 2,
			maxCovers: 4,
			shape: 'square' as const,
			x: 100,
			y: 220,
			priority: 7,
			combinable: true,
		},
		{
			id: `tbl_${prefix}_p4`,
			areaId: areaPatioId,
			label: 'T4',
			minCovers: 4,
			maxCovers: 6,
			shape: 'rect' as const,
			x: 220,
			y: 220,
			priority: 7,
			combinable: false,
		},
		{
			id: `tbl_${prefix}_b1`,
			areaId: areaBarId,
			label: 'C1',
			minCovers: 1,
			maxCovers: 2,
			shape: 'counter' as const,
			x: 100,
			y: 100,
			priority: 6,
			combinable: false,
		},
		{
			id: `tbl_${prefix}_b2`,
			areaId: areaBarId,
			label: 'C2',
			minCovers: 2,
			maxCovers: 4,
			shape: 'booth' as const,
			x: 240,
			y: 100,
			priority: 6,
			combinable: false,
		},
	]
	for (const table of tables) {
		await tenantDb
			.insert(rsvTables)
			.values({
				...table,
				locationId: locId,
				w: 72,
				h: 72,
				rotation: 0,
				onlineBookable: true,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: rsvTables.id,
				set: {
					label: table.label,
					minCovers: table.minCovers,
					maxCovers: table.maxCovers,
					combinable: table.combinable,
					x: table.x,
					y: table.y,
					updatedAt: now,
				},
			})
	}

	// 4. 2 Table Combinations + Members
	const combos = [
		{
			id: `cmb_${prefix}_m3_m4`,
			locationId: locId,
			label: 'M3 + M4 Banquette',
			minCovers: 5,
			maxCovers: 8,
			priority: 8,
			onlineBookable: true,
			tableIds: [`tbl_${prefix}_m3`, `tbl_${prefix}_m4`],
		},
		{
			id: `cmb_${prefix}_p2_p3`,
			locationId: locId,
			label: 'T2 + T3 Terrace Long Table',
			minCovers: 5,
			maxCovers: 8,
			priority: 7,
			onlineBookable: true,
			tableIds: [`tbl_${prefix}_p2`, `tbl_${prefix}_p3`],
		},
	]
	for (const combo of combos) {
		const { tableIds, ...comboRow } = combo
		await tenantDb
			.insert(rsvTableCombos)
			.values({ ...comboRow, createdAt: now, updatedAt: now })
			.onConflictDoUpdate({
				target: rsvTableCombos.id,
				set: {
					label: comboRow.label,
					minCovers: comboRow.minCovers,
					maxCovers: comboRow.maxCovers,
					updatedAt: now,
				},
			})
		for (const tableId of tableIds) {
			await tenantDb
				.insert(rsvTableComboMembers)
				.values({ comboId: comboRow.id, tableId })
				.onConflictDoNothing()
		}
	}

	// 5. 3 Services (Lunch, Dinner, Weekend Brunch)
	const svcLunchId = `svc_${prefix}_lunch`
	const svcDinnerId = `svc_${prefix}_dinner`
	const svcBrunchId = `svc_${prefix}_brunch`
	const services = [
		{
			id: svcLunchId,
			locationId: locId,
			name: 'Lunch',
			daysMask: 0b0111110, // Mon-Fri
			firstSeatingMin: 12 * 60, // 12:00
			lastSeatingMin: 14 * 60 + 30, // 14:30
			endMin: 15 * 60, // 15:00
			intervalMin: 15,
			onlineCapPerInterval: 24,
			concurrentCoversCap: 120,
			sort: 0,
		},
		{
			id: svcDinnerId,
			locationId: locId,
			name: 'Dinner',
			daysMask: 0b1111111, // Every day
			firstSeatingMin: 17 * 60 + 30, // 17:30
			lastSeatingMin: 22 * 60, // 22:00
			endMin: 23 * 60, // 23:00
			intervalMin: 15,
			onlineCapPerInterval: 30,
			concurrentCoversCap: 180,
			sort: 1,
		},
		{
			id: svcBrunchId,
			locationId: locId,
			name: 'Weekend Brunch',
			daysMask: 0b1000001, // Sun + Sat
			firstSeatingMin: 10 * 60, // 10:00
			lastSeatingMin: 14 * 60 + 15, // 14:15
			endMin: 15 * 60, // 15:00
			intervalMin: 15,
			onlineCapPerInterval: 24,
			concurrentCoversCap: 140,
			sort: 2,
		},
	]
	for (const svc of services) {
		await tenantDb
			.insert(rsvServices)
			.values({
				...svc,
				onlineEnabled: true,
			})
			.onConflictDoUpdate({
				target: rsvServices.id,
				set: {
					name: svc.name,
					daysMask: svc.daysMask,
					firstSeatingMin: svc.firstSeatingMin,
					lastSeatingMin: svc.lastSeatingMin,
					endMin: svc.endMin,
				},
			})
	}

	// 6. 4 Turn-time brackets
	const turnTimes = [
		{ id: `tt_${prefix}_1_2`, partyMin: 1, partyMax: 2, minutes: 75 },
		{ id: `tt_${prefix}_3_4`, partyMin: 3, partyMax: 4, minutes: 90 },
		{ id: `tt_${prefix}_5_6`, partyMin: 5, partyMax: 6, minutes: 105 },
		{ id: `tt_${prefix}_7_10`, partyMin: 7, partyMax: 10, minutes: 120 },
	]
	for (const tt of turnTimes) {
		await tenantDb
			.insert(rsvTurnTimes)
			.values({
				...tt,
				locationId: locId,
				serviceId: null,
				daysMask: 127,
			})
			.onConflictDoUpdate({
				target: rsvTurnTimes.id,
				set: {
					minutes: tt.minutes,
				},
			})
	}

	// 7. Pacing rules
	const pacingRules = [
		{
			id: `pace_${prefix}_lunch`,
			serviceId: svcLunchId,
			bucketMin: 15,
			maxCovers: 20,
			maxParties: 6,
		},
		{
			id: `pace_${prefix}_dinner`,
			serviceId: svcDinnerId,
			bucketMin: 15,
			maxCovers: 28,
			maxParties: 8,
		},
		{
			id: `pace_${prefix}_brunch`,
			serviceId: svcBrunchId,
			bucketMin: 15,
			maxCovers: 22,
			maxParties: 7,
		},
	]
	for (const rule of pacingRules) {
		await tenantDb
			.insert(rsvPacingRules)
			.values({
				...rule,
				channel: 'all',
			})
			.onConflictDoUpdate({
				target: rsvPacingRules.id,
				set: {
					maxCovers: rule.maxCovers,
					maxParties: rule.maxParties,
				},
			})
	}

	// 8. Experience
	const expId = `exp_${prefix}_chefs_tasting`
	await tenantDb
		.insert(rsvExperiences)
		.values({
			id: expId,
			locationId: locId,
			slug: 'chefs-tasting',
			kind: 'tasting',
			nameI18n: {
				en: "Chef's Seasonal Tasting",
				ar: 'قائمة تذوق الشيف الموسمية',
			},
			descriptionI18n: {
				en: 'Seven-course seasonal tasting menu at the chef counter.',
				ar: 'قائمة تذوق موسمية من سبعة أطباق.',
			},
			priceMinor: params.currency === 'SAR' ? 25000 : 8500,
			pricePerCover: true,
			currency: params.currency,
			partyMin: 2,
			partyMax: 6,
			usesTables: true,
			exclusive: false,
			status: 'published',
			sort: 0,
		})
		.onConflictDoUpdate({
			target: rsvExperiences.id,
			set: {
				priceMinor: params.currency === 'SAR' ? 25000 : 8500,
				currency: params.currency,
			},
		})

	// 9. 8 Demo Guests
	const guests = [
		{
			id: `gst_${prefix}_1`,
			firstName: 'Layla',
			lastName: 'Al-Mansoor',
			phoneE164: '+966501112201',
			emailNorm: 'layla@example.com',
			visits: 12,
			covers: 32,
		},
		{
			id: `gst_${prefix}_2`,
			firstName: 'Marcus',
			lastName: 'Vance',
			phoneE164: '+12125550141',
			emailNorm: 'marcus@example.com',
			visits: 8,
			covers: 24,
		},
		{
			id: `gst_${prefix}_3`,
			firstName: 'Nadia',
			lastName: 'Haddad',
			phoneE164: '+12125550142',
			emailNorm: 'nadia@example.com',
			allergyNotes: 'Tree nuts',
			visits: 5,
			covers: 14,
		},
		{
			id: `gst_${prefix}_4`,
			firstName: 'Tariq',
			lastName: 'Al-Harbi',
			phoneE164: '+966501112204',
			emailNorm: 'tariq@example.com',
			visits: 15,
			covers: 48,
		},
		{
			id: `gst_${prefix}_5`,
			firstName: 'Elena',
			lastName: 'Rostova',
			phoneE164: '+12125550145',
			emailNorm: 'elena@example.com',
			visits: 2,
			covers: 4,
		},
		{
			id: `gst_${prefix}_6`,
			firstName: 'Devon',
			lastName: 'Brooks',
			phoneE164: '+12125550146',
			emailNorm: 'devon@example.com',
			visits: 4,
			covers: 10,
		},
		{
			id: `gst_${prefix}_7`,
			firstName: 'Samira',
			lastName: 'Khoury',
			phoneE164: '+966501112207',
			emailNorm: 'samira@example.com',
			visits: 6,
			covers: 16,
		},
		{
			id: `gst_${prefix}_8`,
			firstName: 'Julian',
			lastName: 'Mercer',
			phoneE164: '+12125550148',
			emailNorm: 'julian@example.com',
			visits: 1,
			covers: 2,
		},
	]
	for (const guest of guests) {
		await tenantDb
			.insert(rsvGuests)
			.values({
				...guest,
				locale: params.currency === 'SAR' ? 'ar' : 'en',
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: rsvGuests.id,
				set: {
					firstName: guest.firstName,
					lastName: guest.lastName,
					visits: guest.visits,
					covers: guest.covers,
					updatedAt: now,
				},
			})
	}

	// 10. Today's Reservations + Occupancies + Waitlist
	const businessDate = new Intl.DateTimeFormat('en-CA', {
		timeZone: params.timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(new Date(now))

	const reservations = [
		{
			id: `rsv_${prefix}_1`,
			guestId: `gst_${prefix}_1`,
			confirmationCode: `RSV${prefix.slice(0, 3).toUpperCase()}101`,
			serviceId: svcDinnerId,
			areaPrefId: areaMainId,
			localStartMin: 18 * 60, // 18:00
			durationMin: 90,
			partySize: 2,
			status: 'confirmed' as const,
			tableId: `tbl_${prefix}_m1`,
		},
		{
			id: `rsv_${prefix}_2`,
			guestId: `gst_${prefix}_2`,
			confirmationCode: `RSV${prefix.slice(0, 3).toUpperCase()}102`,
			serviceId: svcDinnerId,
			areaPrefId: areaMainId,
			localStartMin: 18 * 60 + 30, // 18:30
			durationMin: 90,
			partySize: 4,
			status: 'seated' as const,
			tableId: `tbl_${prefix}_m3`,
		},
		{
			id: `rsv_${prefix}_3`,
			guestId: `gst_${prefix}_3`,
			confirmationCode: `RSV${prefix.slice(0, 3).toUpperCase()}103`,
			serviceId: svcDinnerId,
			areaPrefId: areaPatioId,
			localStartMin: 19 * 60, // 19:00
			durationMin: 90,
			partySize: 4,
			status: 'booked' as const,
			tableId: `tbl_${prefix}_p2`,
		},
		{
			id: `rsv_${prefix}_4`,
			guestId: `gst_${prefix}_4`,
			confirmationCode: `RSV${prefix.slice(0, 3).toUpperCase()}104`,
			serviceId: svcDinnerId,
			areaPrefId: areaMainId,
			localStartMin: 19 * 60 + 30, // 19:30
			durationMin: 105,
			partySize: 6,
			status: 'partially_seated' as const,
			tableId: `tbl_${prefix}_m5`,
		},
		{
			id: `rsv_${prefix}_5`,
			guestId: `gst_${prefix}_5`,
			confirmationCode: `RSV${prefix.slice(0, 3).toUpperCase()}105`,
			serviceId: svcLunchId,
			areaPrefId: areaMainId,
			localStartMin: 12 * 60 + 30, // 12:30
			durationMin: 75,
			partySize: 2,
			status: 'completed' as const,
			tableId: null,
		},
		{
			id: `rsv_${prefix}_6`,
			guestId: `gst_${prefix}_6`,
			confirmationCode: `RSV${prefix.slice(0, 3).toUpperCase()}106`,
			serviceId: svcDinnerId,
			areaPrefId: areaBarId,
			localStartMin: 20 * 60, // 20:00
			durationMin: 90,
			partySize: 2,
			status: 'cancelled' as const,
			tableId: null,
		},
		{
			id: `rsv_${prefix}_7`,
			guestId: `gst_${prefix}_7`,
			confirmationCode: `RSV${prefix.slice(0, 3).toUpperCase()}107`,
			serviceId: svcLunchId,
			areaPrefId: areaPatioId,
			localStartMin: 13 * 60, // 13:00
			durationMin: 75,
			partySize: 2,
			status: 'no_show' as const,
			tableId: null,
		},
	]

	for (const rsv of reservations) {
		const startAt = businessDayStartMs(
			businessDate,
			params.timeZone,
			rsv.localStartMin,
		)
		const endAt = startAt + rsv.durationMin * 60_000
		await tenantDb
			.insert(rsvReservations)
			.values({
				id: rsv.id,
				locationId: locId,
				guestId: rsv.guestId,
				confirmationCode: rsv.confirmationCode,
				serviceId: rsv.serviceId,
				areaPrefId: rsv.areaPrefId,
				businessDate,
				localStartMin: rsv.localStartMin,
				timeZone: params.timeZone,
				startAt,
				endAt,
				durationMin: rsv.durationMin,
				partySize: rsv.partySize,
				status: rsv.status,
				channel: 'host',
				guestLocale: params.currency === 'SAR' ? 'ar' : 'en',
				createdByKind: 'system',
				createdById: 'seed-reservations',
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: rsvReservations.id,
				set: {
					businessDate,
					startAt,
					endAt,
					status: rsv.status,
					updatedAt: now,
				},
			})

		const evtId = `evt_${rsv.id}_init`
		const [existingEvt] = await tenantDb
			.select({ id: rsvReservationEvents.id })
			.from(rsvReservationEvents)
			.where(eq(rsvReservationEvents.id, evtId))
			.limit(1)
		if (!existingEvt) {
			await tenantDb.insert(rsvReservationEvents).values({
				id: evtId,
				reservationId: rsv.id,
				at: now,
				actorKind: 'system',
				actorId: 'seed-reservations',
				type: 'seeded',
				fromStatus: null,
				toStatus: rsv.status,
			})
		}

		if (rsv.tableId) {
			const occId = `occ_${rsv.id}`
			const [existingOcc] = await tenantDb
				.select({ id: rsvTableOccupancies.id })
				.from(rsvTableOccupancies)
				.where(eq(rsvTableOccupancies.id, occId))
				.limit(1)
			if (!existingOcc) {
				await tenantDb.insert(rsvTableOccupancies).values({
					id: occId,
					locationId: locId,
					tableId: rsv.tableId,
					kind: 'reservation',
					reservationId: rsv.id,
					startAt,
					endAt: endAt + 15 * 60_000,
					active: true,
					createdAt: now,
				})
			}
		}
	}

	// 11. Waitlist entries
	const waitlistEntries = [
		{
			id: `wl_${prefix}_1`,
			guestId: `gst_${prefix}_8`,
			displayName: 'Julian Mercer',
			phoneE164: '+12125550148',
			partySize: 2,
			quotedMin: 20,
			sortKey: 1,
		},
		{
			id: `wl_${prefix}_2`,
			guestId: null,
			displayName: 'Fatima Al-Qahtani',
			phoneE164: '+966501112299',
			partySize: 4,
			quotedMin: 35,
			sortKey: 2,
		},
	]
	for (const wl of waitlistEntries) {
		await tenantDb
			.insert(rsvWaitlistEntries)
			.values({
				id: wl.id,
				locationId: locId,
				areaPrefId: areaMainId,
				guestId: wl.guestId,
				businessDate,
				displayName: wl.displayName,
				phoneE164: wl.phoneE164,
				partySize: wl.partySize,
				channel: 'walk_in',
				joinedAt: now,
				quotedMin: wl.quotedMin,
				status: 'waiting',
				sortKey: wl.sortKey,
				locale: params.currency === 'SAR' ? 'ar' : 'en',
				createdAt: now,
			})
			.onConflictDoUpdate({
				target: rsvWaitlistEntries.id,
				set: {
					businessDate,
					status: 'waiting',
					sortKey: wl.sortKey,
				},
			})
	}

	// 12. Day version row
	await tenantDb
		.insert(rsvDayVersions)
		.values({
			locationId: locId,
			businessDate,
			version: 1,
			updatedAt: now,
		})
		.onConflictDoNothing()

	console.info(
		`Seeded Reservations for "${params.slug}" (${params.orgId}, location "${locId}", tz "${params.timeZone}"): ` +
			`${areas.length} areas, ${tables.length} tables, ${combos.length} combos, ` +
			`${services.length} services, ${turnTimes.length} turn-time brackets, ` +
			`${guests.length} guests, ${reservations.length} reservations, ${waitlistEntries.length} waitlist entries.`,
	)
}

async function main() {
	if (process.env.NODE_ENV === 'production') {
		fail(
			'seed-reservations is for local development and refuses to run in production.',
		)
	}
	const slug = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
	if (!slug) {
		fail('Usage: seed-reservations <org-slug>')
	}

	const orgInfo = await ensureControlPlaneOrgAndLocation(slug)
	await seedTenantReservations({
		orgId: orgInfo.orgId,
		slug,
		locationId: orgInfo.locationId,
		timeZone: orgInfo.timeZone,
		currency: orgInfo.currency,
	})
}

await main()
process.exit(0)
