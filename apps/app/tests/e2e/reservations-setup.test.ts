import { type Page } from '@playwright/test'
import {
	_OrganizationPermissionToRole,
	ConfigFlag,
	db,
	OrganizationLocation,
	Permission,
} from '@repo/database'
import { RESERVATIONS_FLAG_KEYS } from '@repo/reservations'
import { expect, test } from '#tests/playwright-utils.ts'
import {
	addOrganizationMember,
	createTestOrganization,
	createTestUser,
} from '#tests/test-utils.ts'

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': 'authorization, content-type',
	'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
}

type StubRequest = { method: string; path: string; body: unknown }

async function enableReservationsFlag(organizationId: string) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: RESERVATIONS_FLAG_KEYS.enabled,
			value: true,
			level: 'organization',
			organizationId,
		})
		.returning({ id: ConfigFlag.id })
	return row!.id
}

async function createLocationForOrg(
	organizationId: string,
	overrides: Partial<{
		name: string
		slug: string
		timezone: string
	}> = {},
) {
	const id = `loc_${Math.random().toString(36).slice(2, 10)}`
	const [loc] = await db
		.insert(OrganizationLocation)
		.values({
			id,
			organizationId,
			name: overrides.name ?? 'Downtown Grill',
			slug: overrides.slug ?? `downtown-${id}`,
			timezone: overrides.timezone ?? 'America/New_York',
			isActive: true,
		})
		.returning()
	return loc!
}

function json(route: any, data: unknown, status = 200) {
	return route.fulfill({
		status,
		headers: { ...CORS, 'content-type': 'application/json' },
		body: JSON.stringify(data),
	})
}

async function stubSetupApi(
	page: Page,
	locationId: string,
	options: {
		tzMismatch?: boolean
		forceFloorPlanConflictOnce?: boolean
	} = {},
) {
	const requests: StubRequest[] = []
	let shouldForceFloorPlanConflict = Boolean(options.forceFloorPlanConflictOnce)

	let settings = {
		locationId,
		enabled: true,
		onlineBookingEnabled: true,
		waitlistEnabled: true,
		slotIntervalMin: 15,
		defaultTurnTimeMin: 90,
		minAdvanceMinutes: 30,
		maxAdvanceDays: 60,
		onlinePartyMin: 1,
		onlinePartyMax: 8,
		partyMax: 12,
		holdTtlSeconds: 300,
		gracePeriodMinutes: 15,
		lateCancelHours: 24,
		pacingMaxCoversPerSlot: 24,
		pacingMaxPartiesPerSlot: 8,
		autoConfirmOnline: true,
		autoAssignTables: true,
		confirmationCopyI18n: {
			en: 'We look forward to welcoming you.',
			ar: 'نتطلع للترحيب بكم.',
		},
		policyCopyI18n: {
			en: 'Please cancel at least 24 hours in advance.',
			ar: 'يرجى الإلغاء قبل 24 ساعة على الأقل.',
		},
		timeZone: 'America/New_York',
		contextTimeZone: options.tzMismatch
			? 'America/Chicago'
			: 'America/New_York',
		tzSyncedAt: Date.now() - 60_000,
		tzMismatch: Boolean(options.tzMismatch),
		floorPlanVersion: 1,
		version: 1,
	}

	let areas: Array<Record<string, any>> = [
		{
			id: 'area-main',
			locationId,
			name: 'Main Dining',
			nameI18n: { en: 'Main Dining', ar: 'الصالة الرئيسية' },
			floorLabel: 'Ground',
			sortOrder: 0,
			isOutdoor: false,
			isBookableOnline: true,
			onlinePriority: 0,
			isActive: true,
			archivedAt: null,
			version: 1,
		},
	]

	let tables: Array<Record<string, any>> = [
		{
			id: 'table-1',
			locationId,
			areaId: 'area-main',
			label: 'T1',
			minCovers: 2,
			maxCovers: 4,
			shape: 'round',
			x: 100,
			y: 120,
			width: 60,
			height: 60,
			rotation: 0,
			combinable: true,
			isBookableOnline: true,
			isAccessible: false,
			isHighTop: false,
			isPatio: false,
			resetBufferMin: 15,
			priority: 0,
			notes: null,
			isActive: true,
			archivedAt: null,
			version: 1,
		},
		{
			id: 'table-2',
			locationId,
			areaId: 'area-main',
			label: 'T2',
			minCovers: 2,
			maxCovers: 4,
			shape: 'square',
			x: 220,
			y: 120,
			width: 60,
			height: 60,
			rotation: 0,
			combinable: true,
			isBookableOnline: true,
			isAccessible: false,
			isHighTop: false,
			isPatio: false,
			resetBufferMin: 15,
			priority: 1,
			notes: null,
			isActive: true,
			archivedAt: null,
			version: 1,
		},
	]

	let combos: Array<Record<string, unknown>> = []
	let elements: Array<Record<string, unknown>> = [
		{
			id: 'el-bar-1',
			locationId,
			areaId: 'area-main',
			kind: 'bar',
			label: 'Front Bar',
			x: 360,
			y: 80,
			width: 140,
			height: 50,
			rotation: 0,
			style: {},
		},
	]

	let services: Array<Record<string, any>> = [
		{
			id: 'svc-dinner',
			locationId,
			name: 'Dinner',
			nameI18n: { en: 'Dinner', ar: 'العشاء' },
			code: 'dinner',
			daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
			firstSeatingMin: 1020,
			lastSeatingMin: 1320,
			endMin: 1380,
			slotIntervalMin: 15,
			defaultTurnTimeMin: 90,
			onlineBookable: true,
			sortOrder: 0,
			color: null,
			isActive: true,
			archivedAt: null,
			version: 1,
		},
	]

	let turnTimes: Array<Record<string, any>> = [
		{
			id: 'tt-1',
			locationId,
			serviceId: null,
			partyMin: 1,
			partyMax: 8,
			minutes: 90,
			bufferMinutes: 15,
			version: 1,
		},
	]

	let pacing: Array<Record<string, unknown>> = []
	let availability: Array<Record<string, unknown>> = []
	let specialDays: Array<Record<string, unknown>> = []
	let blocks: Array<Record<string, unknown>> = []

	await page.route('**/operator/reservations/setup/**', async (route) => {
		const request = route.request()
		if (request.method() === 'OPTIONS') {
			return route.fulfill({ status: 204, headers: CORS })
		}
		const url = new URL(request.url())
		const prefix = `/operator/reservations/setup/locations/${locationId}`
		const subPath = url.pathname.startsWith(prefix)
			? url.pathname.slice(prefix.length) || '/'
			: url.pathname
		const method = request.method()
		const body = request.postDataJSON?.() ?? null
		requests.push({ method, path: subPath, body })

		if (method === 'GET' && subPath === '/settings') {
			return json(route, { settings })
		}
		if (method === 'PUT' && subPath === '/settings') {
			settings = {
				...settings,
				...(body as Record<string, unknown>),
				version: settings.version + 1,
			}
			return json(route, { settings })
		}
		if (method === 'POST' && subPath === '/rederive-times') {
			settings = {
				...settings,
				timeZone: settings.contextTimeZone,
				tzMismatch: false,
				tzSyncedAt: Date.now(),
				version: settings.version + 1,
			}
			return json(route, {
				timeZone: settings.timeZone,
				tzSyncedAt: settings.tzSyncedAt,
				updatedReservations: 2,
				settings,
			})
		}
		if (method === 'GET' && subPath === '/validation') {
			return json(route, {
				valid: true,
				issues: [],
				errors: [],
				warnings: [],
			})
		}
		if (method === 'GET' && subPath === '/conflicts') {
			return json(route, { conflicts: [] })
		}
		if (method === 'GET' && subPath === '/floor-plan') {
			return json(route, {
				locationId,
				floorPlanVersion: settings.floorPlanVersion,
				version: settings.version,
				areas,
				tables,
				combos,
				elements,
			})
		}
		if (method === 'PUT' && subPath === '/floor-plan') {
			if (shouldForceFloorPlanConflict) {
				shouldForceFloorPlanConflict = false
				return json(
					route,
					{
						error: 'stale_version',
						message: 'Floor plan version is stale.',
						currentFloorPlanVersion: settings.floorPlanVersion + 1,
					},
					409,
				)
			}
			const payload = body as {
				areas?: typeof areas
				tables?: typeof tables
				elements?: typeof elements
			}
			if (payload.areas) areas = payload.areas
			if (payload.tables) tables = payload.tables
			if (payload.elements) elements = payload.elements
			settings = {
				...settings,
				floorPlanVersion: settings.floorPlanVersion + 1,
			}
			return json(route, {
				locationId,
				floorPlanVersion: settings.floorPlanVersion,
				version: settings.version,
				areas,
				tables,
				combos,
				elements,
				conflicts: [],
				reflowedMoves: [],
			})
		}
		if (method === 'GET' && subPath === '/areas') {
			return json(route, { areas })
		}
		if (method === 'POST' && subPath === '/areas') {
			const b = body as Record<string, unknown>
			const created = {
				id: `area-${areas.length + 1}`,
				locationId,
				name: String(b.name),
				nameI18n: (b.nameI18n as Record<string, string>) ?? {
					en: String(b.name),
				},
				floorLabel: (b.floorLabel as string | null) ?? null,
				sortOrder: areas.length,
				isOutdoor: Boolean(b.isOutdoor),
				isBookableOnline: b.isBookableOnline !== false,
				onlinePriority: 0,
				isActive: true,
				archivedAt: null,
				version: 1,
			}
			areas = [...areas, created]
			settings.floorPlanVersion += 1
			return json(
				route,
				{ area: created, floorPlanVersion: settings.floorPlanVersion },
				201,
			)
		}
		if (method === 'GET' && subPath === '/tables') {
			return json(route, { tables })
		}
		if (method === 'POST' && subPath === '/tables') {
			const b = body as Record<string, unknown>
			const label = String(b.label)
			if (tables.some((t) => t.label.toLowerCase() === label.toLowerCase())) {
				return json(
					route,
					{
						error: 'duplicate_table_label',
						message: `Table label "${label}" already exists.`,
					},
					409,
				)
			}
			const created = {
				id: `table-${tables.length + 1}`,
				locationId,
				areaId: String(b.areaId),
				label,
				minCovers: Number(b.minCovers ?? 2),
				maxCovers: Number(b.maxCovers ?? 4),
				shape: String(b.shape ?? 'square'),
				x: Number(b.x ?? 100),
				y: Number(b.y ?? 100),
				width: Number(b.width ?? 60),
				height: Number(b.height ?? 60),
				rotation: 0,
				combinable: Boolean(b.combinable ?? true),
				isBookableOnline: Boolean(b.isBookableOnline ?? true),
				isAccessible: false,
				isHighTop: false,
				isPatio: false,
				resetBufferMin: 15,
				priority: tables.length,
				notes: null,
				isActive: true,
				archivedAt: null,
				version: 1,
			}
			tables = [...tables, created]
			settings.floorPlanVersion += 1
			return json(
				route,
				{ table: created, floorPlanVersion: settings.floorPlanVersion },
				201,
			)
		}
		if (method === 'GET' && subPath === '/combos') {
			return json(route, { combos })
		}
		if (method === 'POST' && subPath === '/combos') {
			const b = body as Record<string, unknown>
			const created = {
				id: `combo-${combos.length + 1}`,
				locationId,
				areaId: null,
				name: String(b.name),
				minCovers: Number(b.minCovers ?? 4),
				maxCovers: Number(b.maxCovers ?? 8),
				priority: 0,
				isBookableOnline: true,
				isActive: true,
				tableIds: (b.tableIds as string[]) ?? [],
				version: 1,
			}
			combos = [...combos, created]
			return json(
				route,
				{ combo: created, floorPlanVersion: settings.floorPlanVersion },
				201,
			)
		}
		if (method === 'GET' && subPath === '/services') {
			return json(route, { services })
		}
		if (method === 'POST' && subPath === '/services') {
			const b = body as Record<string, unknown>
			const created = {
				id: `svc-${services.length + 1}`,
				locationId,
				name: String(b.name),
				nameI18n: (b.nameI18n as Record<string, string>) ?? {
					en: String(b.name),
				},
				code: String(b.name).toLowerCase().replace(/\s+/g, '-'),
				daysOfWeek: (b.daysOfWeek as number[]) ?? [0, 1, 2, 3, 4, 5, 6],
				firstSeatingMin: Number(b.firstSeatingMin ?? 1020),
				lastSeatingMin: Number(b.lastSeatingMin ?? 1290),
				endMin: Number(b.endMin ?? 1380),
				slotIntervalMin: Number(b.slotIntervalMin ?? 15),
				defaultTurnTimeMin: 90,
				onlineBookable: Boolean(b.onlineBookable ?? true),
				sortOrder: services.length,
				color: null,
				isActive: true,
				archivedAt: null,
				version: 1,
			}
			services = [...services, created]
			return json(route, { service: created }, 201)
		}
		if (method === 'GET' && subPath === '/turn-times') {
			return json(route, { turnTimes })
		}
		if (method === 'POST' && subPath === '/turn-times') {
			const b = body as Record<string, unknown>
			const created = {
				id: `tt-${turnTimes.length + 1}`,
				locationId,
				serviceId: (b.serviceId as string | null) ?? null,
				partyMin: Number(b.partyMin),
				partyMax: Number(b.partyMax),
				minutes: Number(b.minutes),
				bufferMinutes: 15,
				version: 1,
			}
			turnTimes = [...turnTimes, created]
			return json(route, { turnTime: created }, 201)
		}
		if (method === 'GET' && subPath === '/pacing') {
			return json(route, { pacing })
		}
		if (method === 'POST' && subPath === '/pacing') {
			const b = body as Record<string, unknown>
			const created = {
				id: `pace-${pacing.length + 1}`,
				locationId,
				serviceId: (b.serviceId as string | null) ?? null,
				bucketMin: Number(b.bucketMin ?? 15),
				fromMin: null,
				toMin: null,
				maxCovers: (b.maxCovers as number | null) ?? null,
				maxParties: (b.maxParties as number | null) ?? null,
				rollingMin: null,
				rollingMaxCovers: null,
				channel: String(b.channel ?? 'all'),
				version: 1,
			}
			pacing = [...pacing, created]
			return json(route, { rule: created }, 201)
		}
		if (method === 'GET' && subPath === '/service-availability') {
			return json(route, { availability })
		}
		if (method === 'POST' && subPath === '/service-availability') {
			const b = body as Record<string, unknown>
			const created = {
				id: `avail-${availability.length + 1}`,
				locationId,
				serviceId: String(b.serviceId),
				areaId: (b.areaId as string | null) ?? null,
				tableId: (b.tableId as string | null) ?? null,
				comboId: (b.comboId as string | null) ?? null,
				mode: String(b.mode),
				fromMin: null,
				toMin: null,
				version: 1,
			}
			availability = [...availability, created]
			return json(route, { availability: created }, 201)
		}
		if (method === 'GET' && subPath === '/special-days') {
			return json(route, { specialDays })
		}
		if (method === 'POST' && subPath === '/special-days') {
			const b = body as Record<string, unknown>
			const created = {
				id: `sd-${specialDays.length + 1}`,
				locationId,
				date: String(b.fromDate),
				fromDate: String(b.fromDate),
				toDate: String(b.toDate),
				kind: String(b.kind),
				name: (b.name as string | null) ?? null,
				publicNoteI18n: (b.publicNoteI18n as Record<string, string>) ?? {},
				serviceId: (b.serviceId as string | null) ?? null,
				patch: null,
				services: null,
				version: 1,
			}
			specialDays = [...specialDays, created]
			return json(route, { specialDay: created }, 201)
		}
		if (method === 'GET' && subPath === '/blocks') {
			return json(route, { blocks })
		}
		if (method === 'POST' && subPath === '/blocks') {
			const b = body as Record<string, unknown>
			const created = {
				id: `blk-${blocks.length + 1}`,
				locationId,
				areaId: (b.areaId as string | null) ?? null,
				tableId: (b.tableId as string | null) ?? null,
				businessDate: String(b.businessDate),
				startAt: Date.now(),
				endAt: Date.now() + 3_600_000,
				startMin: Number(b.startMin ?? 1080),
				endMin: Number(b.endMin ?? 1200),
				reason: String(b.reason ?? 'private_event'),
				note: (b.note as string | null) ?? null,
				version: 1,
			}
			blocks = [...blocks, created]
			return json(route, { block: created }, 201)
		}

		return json(route, { error: 'Not found' }, 404)
	})

	return { requests }
}

test.describe('Reservations Setup & Floor Plan Designer', () => {
	test('hides Reservations card on Location Settings and returns 404 when reservations.enabled is off', async ({
		page,
		login,
		navigate,
	}) => {
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const location = await createLocationForOrg(org.id)

		await navigate('/:slug/settings/locations/:locationId', {
			slug: org.slug,
			locationId: location.id,
		})
		await expect(page.getByTestId('location-reservations-card')).toHaveCount(0)

		const response = await navigate('/:slug/reservations/settings', {
			slug: org.slug,
		})
		expect(response?.status()).toBe(404)
	})

	test('navigates from Location Settings card to Reservations Setup, manages General/Tables/Services/Special Days, and handles Time-Zone re-derive', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const location = await createLocationForOrg(org.id, {
			name: 'Flagship Bistro',
		})
		await enableReservationsFlag(org.id)
		const { requests } = await stubSetupApi(page, location.id, {
			tzMismatch: true,
		})

		// 1. Open Location Settings and verify Reservations status card + deep link
		await navigate('/:slug/settings/locations/:locationId', {
			slug: org.slug,
			locationId: location.id,
		})
		await expect(page.getByTestId('location-reservations-card')).toBeVisible()
		await page.getByTestId('location-reservations-settings-link').click()

		await expect(page).toHaveURL(
			new RegExp(
				`/${org.slug}/reservations/settings\\?location=${location.id}`,
			),
		)
		await expect(page.getByTestId('reservations-setup-shell')).toBeVisible()

		// 2. Verify Time-Zone mismatch banner & Re-derive action (VAL-SETUP-022)
		await expect(page.getByTestId('setup-tz-mismatch-banner')).toBeVisible()
		await page.getByTestId('setup-rederive-times-button').click()
		await expect(
			page.getByTestId('setup-rederive-success-banner'),
		).toBeVisible()
		expect(
			requests.some((r) => r.method === 'POST' && r.path === '/rederive-times'),
		).toBe(true)

		// 3. Save General & Policies settings
		await page.getByTestId('setup-default-turn-time-input').fill('105')
		await page.getByTestId('setup-save-general-button').click()
		await expect(page.getByTestId('setup-general-save-success')).toBeVisible()

		// 4. Switch to Areas, Tables & Combos tab
		await page.getByTestId('setup-group-floor').click()
		await expect(page.getByTestId('setup-tables-page')).toBeVisible()

		// Create Dining Area
		await page.getByTestId('setup-open-add-area').click()
		await page.getByTestId('setup-area-name-input').fill('Rooftop Terrace')
		await page.getByTestId('setup-add-area-button').click()
		await expect(
			page.getByTestId('setup-area-row-Rooftop Terrace'),
		).toBeVisible()

		// Create Table
		await page.getByTestId('setup-open-add-table').click()
		await page.getByTestId('setup-table-label-input').fill('T10')
		await page.getByTestId('setup-add-table-button').click()
		await expect(page.getByTestId('setup-table-row-T10')).toBeVisible()

		// Duplicate table label returns 409 error banner (inside the sheet)
		await page.getByTestId('setup-open-add-table').click()
		await page.getByTestId('setup-table-label-input').fill('T10')
		await page.getByTestId('setup-add-table-button').click()
		await expect(page.getByTestId('setup-tables-error-banner')).toContainText(
			'T10',
		)
		// The sheet holds an unsaved label, so closing it asks before discarding.
		await page.keyboard.press('Escape')
		await page.getByTestId('setup-confirm-discard').click()
		await expect(page.getByTestId('setup-table-label-input')).toBeHidden()

		// Create Table Combination
		await page.getByTestId('setup-open-add-combo').click()
		await page.getByTestId('setup-combo-name-input').fill('T1 + T2 Combo')
		await page.getByTestId('setup-combo-pick-T1').click()
		await page.getByTestId('setup-combo-pick-T2').click()
		await page.getByTestId('setup-add-combo-button').click()
		await expect(
			page.getByTestId('setup-combo-row-T1 + T2 Combo'),
		).toBeVisible()

		// 5. Switch to Services, Turn Times & Pacing tab
		await page.getByTestId('setup-group-services').click()
		await expect(page.getByTestId('setup-services-page')).toBeVisible()
		await expect(page.getByTestId('turn-times-contiguous-badge')).toBeVisible()

		await page.getByTestId('setup-new-service-button').click()
		await page.getByTestId('setup-service-name-input').fill('Weekend Brunch')
		await page.getByTestId('setup-add-service-button').click()
		await expect(
			page.getByTestId('setup-service-row-Weekend Brunch'),
		).toBeVisible()

		await page.getByTestId('setup-section-pacing-toggle').click()
		await page.getByTestId('setup-add-pacing-button').click()
		await expect(page.getByTestId('setup-pacing-row-15')).toBeVisible()

		// 6. Switch to Special Days & Blocks tab
		await page.getByTestId('setup-tab-special-days').click()
		await expect(page.getByTestId('setup-special-days-page')).toBeVisible()

		await page.getByTestId('setup-open-special-day-sheet').click()
		await page
			.getByTestId('setup-special-day-name-input')
			.fill('Private Buyout')
		await page.getByTestId('setup-add-special-day-button').click()
		await expect(
			page.getByTestId('setup-special-days-feedback-banner'),
		).toBeVisible()

		await page.getByTestId('setup-open-block-sheet').click()
		await page.getByTestId('setup-block-note-input').fill('AC maintenance')
		await page.getByTestId('setup-add-block-button').click()
		await expect(page.getByText('AC maintenance')).toBeVisible()
	})

	test('Floor-plan designer supports keyboard nudge with aria-live, explicit Save, 409 conflict banner, Leave-without-saving discard, and dir="ltr" under Arabic RTL', async ({
		page,
		login,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const location = await createLocationForOrg(org.id)
		await enableReservationsFlag(org.id)
		const { requests } = await stubSetupApi(page, location.id, {
			forceFloorPlanConflictOnce: true,
		})

		// Open Floor Plan Designer in Arabic (?lng=ar) to verify RTL chrome + LTR canvas (VAL-SETUP-032)
		await page.goto(
			`/${org.slug}/reservations/settings/floor-plan?location=${location.id}&lng=ar`,
		)
		await expect(page.getByTestId('floor-plan-editor')).toBeVisible()
		const htmlDir = await page.evaluate(() => document.documentElement.dir)
		expect(htmlDir).toBe('rtl')
		await expect(page.getByTestId('floor-plan-canvas-surface')).toHaveAttribute(
			'dir',
			'ltr',
		)

		// Select table T1 and nudge with keyboard arrows (+1 and Shift+Arrow +10)
		const tableT1 = page.getByTestId('floor-table-T1')
		await tableT1.click()
		await tableT1.press('ArrowRight')
		await expect(page.getByTestId('floor-plan-live-region')).toContainText(
			'101',
		)
		await tableT1.press('Shift+ArrowDown')
		await expect(page.getByTestId('floor-plan-live-region')).toContainText(
			'130',
		)

		// First Save triggers 409 stale_version conflict banner while preserving draft
		await page.getByTestId('floor-plan-save-button').click()
		await expect(page.getByTestId('floor-plan-conflict-banner')).toBeVisible()

		// Second Save succeeds and increments floor plan version
		await page.getByTestId('floor-plan-save-button').click()
		await expect(page.getByTestId('floor-plan-saved-banner')).toBeVisible()
		expect(
			requests.filter((r) => r.method === 'PUT' && r.path === '/floor-plan'),
		).toHaveLength(2)

		// Make an unsaved nudge and Leave without saving
		await tableT1.click()
		await tableT1.press('Shift+ArrowRight')
		await page.getByTestId('floor-plan-leave-button').click()
		await expect(
			page.getByTestId('floor-plan-leave-confirm-banner'),
		).toBeVisible()
		await page.getByTestId('floor-plan-confirm-leave-button').click()
		await expect(page).toHaveURL(
			new RegExp(`/${org.slug}/reservations/settings/tables`),
		)
	})

	test('Read-only operator with read:reservation_settings:any sees setup screens with mutation controls disabled/hidden', async ({
		page,
		login,
		navigate,
	}) => {
		const owner = await createTestUser()
		const org = await createTestOrganization(owner.id, 'admin')
		const location = await createLocationForOrg(org.id)
		await enableReservationsFlag(org.id)

		// Grant read:reservation_settings:any (and read:reservations:any) to org_role_viewer
		const perms = await db
			.select({
				id: Permission.id,
				action: Permission.action,
				entity: Permission.entity,
			})
			.from(Permission)
		const readSettingsPerm = perms.find(
			(p) => p.action === 'read' && p.entity === 'reservation_settings',
		)
		const readRsvPerm = perms.find(
			(p) => p.action === 'read' && p.entity === 'reservations',
		)
		for (const perm of [readSettingsPerm, readRsvPerm]) {
			if (perm) {
				await db
					.insert(_OrganizationPermissionToRole)
					.values({
						A: 'org_role_viewer',
						B: perm.id,
					})
					.onConflictDoNothing()
			}
		}

		const viewer = await login()
		await addOrganizationMember(viewer.id, org.id, 'org_role_viewer')
		await stubSetupApi(page, location.id)

		await navigate('/:slug/reservations/settings', { slug: org.slug })
		await expect(page.getByTestId('setup-readonly-banner')).toBeVisible()
		await expect(page.getByTestId('setup-general-form')).toBeVisible()
		await expect(page.getByTestId('setup-general-loading')).toHaveCount(0)
		await expect(page.getByTestId('setup-save-general-button')).toHaveCount(0)

		await page.getByTestId('setup-group-floor').click()
		await page.getByTestId('setup-tab-floor-plan').click()
		await expect(page.getByTestId('floor-plan-save-button')).toBeDisabled()
	})
})
