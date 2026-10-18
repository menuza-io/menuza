import { type Page } from '@playwright/test'
import { ConfigFlag, db, OrganizationLocation } from '@repo/database'
import { RESERVATIONS_FLAG_KEYS } from '@repo/reservations'
import { expect, test } from '#tests/playwright-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': 'authorization, content-type, if-none-match',
	'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
	'access-control-expose-headers': 'ETag, etag',
}

type StubRequest = { method: string; path: string; body: unknown }

async function enableReservationsFlags(organizationId: string) {
	await db.insert(ConfigFlag).values([
		{
			key: RESERVATIONS_FLAG_KEYS.enabled,
			value: true,
			level: 'organization',
			organizationId,
		},
		{
			key: RESERVATIONS_FLAG_KEYS.online,
			value: true,
			level: 'organization',
			organizationId,
		},
		{
			key: RESERVATIONS_FLAG_KEYS.waitlist,
			value: true,
			level: 'organization',
			organizationId,
		},
		{
			key: RESERVATIONS_FLAG_KEYS.payments,
			value: true,
			level: 'organization',
			organizationId,
		},
		{
			key: RESERVATIONS_FLAG_KEYS.experiences,
			value: true,
			level: 'organization',
			organizationId,
		},
	])
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
			name: overrides.name ?? 'Downtown Bistro',
			slug: overrides.slug ?? `downtown-${id}`,
			timezone: overrides.timezone ?? 'America/New_York',
			isActive: true,
		})
		.returning()
	return loc!
}

function json(
	route: any,
	data: unknown,
	status = 200,
	extraHeaders: Record<string, string> = {},
) {
	return route.fulfill({
		status,
		headers: {
			...CORS,
			'content-type': 'application/json',
			...extraHeaders,
		},
		body: JSON.stringify(data),
	})
}

async function stubHostStandApi(
	page: Page,
	locationId: string,
	options: {
		businessDate?: string
		forceVersionConflictOnce?: boolean
	} = {},
) {
	const requests: StubRequest[] = []
	const businessDate = options.businessDate ?? '2026-04-20'
	let dayVersion = 1
	let shouldForceVersionConflict = Boolean(options.forceVersionConflictOnce)

	const areas = [
		{
			id: 'area-main',
			locationId,
			name: 'Main Dining',
			nameI18n: { en: 'Main Dining', ar: 'الصالة الرئيسية' },
			sortOrder: 0,
			isOutdoor: false,
			isBookableOnline: true,
			isActive: true,
			version: 1,
		},
		{
			id: 'area-patio',
			locationId,
			name: 'Patio',
			nameI18n: { en: 'Patio', ar: 'التراس' },
			sortOrder: 1,
			isOutdoor: true,
			isBookableOnline: true,
			isActive: true,
			version: 1,
		},
	]

	const tables = [
		{
			id: 'table-1',
			locationId,
			areaId: 'area-main',
			label: 'T1',
			minCovers: 2,
			maxCovers: 4,
			shape: 'round',
			x: 80,
			y: 90,
			width: 96,
			height: 96,
			rotation: 0,
			combinable: true,
			isBookableOnline: true,
			isActive: true,
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
			x: 240,
			y: 90,
			width: 96,
			height: 96,
			rotation: 0,
			combinable: true,
			isBookableOnline: true,
			isActive: true,
			version: 1,
		},
		{
			id: 'table-3',
			locationId,
			areaId: 'area-patio',
			label: 'P1',
			minCovers: 2,
			maxCovers: 6,
			shape: 'rect',
			x: 420,
			y: 90,
			width: 120,
			height: 96,
			rotation: 0,
			combinable: false,
			isBookableOnline: true,
			isActive: true,
			version: 1,
		},
	]

	const services = [
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
			color: '#3b82f6',
			isActive: true,
			version: 1,
		},
	]

	let sectionLayouts: Array<Record<string, any>> = [
		{
			id: 'layout-dinner-1',
			locationId,
			serviceId: 'svc-dinner',
			name: 'Dinner Standard',
			isDefault: true,
			version: 1,
			sections: [
				{
					id: 'sec-a',
					name: 'Section A',
					colorToken: '1',
					serverName: 'Layla',
					tableIds: ['table-1', 'table-2'],
				},
				{
					id: 'sec-b',
					name: 'Patio Section',
					colorToken: '2',
					serverName: 'Omar',
					tableIds: ['table-3'],
				},
			],
		},
	]

	let sectionAssignments: Array<{
		sectionId: string
		serverLabel: string | null
	}> = [
		{ sectionId: 'sec-a', serverLabel: 'Layla' },
		{ sectionId: 'sec-b', serverLabel: 'Omar' },
	]

	let serviceNotes: Array<Record<string, any>> = [
		{
			id: 'note-1',
			locationId,
			businessDate,
			serviceId: 'svc-dinner',
			note: 'Welcome VIP table T1 with sparkling water',
			version: 1,
		},
	]

	let reservations: Array<Record<string, any>> = [
		{
			id: 'rsv-1',
			locationId,
			confirmationCode: 'RSV101',
			guestId: 'guest-1',
			guestName: 'Nadia Al-Mansoor',
			guestPhone: '+15550101001',
			guestEmail: 'nadia@example.com',
			partySize: 4,
			businessDate,
			localStartMin: 1140, // 19:00
			durationMin: 90,
			status: 'confirmed',
			channel: 'phone',
			serviceId: 'svc-dinner',
			areaPrefId: 'area-main',
			tableIds: ['table-1'],
			lockTable: false,
			locked: false,
			occasion: 'anniversary',
			dietaryNotes: 'nut_allergy',
			guestRequests: 'Quiet corner please',
			staffNotes: 'Friends of GM',
			vipTier: 'vip',
			visitCount: 8,
			noShowCount: 0,
			version: 1,
		},
		{
			id: 'rsv-locked',
			locationId,
			confirmationCode: 'RSV202',
			guestId: 'guest-2',
			guestName: 'Tariq Hassan',
			guestPhone: '+15550102002',
			partySize: 2,
			businessDate,
			localStartMin: 1080, // 18:00
			durationMin: 90,
			status: 'seated',
			seatedAt: Date.now() - 25 * 60_000,
			channel: 'online',
			serviceId: 'svc-dinner',
			areaPrefId: 'area-main',
			tableIds: ['table-2'],
			lockTable: true,
			locked: true,
			courseStage: 'main',
			version: 1,
		},
		{
			id: 'rsv-unassigned',
			locationId,
			confirmationCode: 'RSV303',
			guestId: 'guest-3',
			guestName: 'Samira Khaled',
			guestPhone: '+15550103003',
			partySize: 6,
			businessDate,
			localStartMin: 1170, // 19:30
			durationMin: 90,
			status: 'booked',
			channel: 'online',
			serviceId: 'svc-dinner',
			areaPrefId: 'area-patio',
			tableIds: [],
			lockTable: false,
			locked: false,
			version: 1,
		},
	]

	const moveNotices = [
		{
			reservationId: 'rsv-1',
			confirmationCode: 'RSV101',
			guestName: 'Nadia Al-Mansoor',
			partySize: 4,
			localStartMin: 1140,
			hhmm: '19:00',
			fromTableIds: ['table-2'],
			fromTableLabels: ['T2'],
			toTableIds: ['table-1'],
			toTableLabels: ['T1'],
			reason: 'Reflowed after turn extension on T2',
		},
	]

	await page.route('**/operator/reservations/**', async (route) => {
		const request = route.request()
		if (request.method() === 'OPTIONS') {
			return route.fulfill({ status: 204, headers: CORS })
		}
		const url = new URL(request.url())
		const pathname = url.pathname
		const method = request.method()
		const body = request.postDataJSON?.() ?? null
		requests.push({ method, path: pathname, body })

		// 1. Day feed with ETag support
		if (method === 'GET' && pathname === '/operator/reservations/book/day') {
			const currentEtag = `"day-v${dayVersion}"`
			const ifNoneMatch =
				request.headers()['if-none-match'] ??
				request.headers()['If-None-Match'] ??
				null
			if (ifNoneMatch && ifNoneMatch === currentEtag) {
				return route.fulfill({
					status: 304,
					headers: { ...CORS, ETag: currentEtag },
				})
			}
			const reqDate = url.searchParams.get('date') || businessDate
			return json(
				route,
				{
					etag: currentEtag,
					dayVersion,
					settingsVersion: 1,
					floorPlanVersion: 1,
					locationId,
					businessDate: reqDate,
					timezone: 'America/New_York',
					dayStartMin: 240,
					areas,
					tables,
					combinations: [],
					elements: [
						{
							id: 'el-bar',
							locationId,
							areaId: 'area-main',
							kind: 'bar',
							label: 'Main Bar',
							x: 600,
							y: 80,
							width: 140,
							height: 48,
							rotation: 0,
						},
					],
					services,
					sectionLayouts,
					sectionAssignments,
					serviceNotes,
					scheduleBlocks: [],
					reservations,
					waitlist: [],
					holds: [],
					pacing: [
						{
							localMin: 1080,
							bookedCovers: 8,
							maxCovers: 20,
						},
						{
							localMin: 1140,
							bookedCovers: 18,
							maxCovers: 20,
						},
					],
					moveNotices,
				},
				200,
				{ ETag: currentEtag },
			)
		}

		// 2. Availability slots for booking sheet
		if (
			method === 'GET' &&
			pathname === '/operator/reservations/book/availability'
		) {
			return json(route, {
				slots: [
					{
						localStartMin: 1110,
						hhmm: '18:30',
						status: 'available',
						serviceId: 'svc-dinner',
						serviceName: 'Dinner',
						suggestedTableIds: ['table-1'],
						suggestedTableLabels: ['T1'],
						remainingCovers: 14,
					},
					{
						localStartMin: 1200,
						hhmm: '20:00',
						status: 'available',
						serviceId: 'svc-dinner',
						serviceName: 'Dinner',
						suggestedTableIds: ['table-3'],
						suggestedTableLabels: ['P1'],
						remainingCovers: 12,
					},
				],
			})
		}

		// 3. Guest search for phone booking sheet
		if (
			method === 'GET' &&
			(pathname === '/operator/reservations/book/guests/lookup' ||
				pathname === '/operator/reservations/book/guests/search')
		) {
			return json(route, {
				guests: [
					{
						id: 'guest-vip-1',
						fullName: 'Layla Al-Rashid',
						phone: '+15550199999',
						email: 'layla@example.com',
						vipStatus: 'vip',
						tags: ['vip', 'wine_lover'],
						dietaryCodes: ['gluten_free'],
						allergyNotes: 'Gluten sensitivity',
						seatingPreference: 'Window table',
						visitCount: 12,
						noShowCount: 0,
						cancellationCount: 1,
					},
				],
			})
		}

		// 4. Create phone/host reservation
		if (
			method === 'POST' &&
			pathname === '/operator/reservations/book/reservations'
		) {
			const b = (body ?? {}) as Record<string, any>
			dayVersion += 1
			const created = {
				id: `rsv-new-${dayVersion}`,
				locationId,
				confirmationCode: `NEW${dayVersion}`,
				guestId: b.guestId ?? 'guest-new',
				guestName: String(b.guestName ?? 'Phone Guest'),
				guestPhone: String(b.guestPhone ?? '+15550188888'),
				partySize: Number(b.partySize ?? 2),
				businessDate: String(b.businessDate ?? businessDate),
				localStartMin: Number(b.localStartMin ?? 1200),
				durationMin: Number(b.durationMin ?? 90),
				status: 'confirmed',
				channel: 'phone',
				serviceId: b.serviceId ?? 'svc-dinner',
				areaPrefId: b.areaPrefId ?? 'area-main',
				tableIds: Array.isArray(b.tableIds) ? b.tableIds : ['table-3'],
				lockTable: Boolean(b.lockTable),
				locked: Boolean(b.lockTable),
				version: 1,
			}
			reservations = [...reservations, created]
			return json(route, { reservation: created, moveNotices: [] }, 201)
		}

		// 5. Seat walk-in immediately
		if (
			method === 'POST' &&
			pathname === '/operator/reservations/book/walk-ins'
		) {
			const b = (body ?? {}) as Record<string, any>
			dayVersion += 1
			const created = {
				id: `rsv-walkin-${dayVersion}`,
				locationId,
				confirmationCode: `WLK${dayVersion}`,
				guestName: String(b.guestName ?? 'Walk-In Party'),
				guestPhone: String(b.guestPhone ?? ''),
				partySize: Number(b.partySize ?? 2),
				businessDate: String(b.businessDate ?? businessDate),
				localStartMin: Number(b.localStartMin ?? 1140),
				durationMin: 90,
				status: 'seated',
				seatedAt: Date.now(),
				channel: 'walk_in',
				serviceId: 'svc-dinner',
				areaPrefId: 'area-patio',
				tableIds:
					Array.isArray(b.tableIds) && b.tableIds.length > 0
						? b.tableIds
						: ['table-3'],
				version: 1,
			}
			reservations = [...reservations, created]
			return json(route, { reservation: created, moveNotices: [] }, 201)
		}

		// 6. Reservation Detail & Mutations
		const rsvMatch = pathname.match(
			/^\/operator\/reservations\/book\/reservations\/([^/]+)(?:\/([a-z-]+))?$/,
		)
		if (rsvMatch) {
			const rsvId = decodeURIComponent(rsvMatch[1]!)
			const subAction = rsvMatch[2] ?? null
			const existing =
				reservations.find((r) => r.id === rsvId) ?? reservations[0]!

			if (method === 'GET' && !subAction) {
				return json(route, {
					reservation: existing,
					guest: {
						id: existing.guestId ?? 'guest-1',
						fullName: existing.guestName,
						phone: existing.guestPhone,
						email: existing.guestEmail ?? null,
						vipStatus: existing.vipTier ?? 'regular',
						tags: existing.vipTier ? ['vip'] : [],
						dietaryCodes: existing.dietaryNotes ? [existing.dietaryNotes] : [],
						visitCount: existing.visitCount ?? 3,
						noShowCount: 0,
						cancellationCount: 0,
					},
					history: [],
					auditLog: [
						{
							id: 'aud-1',
							action: 'created',
							actorName: 'Host Stand',
							createdAt: Date.now() - 3600_000,
						},
					],
				})
			}

			if (method === 'PATCH' && !subAction) {
				if (shouldForceVersionConflict) {
					shouldForceVersionConflict = false
					return json(
						route,
						{
							error: 'VERSION_CONFLICT',
							message: 'Reservation was modified by another host',
						},
						409,
					)
				}
				const b = (body ?? {}) as Record<string, any>
				dayVersion += 1
				const updated = {
					...existing,
					...(b.localStartMin !== undefined
						? { localStartMin: Number(b.localStartMin) }
						: {}),
					...(b.durationMin !== undefined
						? { durationMin: Number(b.durationMin) }
						: {}),
					...(b.partySize !== undefined
						? { partySize: Number(b.partySize) }
						: {}),
					...(Array.isArray(b.tableIds) ? { tableIds: b.tableIds } : {}),
					...(b.locked !== undefined
						? { locked: Boolean(b.locked), lockTable: Boolean(b.locked) }
						: {}),
					...(b.unlock ? { locked: false, lockTable: false } : {}),
					version: Number(existing.version ?? 1) + 1,
				}
				reservations = reservations.map((r) => (r.id === rsvId ? updated : r))
				return json(route, { reservation: updated, moveNotices: [] })
			}

			if (method === 'POST' && subAction === 'status') {
				const b = (body ?? {}) as Record<string, any>
				dayVersion += 1
				const nextStatus = String(b.status ?? b.toStatus ?? 'arrived')
				const updated = {
					...existing,
					status: nextStatus,
					...(nextStatus === 'seated' ? { seatedAt: Date.now() } : {}),
					version: Number(existing.version ?? 1) + 1,
				}
				reservations = reservations.map((r) => (r.id === rsvId ? updated : r))
				return json(route, {
					reservation: updated,
					undoToken: `undo-${dayVersion}`,
					undoExpiresAt: Date.now() + 60_000,
					moveNotices: [],
				})
			}

			if (method === 'POST' && subAction === 'undo') {
				dayVersion += 1
				const updated = {
					...existing,
					status: 'confirmed',
					version: Number(existing.version ?? 1) + 1,
				}
				reservations = reservations.map((r) => (r.id === rsvId ? updated : r))
				return json(route, { reservation: updated })
			}

			if (method === 'POST' && subAction === 'assign') {
				if (shouldForceVersionConflict) {
					shouldForceVersionConflict = false
					return json(
						route,
						{
							error: 'VERSION_CONFLICT',
							message: 'Reservation was modified by another host',
						},
						409,
					)
				}
				const b = (body ?? {}) as Record<string, any>
				dayVersion += 1
				const updated = {
					...existing,
					tableIds: Array.isArray(b.tableIds) ? b.tableIds : existing.tableIds,
					locked:
						b.locked !== undefined
							? Boolean(b.locked)
							: b.unlock
								? false
								: Boolean(existing.locked),
					lockTable:
						b.locked !== undefined
							? Boolean(b.locked)
							: b.unlock
								? false
								: Boolean(existing.lockTable),
					version: Number(existing.version ?? 1) + 1,
				}
				reservations = reservations.map((r) => (r.id === rsvId ? updated : r))
				return json(route, {
					reservation: updated,
					swappedReservation: null,
					moveNotices: [],
				})
			}

			if (
				method === 'POST' &&
				(subAction === 'running-late' || subAction === 'late')
			) {
				const b = (body ?? {}) as Record<string, any>
				dayVersion += 1
				const updated = {
					...existing,
					runningLateMin: Number(b.runningLateMin ?? b.minutes ?? 15),
					version: Number(existing.version ?? 1) + 1,
				}
				reservations = reservations.map((r) => (r.id === rsvId ? updated : r))
				return json(route, { reservation: updated })
			}

			if (method === 'POST' && subAction === 'contact') {
				const b = (body ?? {}) as Record<string, any>
				dayVersion += 1
				const updated = {
					...existing,
					contactStatus: String(
						b.contactStatus ?? b.status ?? 'confirmed_by_phone',
					),
					version: Number(existing.version ?? 1) + 1,
				}
				reservations = reservations.map((r) => (r.id === rsvId ? updated : r))
				return json(route, { reservation: updated })
			}

			if (method === 'POST' && subAction === 'course') {
				const b = (body ?? {}) as Record<string, any>
				dayVersion += 1
				const updated = {
					...existing,
					courseStage: String(b.courseStage ?? 'dessert'),
					version: Number(existing.version ?? 1) + 1,
				}
				reservations = reservations.map((r) => (r.id === rsvId ? updated : r))
				return json(route, { reservation: updated })
			}
		}

		// 7. Calendar Month summary
		if (
			method === 'GET' &&
			pathname === '/operator/reservations/book/calendar'
		) {
			const month = url.searchParams.get('month') || '2026-04'
			return json(route, {
				locationId,
				month,
				timezone: 'America/New_York',
				days: [
					{
						date: `${month}-20`,
						dayOfWeek: 1,
						isClosed: false,
						specialLabel: 'Chef Tasting Night',
						specialKind: 'modified',
						totalCovers: 42,
						totalParties: 11,
						seatedCovers: 12,
						completedCovers: 18,
						cancelledCount: 1,
						noShowCount: 0,
						waitlistCount: 2,
						maxCapacityCovers: 80,
						occupancyRatio: 0.525,
						pacingPct: 53,
						services: [
							{
								serviceId: 'svc-dinner',
								name: 'Dinner',
								color: '#3b82f6',
								covers: 42,
								parties: 11,
								maxCovers: 80,
							},
						],
					},
				],
			})
		}

		// 8. Pre-service Overview
		if (
			method === 'GET' &&
			pathname === '/operator/reservations/book/overview'
		) {
			return json(route, {
				locationId,
				businessDate,
				serviceId: url.searchParams.get('serviceId') ?? null,
				timezone: 'America/New_York',
				stats: {
					partyCount: reservations.length,
					expectedCovers: reservations.reduce((s, r) => s + r.partySize, 0),
					vipsCount: 1,
					allergiesCount: 1,
					occasionsCount: 1,
					largePartiesCount: 1,
					firstTimersCount: 1,
				},
				vips: reservations.filter((r) => r.id === 'rsv-1'),
				allergies: reservations.filter((r) => r.id === 'rsv-1'),
				occasions: reservations.filter((r) => r.id === 'rsv-1'),
				largeParties: reservations.filter((r) => r.id === 'rsv-unassigned'),
				firstTimers: [],
				parties: reservations,
				serviceNotes,
				sectionAssignments,
				pacingBuckets: [
					{
						startMin: 1080,
						hhmm: '18:00',
						covers: 8,
						parties: 2,
						maxCovers: 20,
					},
					{
						startMin: 1140,
						hhmm: '19:00',
						covers: 18,
						parties: 4,
						maxCovers: 20,
					},
				],
			})
		}

		// 9. Save service notes
		if (
			method === 'PUT' &&
			pathname === '/operator/reservations/book/service-notes'
		) {
			const b = (body ?? {}) as Record<string, any>
			dayVersion += 1
			const saved = {
				id: 'note-1',
				locationId,
				businessDate: String(b.date ?? b.businessDate ?? businessDate),
				serviceId: b.serviceId ?? 'svc-dinner',
				note: String(b.note ?? b.body ?? ''),
				body: String(b.body ?? b.note ?? ''),
				version: 2,
			}
			serviceNotes = [saved]
			return json(route, { serviceNote: saved })
		}

		// 10. Save section server assignments
		if (
			method === 'PUT' &&
			pathname === '/operator/reservations/book/sections/assignments'
		) {
			const b = (body ?? {}) as Record<string, any>
			dayVersion += 1
			if (Array.isArray(b.assignments)) {
				sectionAssignments = b.assignments as Array<{
					sectionId: string
					serverLabel: string | null
				}>
			}
			return json(route, { assignments: sectionAssignments })
		}

		// 11. Setup endpoints used by Settings -> Sections
		if (
			method === 'GET' &&
			pathname ===
				`/operator/reservations/setup/locations/${locationId}/floor-plan`
		) {
			return json(route, {
				locationId,
				floorPlanVersion: 1,
				version: 1,
				areas,
				tables,
				combos: [],
				elements: [],
			})
		}

		if (
			method === 'GET' &&
			pathname === `/operator/reservations/setup/locations/${locationId}/tables`
		) {
			return json(route, { tables })
		}

		if (
			method === 'GET' &&
			pathname === `/operator/reservations/setup/locations/${locationId}/areas`
		) {
			return json(route, { areas })
		}

		if (
			method === 'GET' &&
			pathname ===
				`/operator/reservations/setup/locations/${locationId}/services`
		) {
			return json(route, { services })
		}

		if (
			method === 'GET' &&
			pathname === '/operator/reservations/setup/sections/layouts'
		) {
			return json(route, { layouts: sectionLayouts })
		}

		if (
			method === 'POST' &&
			pathname === '/operator/reservations/setup/sections/layouts'
		) {
			const b = (body ?? {}) as Record<string, any>
			const created = {
				id: `layout-${sectionLayouts.length + 1}`,
				locationId,
				serviceId: b.serviceId ?? null,
				name: String(b.name ?? 'New Layout'),
				isDefault: Boolean(b.isDefault),
				version: 1,
				sections: Array.isArray(b.sections) ? b.sections : [],
			}
			sectionLayouts = [...sectionLayouts, created]
			return json(route, { layout: created }, 201)
		}

		return json(route, { ok: true })
	})

	return { requests }
}

test.describe('Reservations Book & Host Stand UI', () => {
	test('Today, Book, Phone Booking Sheet, Walk-In Modal, Detail Sheet (?r=<id> preserving query params), 60s Undo, and Conflict Panel', async ({
		page,
		login,
		navigate,
	}) => {
		test.setTimeout(120_000)
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const location = await createLocationForOrg(org.id)
		await enableReservationsFlags(org.id)
		const { requests } = await stubHostStandApi(page, location.id)

		// 1. Today Board (VAL-BOOK-023)
		await navigate('/:slug/reservations/today', { slug: org.slug })
		await expect(page.getByTestId('reservations-today-view')).toBeVisible()
		await expect(page.getByTestId('today-kpi-cards')).toBeVisible()
		await expect(page.getByTestId('today-upcoming-card-rsv-1')).toBeVisible()
		await expect(page.getByTestId('today-seated-card-rsv-locked')).toBeVisible()
		await expect(page.getByTestId('host-subnav-service-notes')).toContainText(
			'Welcome VIP table T1 with sparkling water',
		)

		// 2. Navigate to Book View with date, service, and area params
		await page.goto(
			`/${org.slug}/reservations/book?date=2026-04-20&service=svc-dinner&area=area-main`,
		)
		await expect(page.getByTestId('reservations-book-view')).toBeVisible()
		await expect(page.getByTestId('book-row-rsv-1')).toBeVisible()

		// 3. Open Detail Sheet via row click and verify ?r=<id> preserves date/service/area (VAL-BOOK-027)
		await page.getByTestId('book-details-rsv-1').click()
		await expect(page.getByTestId('reservation-detail-sheet')).toBeVisible()
		await expect(page).toHaveURL(/r=rsv-1/)
		await expect(page).toHaveURL(/date=2026-04-20/)
		await expect(page).toHaveURL(/service=svc-dinner/)
		await expect(page).toHaveURL(/area=area-main/)
		await expect(page.getByTestId('detail-guest-crm')).toBeVisible()

		// Mark Arrived -> 60s Undo banner appears -> Undo restores status (VAL-BOOK-028, VAL-BOOK-035)
		await page.getByTestId('detail-status-arrived').click()
		await expect(page.getByTestId('detail-undo-banner')).toBeVisible()
		await page.getByTestId('detail-undo-btn').click()
		await expect
			.poll(() =>
				requests.some(
					(r) =>
						r.method === 'POST' &&
						r.path === '/operator/reservations/book/reservations/rsv-1/undo',
				),
			)
			.toBe(true)

		// Running Late +15m and Contact Tracking
		await page.getByTestId('detail-late-15').click()
		await expect
			.poll(() =>
				requests.some(
					(r) =>
						r.method === 'POST' &&
						r.path ===
							'/operator/reservations/book/reservations/rsv-1/running-late',
				),
			)
			.toBe(true)

		// Close detail sheet via Escape
		await page.keyboard.press('Escape')

		// 4. Open Phone Booking Sheet, search returning guest, select slot, and submit (VAL-BOOK-025)
		await page.getByTestId('open-booking-sheet-btn').click()
		await expect(page.getByTestId('booking-sheet')).toBeVisible()
		await page.getByTestId('booking-guest-search').fill('Layla')
		await expect(
			page.getByTestId('booking-guest-result-guest-vip-1'),
		).toBeVisible()
		await page.getByTestId('booking-guest-result-guest-vip-1').click()
		await expect(page.getByTestId('booking-returning-guest-card')).toBeVisible()
		await page.getByTestId('booking-slot-1200').click()
		await page.getByTestId('booking-submit-btn').click()
		await expect
			.poll(() =>
				requests.some(
					(r) =>
						r.method === 'POST' &&
						r.path === '/operator/reservations/book/reservations',
				),
			)
			.toBe(true)

		// Close detail sheet opened for newly created reservation
		await page.keyboard.press('Escape')

		// 5. Open Walk-In Modal and seat walk-in immediately (VAL-BOOK-026)
		await page.getByTestId('open-walk-in-btn').click()
		await expect(page.getByTestId('walk-in-dialog')).toBeVisible()
		await page.getByTestId('walk-in-size-4').click()
		await page.getByTestId('walk-in-guest-name').fill('Walk-In VIP')
		await page.getByTestId('walk-in-submit-btn').click()
		await expect
			.poll(() =>
				requests.some(
					(r) =>
						r.method === 'POST' &&
						r.path === '/operator/reservations/book/walk-ins',
				),
			)
			.toBe(true)

		// 6. Open Conflict & Unassigned Panel and verify reflow notices + unassigned list (VAL-BOOK-038, VAL-HOST-009)
		await page.getByTestId('open-conflict-panel-btn').click()
		await expect(page.getByTestId('conflict-panel')).toBeVisible()
		await expect(page.getByTestId('move-notice-rsv-1')).toBeVisible()
	})

	test('Timeline on 1024x768 iPad landscape supports keyboard DnD with aria-live, locked-bar Unlock prompt, and 409 VERSION_CONFLICT recovery', async ({
		page,
		login,
	}) => {
		test.setTimeout(120_000)
		await page.setViewportSize({ width: 1024, height: 768 })
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const location = await createLocationForOrg(org.id)
		await enableReservationsFlags(org.id)
		const { requests } = await stubHostStandApi(page, location.id, {
			forceVersionConflictOnce: true,
		})

		await page.goto(
			`/${org.slug}/reservations/timeline?location=${location.id}&date=2026-04-20`,
		)
		await expect(page.getByTestId('reservations-timeline-view')).toBeVisible()
		await expect(page.getByTestId('timeline-pacing-strip')).toBeVisible()
		await expect(
			page.getByTestId('timeline-unassigned-chip-rsv-unassigned'),
		).toBeVisible()

		// Verify no page-level horizontal scroll overflow on 1024x768 iPad landscape (VAL-HOST-025)
		const hasPageOverflow = await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth + 2,
		)
		expect(hasPageOverflow).toBe(false)

		// 1. First keyboard move on rsv-1 hits 409 VERSION_CONFLICT -> shows error banner & refreshes (VAL-HOST-008, VAL-HOST-010)
		const bar1 = page.getByTestId('timeline-bar-rsv-1')
		await bar1.focus()
		await bar1.press(' ')
		await expect(page.getByTestId('timeline-aria-live')).toContainText(
			'Grabbed Nadia Al-Mansoor',
		)
		await bar1.press('ArrowRight')
		await expect(page.getByTestId('timeline-aria-live')).toContainText('19:15')
		await bar1.press('Enter')
		await expect(page.getByTestId('timeline-error-banner')).toBeVisible()

		// 2. Second keyboard move on rsv-1 succeeds
		await bar1.focus()
		await bar1.press(' ')
		await bar1.press('ArrowRight')
		await bar1.press('Enter')
		await expect
			.poll(
				() =>
					requests.filter(
						(r) =>
							r.method === 'PATCH' &&
							r.path === '/operator/reservations/book/reservations/rsv-1',
					).length,
			)
			.toBeGreaterThanOrEqual(2)

		// 3. Attempting to move locked bar rsv-locked prompts "Unlock and move?" (VAL-HOST-004)
		const lockedBar = page.getByTestId('timeline-bar-rsv-locked')
		await lockedBar.focus()
		await lockedBar.press(' ')
		await lockedBar.press('ArrowRight')
		await lockedBar.press('Enter')
		await expect(page.getByTestId('timeline-unlock-move-prompt')).toBeVisible()
		await page.getByTestId('timeline-confirm-unlock-move').click()
		await expect
			.poll(() =>
				requests.some(
					(r) =>
						r.method === 'PATCH' &&
						r.path === '/operator/reservations/book/reservations/rsv-locked',
				),
			)
			.toBe(true)
	})

	test('Live Floor Plan (Arabic RTL), Section Layouts, Monthly Calendar drill-down, and Pre-Service Overview with Service Notes', async ({
		page,
		login,
	}) => {
		test.setTimeout(120_000)
		await page.setViewportSize({ width: 1024, height: 768 })
		const user = await login()
		const org = await createTestOrganization(user.id, 'admin')
		const location = await createLocationForOrg(org.id)
		await enableReservationsFlags(org.id)
		const { requests } = await stubHostStandApi(page, location.id)

		// 1. Section Layouts settings tab (VAL-HOST-018, VAL-HOST-019)
		await page.goto(
			`/${org.slug}/reservations/settings/sections?location=${location.id}`,
		)
		await expect(
			page.getByTestId('reservations-settings-sections-page'),
		).toBeVisible()
		await expect(
			page.getByTestId('section-layout-card-layout-dinner-1'),
		).toBeVisible()

		await page.getByTestId('section-layout-open-create').click()
		await page.getByTestId('section-layout-name-input').fill('Weekend 2-Server')
		await page.getByTestId('create-section-name-input-0').fill('Front Room')
		await page.getByTestId('create-section-table-toggle-0-table-1').click()
		await page.getByTestId('section-layout-create-submit').click()
		await expect(page.getByTestId('sections-feedback-banner')).toBeVisible()

		// 2. Live Floor Plan in Arabic RTL (?lng=ar) (VAL-HOST-012..017, VAL-HOST-020, VAL-HOST-028)
		await page.goto(
			`/${org.slug}/reservations/floor?location=${location.id}&date=2026-04-20&lng=ar`,
		)
		await expect(page.getByTestId('reservations-floor-page')).toBeVisible()
		const htmlDir = await page.evaluate(() => document.documentElement.dir)
		expect(htmlDir).toBe('rtl')
		await expect(page.getByTestId('floor-plan-canvas')).toHaveAttribute(
			'dir',
			'ltr',
		)

		// Toggle Section overlay and High-contrast mode
		await page.getByTestId('floor-section-overlay-toggle').click()
		await expect(page.getByTestId('floor-section-legend')).toBeVisible()
		await page.getByTestId('floor-high-contrast-toggle').click()
		await expect(page.getByTestId('reservations-floor-page')).toHaveAttribute(
			'data-high-contrast',
			'true',
		)

		// Click seated table T2 to open Quick Actions and advance course stage to Dessert (VAL-HOST-015)
		await page.getByTestId('floor-table-table-2').click()
		await expect(page.getByTestId('floor-table-quick-actions')).toBeVisible()
		await page.getByTestId('floor-action-course-dessert').click()
		await expect
			.poll(() =>
				requests.some(
					(r) =>
						r.method === 'POST' &&
						r.path ===
							'/operator/reservations/book/reservations/rsv-locked/course',
				),
			)
			.toBe(true)

		// Assign unassigned party onto occupied table T2 -> opens Swap/Reflow/Overbook prompt (VAL-HOST-014)
		await page.getByTestId('floor-assign-to-selected-rsv-unassigned').click()
		await expect(page.getByTestId('floor-occupied-drop-dialog')).toBeVisible()
		await page.getByTestId('floor-occupied-choice-reflow').click()

		// 3. Monthly Calendar & drill-down (VAL-HOST-021)
		await page.goto(
			`/${org.slug}/reservations/calendar?location=${location.id}&month=2026-04`,
		)
		await expect(page.getByTestId('reservations-calendar-page')).toBeVisible()
		await expect(
			page.getByTestId('calendar-day-special-2026-04-20'),
		).toBeVisible()
		await page.getByTestId('calendar-day-cell-2026-04-20').click()
		await expect(page).toHaveURL(
			new RegExp(`/${org.slug}/reservations/book.*date=2026-04-20`),
		)

		// 4. Pre-Service Overview & Per-Service Notes (VAL-HOST-022..024)
		await page.goto(
			`/${org.slug}/reservations/overview?location=${location.id}&date=2026-04-20`,
		)
		await expect(page.getByTestId('reservations-overview-page')).toBeVisible()
		await expect(page.getByTestId('overview-kpi-grid')).toBeVisible()
		await expect(page.getByTestId('overview-peak-slots-card')).toBeVisible()
		await expect(
			page.getByTestId('overview-large-party-item-rsv-unassigned'),
		).toBeVisible()
		await expect(page.getByTestId('overview-vip-item-rsv-1')).toBeVisible()

		await page
			.getByTestId('overview-service-notes-input')
			.fill('86 halibut; VIP table T1 arriving at 7pm')
		await page.getByTestId('overview-save-service-notes-btn').click()
		await expect(page.getByTestId('overview-note-saved-banner')).toBeVisible()
		await expect
			.poll(() =>
				requests.some(
					(r) =>
						r.method === 'PUT' &&
						r.path === '/operator/reservations/book/service-notes',
				),
			)
			.toBe(true)
	})
})
