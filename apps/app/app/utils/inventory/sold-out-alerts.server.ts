import { getLocalizedMenuValue } from '@repo/common/menu-types'
import {
	and,
	db,
	eq,
	inArray,
	Notification,
	OrganizationMenuItem,
	OrganizationMenuOption,
} from '@repo/database'
import { StaffingAlertEmail, sendEmail } from '@repo/email'
import {
	type InventoryNotifyEvent,
	type InventoryNotifyResult,
	type SoldOutAlertEntry,
} from '@repo/inventory'
import { ENV } from 'varlock/env'
import {
	applyAlertPolicy,
	recordDeliveredChannels,
} from '#app/utils/alerts/policy.server.ts'
import {
	pushStoredNotifications,
	type StoredNotification,
} from '#app/utils/alerts/push.server.ts'
import { wakeOperatorAlertsAt } from '#app/utils/alerts/wake.server.ts'
import { orgSiteLocales } from '#app/utils/location-name.server.ts'
import {
	loadInventoryChannelPreferences,
	resolveInventoryAlertRecipients,
} from './manager-alerts.server.ts'
import {
	describeInventoryAlert,
	INVENTORY_ALERT_MARKER_TYPE,
	inventoryAlertNotificationType,
	inventoryAlertPath,
} from './manager-alerts.ts'

/**
 * Delivery of the sold-out and come-back alerts (#478) on the existing manager
 * alert engine: members come from permissions and location scope, each
 * member's channel choices and push category apply, the in-app alert is a
 * `Notification` row (also the claim that makes a retried event send nothing
 * twice), and the quiet hours, snooze and alert log of #366 decide whether the
 * email and the push go now or when quiet hours end. A sold-out alert is never
 * critical. The alert names dishes (from the App's own menu) and the
 * ingredient: no guest data.
 */

export type SoldOutAlertDish = { dish: string; ingredient: string }

/** Names of the dishes and options an alert is about, from this organization's menu. */
export async function dishNamesFor(
	organizationId: string,
	entries: readonly SoldOutAlertEntry[],
): Promise<SoldOutAlertDish[]> {
	const itemIds = entries
		.filter((entry) => entry.entityType === 'item')
		.map((entry) => entry.entityId)
	const optionIds = entries
		.filter((entry) => entry.entityType === 'modifier_option')
		.map((entry) => entry.entityId)
	const { defaultLocale } = await orgSiteLocales(organizationId)
	const [items, options] = await Promise.all([
		itemIds.length
			? db
					.select({
						id: OrganizationMenuItem.id,
						displayName: OrganizationMenuItem.displayName,
						internalName: OrganizationMenuItem.internalName,
					})
					.from(OrganizationMenuItem)
					.where(
						and(
							eq(OrganizationMenuItem.organizationId, organizationId),
							inArray(OrganizationMenuItem.id, itemIds),
						),
					)
			: [],
		optionIds.length
			? db
					.select({
						id: OrganizationMenuOption.id,
						displayName: OrganizationMenuOption.displayName,
						internalName: OrganizationMenuOption.internalName,
					})
					.from(OrganizationMenuOption)
					.where(
						and(
							eq(OrganizationMenuOption.organizationId, organizationId),
							inArray(OrganizationMenuOption.id, optionIds),
						),
					)
			: [],
	])
	const names = new Map<string, string>()
	for (const row of [...items, ...options]) {
		names.set(
			row.id,
			getLocalizedMenuValue(row.displayName, defaultLocale, defaultLocale) ||
				row.internalName ||
				'',
		)
	}
	const out: SoldOutAlertDish[] = []
	for (const entry of entries) {
		// A dish that is gone from the menu is not worth an alert line.
		const dish = names.get(entry.entityId)
		if (dish) out.push({ dish, ingredient: entry.ingredientName })
	}
	return out
}

export function soldOutEmailCopy(input: {
	kind: 'inventory_sold_out' | 'inventory_sold_out_back'
	count: number
	locationName: string | null
	dishes: readonly SoldOutAlertDish[]
}) {
	return describeInventoryAlert({
		kind: input.kind,
		count: input.count,
		locationName: input.locationName,
		dishes: input.dishes.map((entry) => entry.dish),
		ingredients: input.dishes.map((entry) => entry.ingredient),
	})
}

/** Sends the alert email; false when the mail provider refused it. */
export async function sendSoldOutEmail(input: {
	to: string
	orgSlug: string
	copy: ReturnType<typeof soldOutEmailCopy>
	kind: 'inventory_sold_out' | 'inventory_sold_out_back'
}): Promise<boolean> {
	const baseUrl = String(ENV.BASE_URL ?? '').replace(/\/$/, '')
	try {
		const result = await sendEmail({
			to: input.to,
			subject: input.copy.subject,
			react: StaffingAlertEmail({
				eyebrow: input.copy.eyebrow,
				headline: input.copy.headline,
				detail: input.copy.detail,
				actionLabel: input.copy.actionLabel,
				actionUrl: `${baseUrl}/${input.orgSlug}${inventoryAlertPath(input.kind)}`,
				settingsNote:
					'You can change these alerts in your notification settings.',
			}),
		})
		return result.status !== 'error'
	} catch {
		return false
	}
}

export async function deliverSoldOutAlert(input: {
	organization: { id: string; slug: string }
	event: InventoryNotifyEvent & {
		kind: 'inventory_sold_out' | 'inventory_sold_out_back'
	}
	locationName: string | null
	now?: number
}): Promise<InventoryNotifyResult> {
	const { organization, event } = input
	const now = input.now ?? Date.now()
	const dishes = await dishNamesFor(organization.id, event.soldOut ?? [])
	// Every dish left the menu meanwhile (or was never ours): nothing to say.
	if (dishes.length === 0) return { inApp: 0, emailed: 0, skipped: 'no_dishes' }

	const recipients = await resolveInventoryAlertRecipients({
		organizationId: organization.id,
		locationId: event.locationId,
		kind: event.kind,
	})
	if (recipients.length === 0) {
		return { inApp: 0, emailed: 0, skipped: 'no_recipients' }
	}
	const type = inventoryAlertNotificationType(event.kind)
	const userIds = recipients.map((recipient) => recipient.userId)
	const [preferences, alreadyHandled] = await Promise.all([
		loadInventoryChannelPreferences({
			organizationId: organization.id,
			kind: event.kind,
			userIds,
		}),
		db
			.select({ userId: Notification.userId })
			.from(Notification)
			.where(
				and(
					eq(Notification.organizationId, organization.id),
					eq(Notification.entityId, event.eventId),
					inArray(Notification.type, [type, INVENTORY_ALERT_MARKER_TYPE]),
					inArray(Notification.userId, userIds),
				),
			),
	])
	const handled = new Set(alreadyHandled.map((row) => row.userId))
	const copy = soldOutEmailCopy({
		kind: event.kind,
		count: event.count,
		locationName: input.locationName,
		dishes,
	})
	const payload = {
		kind: event.kind,
		locationId: event.locationId,
		count: event.count,
		orgSlug: organization.slug,
		...(input.locationName ? { locationName: input.locationName } : {}),
		soldOut: dishes.slice(0, 20),
	}

	let inApp = 0
	let emailed = 0
	const pushRows: StoredNotification[] = []
	for (const recipient of recipients) {
		if (handled.has(recipient.userId)) continue
		const channels = preferences.get(recipient.userId) ?? {
			inApp: true,
			email: true,
		}
		if (!channels.inApp && !channels.email) continue
		const [claimed] = await db
			.insert(Notification)
			.values({
				userId: recipient.userId,
				organizationId: organization.id,
				type: channels.inApp ? type : INVENTORY_ALERT_MARKER_TYPE,
				entityId: event.eventId,
				payload: JSON.stringify(channels.inApp ? payload : {}),
				isRead: !channels.inApp,
				isSeen: !channels.inApp,
			})
			.onConflictDoNothing()
			.returning({ id: Notification.id })
		if (!claimed) continue
		if (channels.inApp) {
			inApp++
			pushRows.push({
				id: claimed.id,
				userId: recipient.userId,
				organizationId: organization.id,
				type,
				entityId: event.eventId,
				payload,
			})
		}
		if (!channels.email) continue
		// The email follows the member's quiet hours and snooze. The push has its
		// own decision (`pushStoredNotifications`), so each channel is logged once.
		const policy = await applyAlertPolicy({
			userId: recipient.userId,
			organizationId: organization.id,
			locationId: event.locationId,
			kind: `${type}-email`,
			entityId: event.eventId,
			critical: false,
			notificationId: claimed.id,
			channelsOwed: ['email'],
			now,
		})
		if (policy.replay) continue
		if (policy.decision.outcome === 'held') {
			void wakeOperatorAlertsAt(new Date(policy.decision.until))
		}
		if (policy.decision.outcome !== 'deliver') continue
		const sent = await sendSoldOutEmail({
			to: recipient.email,
			orgSlug: organization.slug,
			copy,
			kind: event.kind,
		})
		if (sent) {
			emailed++
			await recordDeliveredChannels(policy.logId, ['email'])
		} else {
			console.error('Failed to send inventory alert email')
		}
	}
	await pushStoredNotifications(pushRows)
	return { inApp, emailed }
}
