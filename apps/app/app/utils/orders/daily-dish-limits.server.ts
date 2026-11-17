import {
	DAILY_DISH_LIMITS_FLAG,
	type DailyDishLimitsContext,
	parseDailySaleLimit,
} from '@repo/common/daily-dish-limits'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	and,
	asc,
	db,
	desc,
	eq,
	isNotNull,
	OrganizationLocation,
	OrganizationMenuItem,
	OrganizationMenuOption,
} from '@repo/database'

export async function isDailyDishLimitsEnabled(
	organizationId: string,
): Promise<boolean> {
	return (
		(await getFeatureFlag(DAILY_DISH_LIMITS_FLAG, { organizationId })) === true
	)
}

/**
 * The order context's daily-limit block: the flag and every capped dish or
 * option (id, name, config). It goes to the region only; the public menu never
 * carries a cap. With the flag off nothing is read.
 */
export async function buildDailyDishLimitsContext(
	organizationId: string,
): Promise<DailyDishLimitsContext> {
	if (!(await isDailyDishLimitsEnabled(organizationId))) {
		return { enabled: false, entries: [] }
	}
	const [items, options] = await Promise.all([
		db
			.select({
				id: OrganizationMenuItem.id,
				name: OrganizationMenuItem.displayName,
				dailySaleLimit: OrganizationMenuItem.dailySaleLimit,
			})
			.from(OrganizationMenuItem)
			.where(
				and(
					eq(OrganizationMenuItem.organizationId, organizationId),
					isNotNull(OrganizationMenuItem.dailySaleLimit),
				),
			),
		db
			.select({
				id: OrganizationMenuOption.id,
				name: OrganizationMenuOption.displayName,
				dailySaleLimit: OrganizationMenuOption.dailySaleLimit,
			})
			.from(OrganizationMenuOption)
			.where(
				and(
					eq(OrganizationMenuOption.organizationId, organizationId),
					isNotNull(OrganizationMenuOption.dailySaleLimit),
				),
			),
	])
	const entries: DailyDishLimitsContext['entries'] = []
	for (const row of items) {
		const config = parseDailySaleLimit(row.dailySaleLimit)
		if (config)
			entries.push({ kind: 'item', id: row.id, name: row.name, config })
	}
	for (const row of options) {
		const config = parseDailySaleLimit(row.dailySaleLimit)
		if (config) {
			entries.push({ kind: 'option', id: row.id, name: row.name, config })
		}
	}
	return { enabled: true, entries }
}

export type DailyLimitLocation = { id: string; name: string }

/**
 * The locations for the Orders page's "Today's dish limits" panel: none while
 * the feature is off, and none while no dish or option has a daily limit, so
 * the panel never shows up empty.
 */
export async function loadDailyLimitLocations(
	organizationId: string,
): Promise<DailyLimitLocation[]> {
	if (!(await isDailyDishLimitsEnabled(organizationId))) return []
	const [item, option] = await Promise.all([
		db
			.select({ id: OrganizationMenuItem.id })
			.from(OrganizationMenuItem)
			.where(
				and(
					eq(OrganizationMenuItem.organizationId, organizationId),
					isNotNull(OrganizationMenuItem.dailySaleLimit),
				),
			)
			.limit(1),
		db
			.select({ id: OrganizationMenuOption.id })
			.from(OrganizationMenuOption)
			.where(
				and(
					eq(OrganizationMenuOption.organizationId, organizationId),
					isNotNull(OrganizationMenuOption.dailySaleLimit),
				),
			)
			.limit(1),
	])
	if (item.length === 0 && option.length === 0) return []
	return db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organizationId),
				eq(OrganizationLocation.isActive, true),
			),
		)
		.orderBy(
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.name),
		)
}
