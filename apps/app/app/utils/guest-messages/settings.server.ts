import { getFeatureFlag } from '@repo/common/feature-flags'
import { and, ConfigFlag, db, eq, OrganizationLocation } from '@repo/database'
import {
	foldGuestMessages,
	foldLargeOrder,
	GUEST_MESSAGES_FLAG_KEY,
	GUEST_MESSAGES_SETTINGS_KEY,
	parseGuestMessageSwitches,
	type GuestMessagesContext,
	type GuestMessageSwitches,
	type LargeOrderContext,
} from './settings.ts'

export async function isGuestMessagesEnabled(
	organizationId: string,
): Promise<boolean> {
	return (
		(await getFeatureFlag(GUEST_MESSAGES_FLAG_KEY, { organizationId })) === true
	)
}

export async function readGuestMessageSwitches(
	organizationId: string,
): Promise<GuestMessageSwitches> {
	const [row] = await db
		.select({ value: ConfigFlag.value })
		.from(ConfigFlag)
		.where(
			and(
				eq(ConfigFlag.key, GUEST_MESSAGES_SETTINGS_KEY),
				eq(ConfigFlag.level, 'organization'),
				eq(ConfigFlag.organizationId, organizationId),
			),
		)
		.limit(1)
	return parseGuestMessageSwitches(row?.value)
}

export async function saveGuestMessageSwitches(
	organizationId: string,
	switches: GuestMessageSwitches,
): Promise<void> {
	const where = and(
		eq(ConfigFlag.key, GUEST_MESSAGES_SETTINGS_KEY),
		eq(ConfigFlag.level, 'organization'),
		eq(ConfigFlag.organizationId, organizationId),
	)
	const updated = await db
		.update(ConfigFlag)
		.set({ value: switches })
		.where(where)
		.returning({ id: ConfigFlag.id })
	if (updated.length > 0) return
	await db.insert(ConfigFlag).values({
		key: GUEST_MESSAGES_SETTINGS_KEY,
		value: switches,
		level: 'organization',
		organizationId,
	})
}

/** The `guestMessages` field of the order context. */
export async function buildGuestMessagesContext(
	organizationId: string,
): Promise<GuestMessagesContext> {
	if (!(await isGuestMessagesEnabled(organizationId))) {
		return foldGuestMessages(false, parseGuestMessageSwitches(null))
	}
	return foldGuestMessages(true, await readGuestMessageSwitches(organizationId))
}

/** The `largeOrder` field: one location when `locationId` is given, else all. */
export async function buildLargeOrderContext(
	organizationId: string,
	locationId?: string | null,
): Promise<LargeOrderContext> {
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			largeOrderThreshold: OrganizationLocation.largeOrderThreshold,
			largeOrderThresholdType: OrganizationLocation.largeOrderThresholdType,
			largeOrderExtraPrepTime: OrganizationLocation.largeOrderExtraPrepTime,
		})
		.from(OrganizationLocation)
		.where(
			locationId
				? and(
						eq(OrganizationLocation.organizationId, organizationId),
						eq(OrganizationLocation.id, locationId),
					)
				: eq(OrganizationLocation.organizationId, organizationId),
		)
	return foldLargeOrder(rows)
}
