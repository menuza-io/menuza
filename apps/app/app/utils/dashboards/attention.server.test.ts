import { ORDER_PROBLEMS_FLAG } from '@repo/common/order-problems'
import {
	_OrganizationPermissionToRole,
	and,
	ConfigFlag,
	db,
	eq,
	HomeAttentionDismissal,
	Organization,
	OrganizationLocation,
	OrganizationMenuItem,
	OrganizationMenuLocationOverride,
	OrganizationRole,
} from '@repo/database'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import {
	addOrganizationMember,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import {
	ATTENTION_DETECTORS,
	channelsOff,
	dismissAttention,
	loadActiveDismissals,
	loadAttention,
	loadAttentionOrganization,
	PAY_AT_PICKUP_ONLY_FLAG,
	runAttentionDetectors,
	type AttentionDetector,
	type AttentionLocation,
	type DetectorContext,
} from './attention.server.ts'
import { ATTENTION_DISMISS_MS, ATTENTION_KINDS } from './attention.ts'
import { restoreDishes } from './sold-out.server.ts'

vi.mock('./regional-home.server.ts', () => ({
	loadStockSoldOutItemIds: vi.fn(async () => [] as string[]),
	loadLaunchFacts: vi.fn(async () => null),
}))

const now = new Date('2026-06-10T15:00:00Z')
const HOUR = 60 * 60 * 1000

afterEach(() => {
	vi.restoreAllMocks()
})

function location(
	overrides: Partial<AttentionLocation> = {},
): AttentionLocation {
	return {
		id: 'loc_olaya',
		name: 'Olaya',
		timezone: 'Asia/Riyadh',
		storeHours: JSON.stringify([
			{
				day: 'monday',
				isOpen: true,
				slots: [{ start: '09:00', end: '22:00' }],
			},
		]),
		onlineHours: null,
		specialHours: null,
		fulfillmentOptions: null,
		scheduling: null,
		orderingPausedAt: null,
		orderingPausedUntil: null,
		busyExtraPrepMinutes: null,
		busyUntil: null,
		...overrides,
	}
}

async function context(
	organizationId: string,
	locations: AttentionLocation[],
	has: (permission: string) => boolean = () => true,
): Promise<DetectorContext> {
	const organization = (await loadAttentionOrganization(organizationId))!
	return { organization, locations, hasLocations: true, has, now }
}

async function createMember(organizationId: string, permissions: string[]) {
	const [role] = await db
		.insert(OrganizationRole)
		.values({
			name: `Custom ${crypto.randomUUID().slice(0, 8)}`,
			description: '',
			level: 0,
			organizationId,
		})
		.returning({ id: OrganizationRole.id })
	if (permissions.length > 0) {
		await db.insert(_OrganizationPermissionToRole).values(
			permissions.map((permission) => ({
				A: role!.id,
				B: `org_perm_${permission.replaceAll(':', '_')}`,
			})),
		)
	}
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, role!.id)
	return user
}

function kinds(items: Array<{ kind: string }>) {
	return items.map((item) => item.kind).sort()
}

describe('the detector registry', () => {
	it('declares a permission (and a flag, or none) for every detector', () => {
		for (const detector of ATTENTION_DETECTORS) {
			expect(detector.permission).toMatch(/^\w+:\w+:\w+$/)
			expect(detector).toHaveProperty('flag')
			expect(ATTENTION_KINDS).toContain(detector.kind)
		}
	})

	it('hides every detector from a viewer without its permission', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const ctx = await context(
			organization.id,
			[
				location({
					orderingPausedAt: new Date(now.getTime() - 3 * HOUR),
					fulfillmentOptions: JSON.stringify({ delivery: false }),
					storeHours: null,
				}),
			],
			() => false,
		)
		expect(await runAttentionDetectors(ctx)).toEqual([])
	})

	it('skips a failing detector and keeps the others', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
		const failing: AttentionDetector = {
			kind: 'reviews_unanswered',
			flag: null,
			permission: ORG_PERMISSIONS.READ_WEBSITE_ANY,
			detect: () => Promise.reject(new Error('provider down')),
		}
		const site = ATTENTION_DETECTORS.find(
			(detector) => detector.kind === 'site_unpublished',
		)!
		const items = await runAttentionDetectors(
			await context(organization.id, []),
			[failing, site],
		)
		expect(kinds(items)).toEqual(['site_unpublished'])
		expect(consoleError).toHaveBeenCalledWith(
			'attention detector failed',
			expect.objectContaining({
				kind: 'reviews_unanswered',
				organizationId: organization.id,
			}),
		)
	})
})

describe('detectors', () => {
	it('flags ordering paused for more than two hours as urgent, with Resume', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const paused = location({
			orderingPausedAt: new Date(now.getTime() - 3 * HOUR),
		})
		const recent = location({
			id: 'loc_recent',
			orderingPausedAt: new Date(now.getTime() - HOUR),
		})
		const items = await runAttentionDetectors(
			await context(organization.id, [paused, recent]),
			ATTENTION_DETECTORS.filter((d) => d.kind === 'ordering_paused'),
		)
		expect(items).toHaveLength(1)
		expect(items[0]).toMatchObject({
			kind: 'ordering_paused',
			urgency: 'urgent',
			dismissible: false,
			locationId: 'loc_olaya',
			canResume: true,
		})

		const readOnly = await runAttentionDetectors(
			await context(
				organization.id,
				[paused],
				(permission) => permission === ORG_PERMISSIONS.READ_MENU_ANY,
			),
			ATTENTION_DETECTORS.filter((d) => d.kind === 'ordering_paused'),
		)
		expect(readOnly[0]?.canResume).toBe(false)
	})

	it('says when delivery is switched off at a location', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		expect(channelsOff({ fulfillmentOptions: null, scheduling: null })).toEqual(
			[],
		)
		const items = await runAttentionDetectors(
			await context(organization.id, [
				location({
					fulfillmentOptions: JSON.stringify({ pickup: true, delivery: false }),
				}),
			]),
			ATTENTION_DETECTORS.filter((d) => d.kind === 'channel_off'),
		)
		expect(items).toEqual([
			expect.objectContaining({
				kind: 'channel_off',
				locationId: 'loc_olaya',
				channels: ['delivery'],
				dismissible: true,
			}),
		])
	})

	it('finds a location without opening hours and overrides in force', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const items = await runAttentionDetectors(
			await context(organization.id, [
				location({ storeHours: null }),
				location({
					id: 'loc_busy',
					busyExtraPrepMinutes: 15,
					busyUntil: new Date(now.getTime() + HOUR),
				}),
			]),
			ATTENTION_DETECTORS.filter((d) =>
				['no_hours', 'override_active'].includes(d.kind),
			),
		)
		expect(items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'no_hours', locationId: 'loc_olaya' }),
				expect.objectContaining({
					kind: 'override_active',
					locationId: 'loc_busy',
					overrides: ['busy'],
					minutes: 15,
					until: new Date(now.getTime() + HOUR).toISOString(),
				}),
			]),
		)
	})

	it('finds opening hours that look like a mistake until they are dismissed (#275)', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const week = JSON.stringify(
			[
				'monday',
				'tuesday',
				'wednesday',
				'thursday',
				'friday',
				'saturday',
				'sunday',
			].map((day) => ({
				day,
				isOpen: true,
				slots:
					day === 'monday'
						? [{ start: '10:00', end: '12:00' }]
						: [{ start: '10:00', end: '22:00' }],
			})),
		)
		const detectors = ATTENTION_DETECTORS.filter(
			(d) => d.kind === 'hours_look_wrong',
		)
		const items = await runAttentionDetectors(
			await context(organization.id, [
				location({ storeHours: week, timezone: 'UTC' }),
			]),
			detectors,
		)
		expect(items).toEqual([
			expect.objectContaining({
				kind: 'hours_look_wrong',
				locationId: 'loc_olaya',
				count: 1,
				dismissible: true,
				urgency: 'todo',
				href: '/settings/locations/loc_olaya',
			}),
		])
		const { savedHoursWarnings } =
			await import('#app/utils/location/hours-warnings.server.ts')
		const { fingerprint } = savedHoursWarnings({
			storeHours: week,
			onlineHours: null,
			specialHours: null,
		})
		const dismissed = await runAttentionDetectors(
			await context(organization.id, [
				location({
					storeHours: week,
					timezone: 'UTC',
					hoursWarningsDismissedFor: fingerprint,
				}),
			]),
			detectors,
		)
		expect(dismissed).toEqual([])
	})

	it('drops "payments not connected" once payments or pay at pickup are set', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const payments = ATTENTION_DETECTORS.filter(
			(d) => d.kind === 'payments_not_connected',
		)
		expect(
			kinds(
				await runAttentionDetectors(
					await context(organization.id, []),
					payments,
				),
			),
		).toEqual(['payments_not_connected'])

		await db
			.update(Organization)
			.set({
				shopPaymentProvider: 'checkout',
				checkoutSubEntityId: 'ent_1',
				checkoutChargesEnabled: true,
			})
			.where(eq(Organization.id, organization.id))
		expect(
			await runAttentionDetectors(await context(organization.id, []), payments),
		).toEqual([])
	})

	it('respects the pay at pickup choice', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await db.insert(ConfigFlag).values({
			key: PAY_AT_PICKUP_ONLY_FLAG,
			value: true,
			level: 'organization',
			organizationId: organization.id,
		})
		expect(
			await runAttentionDetectors(
				await context(organization.id, []),
				ATTENTION_DETECTORS.filter((d) => d.kind === 'payments_not_connected'),
			),
		).toEqual([])
	})

	it('counts sold-out dishes per location, not hidden ones', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const [olaya] = await db
			.insert(OrganizationLocation)
			.values({ organizationId: organization.id, name: 'Olaya', slug: 'olaya' })
			.returning({ id: OrganizationLocation.id })
		const dishes = await db
			.insert(OrganizationMenuItem)
			.values(
				['Shawarma', 'Falafel', 'Secret'].map((displayName) => ({
					organizationId: organization.id,
					displayName,
					price: 10,
				})),
			)
			.returning({ id: OrganizationMenuItem.id })
		await db
			.update(OrganizationMenuItem)
			.set({ availabilityStatus: 'hidden' })
			.where(eq(OrganizationMenuItem.id, dishes[2]!.id))
		await db.insert(OrganizationMenuLocationOverride).values(
			[dishes[0]!, dishes[1]!].map((dish) => ({
				organizationId: organization.id,
				locationId: olaya!.id,
				entityType: 'item',
				entityId: dish.id,
				availabilityStatus: 'unavailable',
			})),
		)
		const items = await runAttentionDetectors(
			await context(organization.id, [location({ id: olaya!.id })]),
			ATTENTION_DETECTORS.filter((d) => d.kind === 'dishes_unavailable'),
		)
		expect(items).toEqual([
			expect.objectContaining({
				kind: 'dishes_unavailable',
				locationId: olaya!.id,
				count: 2,
				canRestore: true,
			}),
		])
	})
})

describe('loadAttention', () => {
	it('carries no guest field in any item', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		await db.insert(OrganizationLocation).values({
			organizationId: organization.id,
			name: 'Olaya',
			slug: 'olaya',
			orderingPausedAt: new Date(now.getTime() - 5 * HOUR),
			fulfillmentOptions: JSON.stringify({ delivery: false }),
		})
		const data = await loadAttention({
			userId: user.id,
			organization: { id: organization.id },
			now,
		})
		expect(data.items.length).toBeGreaterThan(0)
		const allowed = new Set([
			'key',
			'kind',
			'urgency',
			'dismissible',
			'locationId',
			'locationName',
			'count',
			'since',
			'until',
			'href',
			'channels',
			'overrides',
			'minutes',
			'score',
			'canResume',
			'canRestore',
		])
		for (const item of data.items) {
			for (const field of Object.keys(item)) expect(allowed).toContain(field)
		}
		expect(JSON.stringify(data)).not.toMatch(/phone|email|contact|customer/i)
	})

	it('reads unanswered guest order problem reports only while the flag is on (#191)', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		const off = await loadAttention({
			userId: user.id,
			organization: { id: organization.id },
			now,
		})
		expect(off.regional.orderProblems).toBe(false)
		await db.insert(ConfigFlag).values({
			key: ORDER_PROBLEMS_FLAG,
			value: true,
			level: 'organization',
			organizationId: organization.id,
		})
		const on = await loadAttention({
			userId: user.id,
			organization: { id: organization.id },
			now,
		})
		expect(on.regional.orderProblems).toBe(true)
	})

	it('shows a member without the right permissions nothing to act on', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const viewer = await createMember(organization.id, [])
		const data = await loadAttention({
			userId: viewer.id,
			organization: { id: organization.id },
			now,
		})
		expect(data.items).toEqual([])
		expect(data.regional).toEqual({
			paymentReview: false,
			orderProblems: false,
			callFollowUps: false,
			inventoryCounts: false,
			offlineTablets: false,
		})
	})

	it('hides the reviews item from a member without the reviews permission', async () => {
		const reviews = ATTENTION_DETECTORS.find(
			(detector) => detector.kind === 'reviews_unanswered',
		)!
		expect(reviews.permission).toBe(ORG_PERMISSIONS.READ_WEBSITE_ANY)
		const { organization } = await setupTestOrgWithUser('admin')
		const spy = vi.spyOn(reviews, 'detect')
		await runAttentionDetectors(
			await context(organization.id, [], () => false),
			[reviews],
		)
		expect(spy).not.toHaveBeenCalled()
	})
})

describe('dismissals', () => {
	it('refuses to dismiss urgent items and unknown keys', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		for (const key of ['payments_not_connected:org', 'payment_review:loc_1']) {
			expect(
				await dismissAttention({
					userId: user.id,
					organizationId: organization.id,
					key,
				}),
			).toEqual({ ok: false, error: 'not_dismissible' })
		}
		expect(
			await dismissAttention({
				userId: user.id,
				organizationId: organization.id,
				key: 'nonsense',
			}),
		).toEqual({ ok: false, error: 'invalid_key' })
		expect(
			await db
				.select()
				.from(HomeAttentionDismissal)
				.where(eq(HomeAttentionDismissal.organizationId, organization.id)),
		).toEqual([])
	})

	it('dismisses advice for 7 days, per user', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const colleague = await createMember(organization.id, [])
		const result = await dismissAttention({
			userId: user.id,
			organizationId: organization.id,
			key: 'channel_off:loc_1',
			now,
		})
		expect(result).toEqual({
			ok: true,
			dismissedUntil: new Date(
				now.getTime() + ATTENTION_DISMISS_MS,
			).toISOString(),
		})
		expect(await loadActiveDismissals(user.id, organization.id, now)).toEqual([
			'channel_off:loc_1',
		])
		// Another member does not inherit it.
		expect(
			await loadActiveDismissals(colleague.id, organization.id, now),
		).toEqual([])
		// It still holds just before the week is over, and expires after.
		expect(
			await loadActiveDismissals(
				user.id,
				organization.id,
				new Date(now.getTime() + ATTENTION_DISMISS_MS - 1000),
			),
		).toEqual(['channel_off:loc_1'])
		expect(
			await loadActiveDismissals(
				user.id,
				organization.id,
				new Date(now.getTime() + ATTENTION_DISMISS_MS + 1000),
			),
		).toEqual([])
	})
})

describe('restoreDishes', () => {
	async function soldOutSetup() {
		const { organization } = await setupTestOrgWithUser('admin')
		const [olaya] = await db
			.insert(OrganizationLocation)
			.values({ organizationId: organization.id, name: 'Olaya', slug: 'olaya' })
			.returning({ id: OrganizationLocation.id })
		const [byHand] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: organization.id,
				displayName: 'Soup',
				price: 8,
			})
			.returning({ id: OrganizationMenuItem.id })
		const [byStock] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: organization.id,
				displayName: 'Salad',
				price: 9,
			})
			.returning({ id: OrganizationMenuItem.id })
		const { loadStockSoldOutItemIds } =
			await import('./regional-home.server.ts')
		vi.mocked(loadStockSoldOutItemIds).mockResolvedValue([byStock!.id])
		await db.insert(OrganizationMenuLocationOverride).values(
			[byHand!, byStock!].map((dish) => ({
				organizationId: organization.id,
				locationId: olaya!.id,
				entityType: 'item',
				entityId: dish.id,
				availabilityStatus: 'unavailable',
			})),
		)
		for (const key of ['inventory.enabled', 'inventory.recipes']) {
			await db.insert(ConfigFlag).values({
				key,
				value: true,
				level: 'organization',
				organizationId: organization.id,
			})
		}
		const attentionOrganization = (await loadAttentionOrganization(
			organization.id,
		))!
		return {
			organization: attentionOrganization,
			olaya: olaya!,
			byHand: byHand!,
			byStock: byStock!,
		}
	}

	async function overrideStatus(locationId: string, itemId: string) {
		const [row] = await db
			.select({ status: OrganizationMenuLocationOverride.availabilityStatus })
			.from(OrganizationMenuLocationOverride)
			.where(
				and(
					eq(OrganizationMenuLocationOverride.locationId, locationId),
					eq(OrganizationMenuLocationOverride.entityId, itemId),
				),
			)
		return row?.status
	}

	it('gives back dishes switched off by hand, never ones inventory holds', async () => {
		const { organization, olaya, byHand, byStock } = await soldOutSetup()
		const result = await restoreDishes({
			organization,
			locationId: olaya.id,
			itemIds: [byHand.id, byStock.id],
		})
		expect(result).toEqual({ ok: true, restored: 1, skippedByStock: 1 })
		// Back on sale: the location's sold-out mark is gone.
		expect(await overrideStatus(olaya.id, byHand.id)).not.toBe('unavailable')
		expect(await overrideStatus(olaya.id, byStock.id)).toBe('unavailable')
	})

	it('gives nothing back when the region cannot say what inventory holds', async () => {
		const { organization, olaya, byHand } = await soldOutSetup()
		const { loadStockSoldOutItemIds } =
			await import('./regional-home.server.ts')
		vi.mocked(loadStockSoldOutItemIds).mockResolvedValueOnce(null)
		expect(
			await restoreDishes({
				organization,
				locationId: olaya.id,
				itemIds: [byHand.id],
			}),
		).toEqual({ ok: false, error: 'stock_unknown' })
		expect(await overrideStatus(olaya.id, byHand.id)).toBe('unavailable')
	})
})
