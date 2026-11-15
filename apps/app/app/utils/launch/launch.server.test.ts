import {
	and,
	db,
	eq,
	isNotNull,
	OnboardingStepProgress,
	Organization,
	OrganizationImage,
	OrganizationLocation,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setMemberLocationScope } from '#app/utils/staffing/restaurant/location-scope.server.ts'
import {
	addOrganizationMember,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import {
	hasFullCategory,
	loadLaunchChecklist,
	setPayAtPickupOnly,
	skipLaunchStep,
} from './launch.server.ts'

const health = vi.hoisted(() => ({ score: 75 }))
vi.mock('#app/utils/menu/menu-health.server.ts', () => ({
	loadMenuHealth: vi.fn(async () => ({
		score: health.score,
		grade: 'C',
		fixCount: 0,
		checks: [],
		itemCount: 5,
		staleDismissals: [],
	})),
}))

const WEEK = JSON.stringify([
	{ day: 'monday', isOpen: true, slots: [{ start: '09:00', end: '21:00' }] },
])
const NO_FACTS = { pairedLocationIds: [], firstOrderAt: null }

beforeEach(() => {
	health.score = 75
})

async function createLocation(
	organizationId: string,
	values: Partial<typeof OrganizationLocation.$inferInsert> = {},
) {
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name: 'Olaya',
			slug: `loc-${crypto.randomUUID().slice(0, 8)}`,
			address: '1 King Fahd Rd',
			...values,
		})
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

async function buildMenu(organizationId: string, priced = 5) {
	const [category] = await db
		.insert(OrganizationMenuCategory)
		.values({ organizationId, displayName: 'Mains' })
		.returning({ id: OrganizationMenuCategory.id })
	const items = await db
		.insert(OrganizationMenuItem)
		.values(
			Array.from({ length: 5 }, (_, index) => ({
				organizationId,
				displayName: `Dish ${index}`,
				price: index < priced ? 12 : 0,
			})),
		)
		.returning({ id: OrganizationMenuItem.id })
	await db
		.insert(OrganizationMenuItemCategoryAssignment)
		.values(
			items.map((item) => ({ itemId: item.id, categoryId: category!.id })),
		)
}

/** Everything a location needs to be live, except what a test leaves out. */
async function readyOrganization(organizationId: string) {
	await buildMenu(organizationId)
	await db.insert(OrganizationImage).values({
		organizationId,
		objectKey: 'logo.png',
	})
	await db
		.update(Organization)
		.set({ sitePublished: true, siteTheme: '{"theme":"neutral"}' })
		.where(eq(Organization.id, organizationId))
	await setPayAtPickupOnly(organizationId, true)
}

function step(
	checklist: Awaited<ReturnType<typeof loadLaunchChecklist>>,
	locationId: string,
	key: string,
) {
	return checklist!.locations
		.find((location) => location.id === locationId)!
		.steps.find((entry) => entry.key === key)!
}

describe('hasFullCategory', () => {
	it('needs five priced dishes in one category', () => {
		const assignments = Array.from({ length: 5 }, (_, index) => ({
			categoryId: 'mains',
			itemId: `dish_${index}`,
		}))
		const priced = new Set(assignments.map((row) => row.itemId))
		expect(hasFullCategory(assignments, priced)).toBe(true)
		priced.delete('dish_4')
		expect(hasFullCategory(assignments, priced)).toBe(false)
	})
})

describe('loadLaunchChecklist', () => {
	it('shows the nine steps for a new location and ticks hours without a click', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const locationId = await createLocation(organization.id)

		const before = await loadLaunchChecklist({
			organizationId: organization.id,
			userId: user.id,
			facts: NO_FACTS,
		})
		expect(before!.locations[0]!.steps).toHaveLength(9)
		expect(step(before, locationId, 'launch_location_details').state).toBe(
			'todo',
		)
		expect(step(before, locationId, 'launch_station').state).toBe('optional')

		await db
			.update(OrganizationLocation)
			.set({ storeHours: WEEK })
			.where(eq(OrganizationLocation.id, locationId))
		const after = await loadLaunchChecklist({
			organizationId: organization.id,
			userId: user.id,
			facts: NO_FACTS,
		})
		const hours = step(after, locationId, 'launch_location_details')
		expect(hours.state).toBe('done')
		expect(hours.completedAt).not.toBeNull()
	})

	it('evaluates each location on its own and shares organization-wide steps', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const withHours = await createLocation(organization.id, {
			storeHours: WEEK,
		})
		const without = await createLocation(organization.id, { name: 'Malqa' })
		await setPayAtPickupOnly(organization.id, true)
		const checklist = await loadLaunchChecklist({
			organizationId: organization.id,
			userId: user.id,
			facts: { pairedLocationIds: [without], firstOrderAt: null },
		})
		expect(step(checklist, withHours, 'launch_location_details').state).toBe(
			'done',
		)
		expect(step(checklist, without, 'launch_location_details').state).toBe(
			'todo',
		)
		expect(step(checklist, without, 'launch_station').state).toBe('done')
		expect(step(checklist, withHours, 'launch_station').state).toBe('optional')
		for (const id of [withHours, without]) {
			expect(step(checklist, id, 'launch_payments').state).toBe('done')
		}
	})

	it('uses a menu health of 60 (grade D), not 70', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const locationId = await createLocation(organization.id)
		await buildMenu(organization.id)
		health.score = 62
		const passing = await loadLaunchChecklist({
			organizationId: organization.id,
			userId: user.id,
			facts: NO_FACTS,
		})
		expect(step(passing, locationId, 'launch_menu').state).toBe('done')
		health.score = 58
		const failing = await loadLaunchChecklist({
			organizationId: organization.id,
			userId: user.id,
			facts: NO_FACTS,
		})
		expect(step(failing, locationId, 'launch_menu').state).toBe('todo')
	})

	it('goes live without a paid order and loses live when hours are deleted', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const locationId = await createLocation(organization.id, {
			storeHours: WEEK,
		})
		await readyOrganization(organization.id)

		const live = await loadLaunchChecklist({
			organizationId: organization.id,
			userId: user.id,
			facts: NO_FACTS,
		})
		expect(live!.locations[0]).toMatchObject({ id: locationId, live: true })
		const firstLiveAt = live!.locations[0]!.liveAt
		expect(firstLiveAt).not.toBeNull()

		await db
			.update(OrganizationLocation)
			.set({ storeHours: null, onlineHours: null })
			.where(eq(OrganizationLocation.id, locationId))
		const lost = await loadLaunchChecklist({
			organizationId: organization.id,
			userId: user.id,
			facts: NO_FACTS,
		})
		expect(lost!.locations[0]!.live).toBe(false)
		expect(step(lost, locationId, 'launch_location_details')).toMatchObject({
			state: 'todo',
			completedAt: null,
		})
		// The first time live is kept (set once).
		expect(lost!.locations[0]!.liveAt).toBe(firstLiveAt)
	})

	it('shows a location-scoped member only their locations', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const mine = await createLocation(organization.id)
		await createLocation(organization.id, { name: 'Other' })
		const scoped = await createTestUser()
		await addOrganizationMember(scoped.id, organization.id)
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: scoped.id,
			value: { scope: 'selected', locationIds: [mine] },
		})
		const checklist = await loadLaunchChecklist({
			organizationId: organization.id,
			userId: scoped.id,
			facts: NO_FACTS,
		})
		expect(checklist!.locations.map((location) => location.id)).toEqual([mine])
	})

	it('records nothing for Admin reads except the first live time', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await createLocation(organization.id, { storeHours: WEEK })
		await loadLaunchChecklist({
			organizationId: organization.id,
			userId: null,
			facts: NO_FACTS,
		})
		expect(
			await db
				.select()
				.from(OnboardingStepProgress)
				.where(
					and(
						eq(OnboardingStepProgress.organizationId, organization.id),
						isNotNull(OnboardingStepProgress.locationId),
					),
				),
		).toEqual([])
	})
})

describe('skipLaunchStep', () => {
	it('refuses required steps and records optional skips with a reason', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const locationId = await createLocation(organization.id)
		expect(
			await skipLaunchStep({
				organizationId: organization.id,
				userId: user.id,
				locationId,
				stepKey: 'launch_payments',
			}),
		).toEqual({ ok: false, error: 'step_not_skippable' })

		expect(
			await skipLaunchStep({
				organizationId: organization.id,
				userId: user.id,
				locationId,
				stepKey: 'launch_station',
				reason: '  We take orders on the phone  ',
			}),
		).toEqual({ ok: true })
		const checklist = await loadLaunchChecklist({
			organizationId: organization.id,
			userId: user.id,
			facts: NO_FACTS,
		})
		expect(step(checklist, locationId, 'launch_station')).toMatchObject({
			state: 'skipped',
			skipReason: 'We take orders on the phone',
		})
	})

	it('refuses a location of another organization', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const { organization: other } = await setupTestOrgWithUser('admin')
		const foreign = await createLocation(other.id)
		expect(
			await skipLaunchStep({
				organizationId: organization.id,
				userId: user.id,
				locationId: foreign,
				stepKey: 'launch_station',
			}),
		).toEqual({ ok: false, error: 'location_not_found' })
	})
})
