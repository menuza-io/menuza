import { getFeatureFlag } from '@repo/common/feature-flags'
import { isUnavailableUntilExpired } from '@repo/common/location-availability'
import { isLaunchStepKey } from '@repo/common/onboarding'
import {
	and,
	asc,
	ConfigFlag,
	db,
	desc,
	eq,
	isNotNull,
	isNull,
	OnboardingStep,
	OnboardingStepProgress,
	Organization,
	OrganizationImage,
	OrganizationLocation,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuLocationOverride,
} from '@repo/database'
import { weeklyScheduleHasOpenDay } from '@repo/opening-hours'
import { ENV } from 'varlock/env'
import {
	channelsOff,
	PAY_AT_PICKUP_ONLY_FLAG,
} from '#app/utils/dashboards/attention.server.ts'
import {
	loadLaunchFacts,
	type LaunchFacts,
} from '#app/utils/dashboards/regional-home.server.ts'
import { publicOrderingControls } from '#app/utils/location/ordering-pause.ts'
import {
	displayLocationName,
	orgDefaultLocale,
} from '#app/utils/location-name.server.ts'
import { loadMenuHealth } from '#app/utils/menu/menu-health.server.ts'
import { menuHealthMeetsGrade } from '#app/utils/menu/menu-health.ts'
import { recordOrganizationEvent } from '#app/utils/organization-events.server.ts'
import { resolveReservationsLocationIds } from '#app/utils/reservations/access.server.ts'
import { resolveRestaurantOnlinePayment } from '#app/utils/restaurant-orders/payment-config.server.ts'
import { resolveSitesOrigin } from '#app/utils/sites/sites-origin.server.ts'
import {
	evaluateLaunchCondition,
	isLocationLive,
	LAUNCH_CHECKLIST_FLAG,
	LAUNCH_GUESTS_OFFERED_FLAG,
	launchStepByKey,
	launchStepState,
	SKIP_REASON_MAX,
	type LaunchChecklist,
	type LaunchLocationView,
	type LocationLaunchFacts,
} from './launch.ts'

/** A category needs this many priced dishes for the menu step. */
export const MENU_READY_MIN_ITEMS = 5

export async function isLaunchChecklistOn(organizationId: string) {
	return (
		(await getFeatureFlag(LAUNCH_CHECKLIST_FLAG, { organizationId })) === true
	)
}

function parseJsonArray(value: string | null | undefined): unknown[] {
	if (!value) return []
	try {
		const parsed: unknown = JSON.parse(value)
		return Array.isArray(parsed) ? parsed : []
	} catch {
		return []
	}
}

/** At least one category with `MENU_READY_MIN_ITEMS` or more priced dishes. */
export function hasFullCategory(
	assignments: ReadonlyArray<{ categoryId: string; itemId: string }>,
	pricedItemIds: ReadonlySet<string>,
	minimum = MENU_READY_MIN_ITEMS,
): boolean {
	const counts = new Map<string, Set<string>>()
	for (const row of assignments) {
		if (!pricedItemIds.has(row.itemId)) continue
		const items = counts.get(row.categoryId) ?? new Set<string>()
		items.add(row.itemId)
		counts.set(row.categoryId, items)
		if (items.size >= minimum) return true
	}
	return false
}

type MenuItemRow = {
	id: string
	price: number
	availabilityStatus: string
	unavailableUntil: Date | null
}
type ItemOverrideRow = {
	locationId: string
	entityId: string
	isEnabled: boolean | null
	availabilityStatus: string | null
	unavailableUntil: Date | null
}

/** Priced dishes on sale at a location right now. */
export function sellableItemCount(
	items: readonly MenuItemRow[],
	overrides: readonly ItemOverrideRow[],
	locationId: string,
	now: Date,
): number {
	const byItem = new Map(
		overrides
			.filter((row) => row.locationId === locationId)
			.map((row) => [row.entityId, row]),
	)
	let count = 0
	for (const item of items) {
		if (!(item.price > 0) || item.availabilityStatus === 'hidden') continue
		const override = byItem.get(item.id)
		if (override?.isEnabled === false) continue
		const status = override?.availabilityStatus ?? item.availabilityStatus
		const until = override?.availabilityStatus
			? override.unavailableUntil
			: item.unavailableUntil
		if (status !== 'hidden' && isUnavailableUntilExpired(status, until, now)) {
			count += 1
		}
	}
	return count
}

/** The organization's public site (custom domain when set). */
export function orgSiteUrl(organization: {
	slug: string
	customDomain: string | null
}) {
	return resolveSitesOrigin({
		slug: organization.slug,
		customDomain: organization.customDomain,
		baseUrl: ENV.BASE_URL ?? '',
		hostSuffixes: (ENV as { PUBLIC_SITE_HOST_SUFFIXES?: string })
			.PUBLIC_SITE_HOST_SUFFIXES,
	})
}

type LaunchOrganization = {
	id: string
	slug: string
	dataRegion: string | null
	sitePublished: boolean | null
	customDomain: string | null
	customDomainStatus: string | null
	siteTheme: string | null
	siteLocales: string | null
	siteDefaultLocale: string | null
	shopPaymentProvider: string | null
	stripeConnectAccountId: string | null
	stripeConnectChargesEnabled: boolean | null
	checkoutSubEntityId: string | null
	checkoutChargesEnabled: boolean | null
}

async function loadLaunchOrganization(
	organizationId: string,
): Promise<LaunchOrganization | null> {
	const [row] = await db
		.select({
			id: Organization.id,
			slug: Organization.slug,
			dataRegion: Organization.dataRegion,
			sitePublished: Organization.sitePublished,
			customDomain: Organization.customDomain,
			customDomainStatus: Organization.customDomainStatus,
			siteTheme: Organization.siteTheme,
			siteLocales: Organization.siteLocales,
			siteDefaultLocale: Organization.siteDefaultLocale,
			shopPaymentProvider: Organization.shopPaymentProvider,
			stripeConnectAccountId: Organization.stripeConnectAccountId,
			stripeConnectChargesEnabled: Organization.stripeConnectChargesEnabled,
			checkoutSubEntityId: Organization.checkoutSubEntityId,
			checkoutChargesEnabled: Organization.checkoutChargesEnabled,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return row ?? null
}

/** Launch steps that are seeded and active, in checklist order. */
async function loadLaunchStepRows() {
	const rows = await db
		.select({ id: OnboardingStep.id, key: OnboardingStep.key })
		.from(OnboardingStep)
		.where(and(eq(OnboardingStep.isActive, true), isLaunchStepKey()))
		.orderBy(asc(OnboardingStep.sortOrder))
	return rows.flatMap((row) => {
		const step = launchStepByKey(row.key)
		return step ? [{ ...step, id: row.id }] : []
	})
}

/**
 * The launch checklist for every location the viewer may see, evaluated now.
 *
 * - `viewer.userId` set: a member. Location-scoped members get only their
 *   locations, and step changes are recorded (completion dates; the first
 *   time a location is live sets `liveAt`, once).
 * - `viewer.userId` null: Admin. Every active location, read only (except
 *   `liveAt`, which is set the same way).
 *
 * Regional facts (a paired terminal, a first order) come as ids and a
 * timestamp from `facts`, or are fetched; when the region cannot answer,
 * those optional steps show as to do. Never reads a guest field.
 */
export async function loadLaunchChecklist({
	organizationId,
	userId,
	now = new Date(),
	facts: knownFacts,
}: {
	organizationId: string
	userId: string | null
	now?: Date
	facts?: LaunchFacts | null
}): Promise<LaunchChecklist | null> {
	const organization = await loadLaunchOrganization(organizationId)
	if (!organization) return null
	const [
		steps,
		locationRows,
		allowedIds,
		defaultLocale,
		logo,
		payAtPickupOnly,
		guestsOffered,
		health,
		items,
		assignments,
		overrides,
		progressRows,
		facts,
	] = await Promise.all([
		loadLaunchStepRows(),
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				isActive: OrganizationLocation.isActive,
				address: OrganizationLocation.address,
				storeHours: OrganizationLocation.storeHours,
				onlineHours: OrganizationLocation.onlineHours,
				prepTime: OrganizationLocation.prepTime,
				fulfillmentOptions: OrganizationLocation.fulfillmentOptions,
				scheduling: OrganizationLocation.scheduling,
				deliveryZones: OrganizationLocation.deliveryZones,
				orderingPausedAt: OrganizationLocation.orderingPausedAt,
				orderingPausedUntil: OrganizationLocation.orderingPausedUntil,
				busyExtraPrepMinutes: OrganizationLocation.busyExtraPrepMinutes,
				busyUntil: OrganizationLocation.busyUntil,
				liveAt: OrganizationLocation.liveAt,
			})
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, organizationId),
					eq(OrganizationLocation.isActive, true),
				),
			)
			.orderBy(
				desc(OrganizationLocation.isDefault),
				asc(OrganizationLocation.createdAt),
			),
		userId ? resolveReservationsLocationIds(userId, organizationId) : null,
		orgDefaultLocale(organizationId),
		db
			.select({ id: OrganizationImage.id })
			.from(OrganizationImage)
			.where(eq(OrganizationImage.organizationId, organizationId))
			.limit(1),
		getFeatureFlag(PAY_AT_PICKUP_ONLY_FLAG, { organizationId }),
		getFeatureFlag(LAUNCH_GUESTS_OFFERED_FLAG, { organizationId }),
		loadMenuHealth(organization),
		db
			.select({
				id: OrganizationMenuItem.id,
				price: OrganizationMenuItem.price,
				availabilityStatus: OrganizationMenuItem.availabilityStatus,
				unavailableUntil: OrganizationMenuItem.unavailableUntil,
			})
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId)),
		db
			.select({
				categoryId: OrganizationMenuItemCategoryAssignment.categoryId,
				itemId: OrganizationMenuItemCategoryAssignment.itemId,
			})
			.from(OrganizationMenuItemCategoryAssignment)
			.innerJoin(
				OrganizationMenuItem,
				eq(
					OrganizationMenuItem.id,
					OrganizationMenuItemCategoryAssignment.itemId,
				),
			)
			.where(eq(OrganizationMenuItem.organizationId, organizationId)),
		db
			.select({
				locationId: OrganizationMenuLocationOverride.locationId,
				entityId: OrganizationMenuLocationOverride.entityId,
				isEnabled: OrganizationMenuLocationOverride.isEnabled,
				availabilityStatus: OrganizationMenuLocationOverride.availabilityStatus,
				unavailableUntil: OrganizationMenuLocationOverride.unavailableUntil,
			})
			.from(OrganizationMenuLocationOverride)
			.where(
				and(
					eq(OrganizationMenuLocationOverride.organizationId, organizationId),
					eq(OrganizationMenuLocationOverride.entityType, 'item'),
				),
			),
		db
			.select({
				id: OnboardingStepProgress.id,
				stepId: OnboardingStepProgress.stepId,
				locationId: OnboardingStepProgress.locationId,
				isCompleted: OnboardingStepProgress.isCompleted,
				completedAt: OnboardingStepProgress.completedAt,
				skippedAt: OnboardingStepProgress.skippedAt,
				skipReason: OnboardingStepProgress.skipReason,
			})
			.from(OnboardingStepProgress)
			.where(
				and(
					eq(OnboardingStepProgress.organizationId, organizationId),
					isNotNull(OnboardingStepProgress.locationId),
				),
			),
		knownFacts === undefined ? loadLaunchFacts(organization) : knownFacts,
	])

	const locations = locationRows.filter(
		(row) => allowedIds === null || allowedIds.includes(row.id),
	)
	const pricedItemIds = new Set(
		items.filter((item) => item.price > 0).map((item) => item.id),
	)
	const organizationFacts = {
		hasFullCategory: hasFullCategory(assignments, pricedItemIds),
		// The bar is 60 (grade D or better), never a C.
		menuHealthOk: health.itemCount > 0 && menuHealthMeetsGrade(health, 'D'),
		hasLogo: logo.length > 0,
		hasTheme: Boolean(organization.siteTheme),
		onlinePayments: resolveRestaurantOnlinePayment({
			dataRegion: organization.dataRegion ?? 'us',
			shopPaymentProvider: organization.shopPaymentProvider,
			stripeConnectAccountId: organization.stripeConnectAccountId,
			stripeConnectChargesEnabled: Boolean(
				organization.stripeConnectChargesEnabled,
			),
			checkoutSubEntityId: organization.checkoutSubEntityId,
			checkoutChargesEnabled: Boolean(organization.checkoutChargesEnabled),
		}).enabled,
		payAtPickupOnly: payAtPickupOnly === true,
		hasCountedOrder: facts ? facts.firstOrderAt !== null : null,
		customDomainActive: Boolean(
			organization.customDomain && organization.customDomainStatus === 'active',
		),
		sitePublished: Boolean(organization.sitePublished),
	}
	const progress = new Map(
		progressRows.map((row) => [`${row.locationId}:${row.stepId}`, row]),
	)

	const writes: Array<Promise<unknown>> = []
	const views: LaunchLocationView[] = locations.map((location) => {
		const off = channelsOff(location)
		const zones = parseJsonArray(location.deliveryZones)
		const hasChannel =
			!off.includes('pickup') || (!off.includes('delivery') && zones.length > 0)
		const { orderingPause } = publicOrderingControls(location, now)
		const locationFacts: LocationLaunchFacts = {
			...organizationFacts,
			hasAddress: Boolean(location.address?.trim()),
			hasHours:
				weeklyScheduleHasOpenDay(location.storeHours) ||
				weeklyScheduleHasOpenDay(location.onlineHours),
			hasChannel,
			prepTimeSet: location.prepTime > 0,
			terminalPaired: facts
				? facts.pairedLocationIds.includes(location.id)
				: null,
			orderingOn: !orderingPause && hasChannel,
			locationActive: location.isActive,
			sellableItems: sellableItemCount(items, overrides, location.id, now),
		}
		const live = isLocationLive(locationFacts)
		let liveAt = location.liveAt
		if (live && !liveAt) {
			liveAt = now
			writes.push(
				db
					.update(OrganizationLocation)
					.set({ liveAt: now })
					.where(
						and(
							eq(OrganizationLocation.id, location.id),
							isNull(OrganizationLocation.liveAt),
						),
					),
			)
			// On the Admin Timeline (#279), once per location.
			writes.push(
				recordOrganizationEvent({
					organizationId,
					locationId: location.id,
					kind: 'launch_live',
					dedupeKey: `launch-live:${location.id}`,
					at: now,
				}),
			)
		}

		const stepViews = steps.map((step) => {
			const done = evaluateLaunchCondition(step.condition, locationFacts)
			const row = progress.get(`${location.id}:${step.id}`)
			let completedAt = row?.isCompleted ? (row.completedAt ?? null) : null
			if (userId && Boolean(row?.isCompleted) !== done) {
				// Detection on read: record the change (an undone step goes back
				// to to do and loses its date).
				completedAt = done ? now : null
				if (done) {
					// A step completed, on the Admin Timeline (#279): the step key only.
					writes.push(
						recordOrganizationEvent({
							organizationId,
							locationId: location.id,
							kind: 'launch_step_completed',
							payload: { stepKey: step.key },
							dedupeKey: `launch-step:${location.id}:${step.key}`,
							at: now,
						}),
					)
				}
				writes.push(
					recordStepState({
						organizationId,
						locationId: location.id,
						stepId: step.id,
						userId,
						done,
						now,
					}),
				)
			}
			const skipped = Boolean(row?.skippedAt) && step.optional
			return {
				key: step.key,
				condition: step.condition,
				optional: step.optional,
				organizationWide: step.organizationWide,
				state: launchStepState(step, done, skipped),
				href: step.href.replace(':locationId', location.id),
				completedAt: done && completedAt ? completedAt.toISOString() : null,
				skippedAt:
					skipped && row?.skippedAt ? row.skippedAt.toISOString() : null,
				skipReason: skipped ? (row?.skipReason ?? null) : null,
			}
		})
		const required = stepViews.filter((step) => !step.optional)
		return {
			id: location.id,
			name: displayLocationName(location.name, defaultLocale, defaultLocale),
			live,
			liveAt: liveAt ? liveAt.toISOString() : null,
			steps: stepViews,
			requiredDone: required.filter((step) => step.state === 'done').length,
			requiredTotal: required.length,
		}
	})
	// Recording is best effort: a failed write must not break the page.
	await Promise.allSettled(writes)
	return {
		locations: views,
		siteUrl: orgSiteUrl(organization),
		guestsOffered: guestsOffered === true,
	}
}

async function recordStepState({
	organizationId,
	locationId,
	stepId,
	userId,
	done,
	now,
}: {
	organizationId: string
	locationId: string
	stepId: string
	userId: string
	done: boolean
	now: Date
}) {
	await db
		.insert(OnboardingStepProgress)
		.values({
			userId,
			organizationId,
			locationId,
			stepId,
			isCompleted: done,
			completedAt: done ? now : null,
		})
		.onConflictDoUpdate({
			target: [
				OnboardingStepProgress.organizationId,
				OnboardingStepProgress.locationId,
				OnboardingStepProgress.stepId,
			],
			targetWhere: isNotNull(OnboardingStepProgress.locationId),
			set: { isCompleted: done, completedAt: done ? now : null, userId },
		})
}

export type SkipLaunchStepResult =
	| { ok: true }
	| {
			ok: false
			error: 'step_not_found' | 'step_not_skippable' | 'location_not_found'
	  }

/**
 * Skips an optional launch step at one location, recording who and when
 * (and an optional reason). Required steps are refused with
 * `step_not_skippable`. The caller has checked `update:settings:any`.
 */
export async function skipLaunchStep({
	organizationId,
	userId,
	locationId,
	stepKey,
	reason,
	now = new Date(),
}: {
	organizationId: string
	userId: string
	locationId: string
	stepKey: string
	reason?: string | null
	now?: Date
}): Promise<SkipLaunchStepResult> {
	const definition = launchStepByKey(stepKey)
	if (!definition) return { ok: false, error: 'step_not_found' }
	if (!definition.optional) return { ok: false, error: 'step_not_skippable' }
	const [step] = await db
		.select({ id: OnboardingStep.id })
		.from(OnboardingStep)
		.where(
			and(eq(OnboardingStep.key, stepKey), eq(OnboardingStep.isActive, true)),
		)
		.limit(1)
	if (!step) return { ok: false, error: 'step_not_found' }
	const allowedIds = await resolveReservationsLocationIds(
		userId,
		organizationId,
	)
	const [location] = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.id, locationId),
				eq(OrganizationLocation.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!location || (allowedIds !== null && !allowedIds.includes(location.id))) {
		return { ok: false, error: 'location_not_found' }
	}
	const skipReason = reason?.trim().slice(0, SKIP_REASON_MAX) || null
	await db
		.insert(OnboardingStepProgress)
		.values({
			userId,
			organizationId,
			locationId,
			stepId: step.id,
			skippedAt: now,
			skipReason,
		})
		.onConflictDoUpdate({
			target: [
				OnboardingStepProgress.organizationId,
				OnboardingStepProgress.locationId,
				OnboardingStepProgress.stepId,
			],
			targetWhere: isNotNull(OnboardingStepProgress.locationId),
			set: { skippedAt: now, skipReason, userId },
		})
	return { ok: true }
}

/** Sets an organization-level flag (the launch choices below). */
async function setOrganizationFlag(
	organizationId: string,
	key: string,
	value: boolean,
) {
	const [existing] = await db
		.select({ id: ConfigFlag.id })
		.from(ConfigFlag)
		.where(
			and(
				eq(ConfigFlag.key, key),
				eq(ConfigFlag.level, 'organization'),
				eq(ConfigFlag.organizationId, organizationId),
				isNull(ConfigFlag.userId),
			),
		)
		.limit(1)
	if (existing) {
		await db
			.update(ConfigFlag)
			.set({ value, updatedAt: new Date() })
			.where(eq(ConfigFlag.id, existing.id))
		return
	}
	await db
		.insert(ConfigFlag)
		.values({ key, value, level: 'organization', organizationId })
}

/** "Use pay at pickup only": the payments step is done without online payments. */
export function setPayAtPickupOnly(organizationId: string, value: boolean) {
	return setOrganizationFlag(organizationId, PAY_AT_PICKUP_ONLY_FLAG, value)
}

/** "Tell your guests" was offered on the home page; the launch page still has it. */
export function markGuestsOffered(organizationId: string) {
	return setOrganizationFlag(organizationId, LAUNCH_GUESTS_OFFERED_FLAG, true)
}
