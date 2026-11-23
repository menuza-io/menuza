import {
	getLocalizedMenuValue,
	parseMenuVariations,
} from '@repo/common/menu-types'
import {
	and,
	count,
	db,
	eq,
	inArray,
	Notification,
	Organization,
	OrganizationLocation,
	OrganizationMenuItem,
} from '@repo/database'
import { StaffingAlertEmail, sendEmail } from '@repo/email'
import {
	DEFAULT_INVENTORY_LOCATION_ID,
	dishFoodCostBp,
	type InventoryNotifyEvent,
	inventoryNotifyEventSchema,
	type InventoryNotifyResult,
	inventoryNotifyResultSchema,
	type PriceRiseDishAlertEntry,
} from '@repo/inventory'
import { type ActionFunctionArgs } from 'react-router'
import { ENV } from 'varlock/env'
import {
	pushStoredNotifications,
	type StoredNotification,
} from '#app/utils/alerts/push.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { getInventoryFeatureState } from '#app/utils/inventory/access.server.ts'
import {
	loadInventoryChannelPreferences,
	resolveInventoryAlertRecipients,
} from '#app/utils/inventory/manager-alerts.server.ts'
import {
	describeInventoryAlert,
	INVENTORY_ALERT_MARKER_TYPE,
	inventoryAlertNotificationType,
	inventoryAlertPath,
	isSoldOutAlertKind,
	type PriceRiseDishSummary,
} from '#app/utils/inventory/manager-alerts.ts'
import {
	majorToMinor,
	regionCurrency,
} from '#app/utils/inventory/recipe-form.ts'
import { deliverSoldOutAlert } from '#app/utils/inventory/sold-out-alerts.server.ts'
import {
	displayLocationName,
	orgDefaultLocale,
	orgSiteLocales,
} from '#app/utils/location-name.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function answer(result: InventoryNotifyResult) {
	return Response.json(inventoryNotifyResultSchema.parse(result), {
		headers: NO_STORE,
	})
}

function skipped(reason: string) {
	return answer({ inApp: 0, emailed: 0, skipped: reason })
}

function featureOn(
	features: Awaited<ReturnType<typeof getInventoryFeatureState>>,
	kind: InventoryNotifyEvent['kind'],
) {
	if (!features.enabled) return false
	// Dishes come off the menu through recipes.
	if (isSoldOutAlertKind(kind)) return features.recipes
	// Orders and prices only exist with Purchasing.
	return kind === 'inventory_delivery_due' ||
		kind === 'inventory_price_rise' ||
		kind === 'inventory_repeat_order_draft' ||
		kind === 'inventory_order_approval'
		? features.purchasing
		: true
}

/**
 * `POST /resources/inventory/notify`: where the regional inventory tick tells
 * managers something needs attention at a location (items below their level,
 * a count waiting for review, a delivery due, a price rise).
 *
 * The event is a kind, a location id, a count and an event id (the contract's
 * `inventoryNotifyEventSchema`, strict, so a field that could carry an item or
 * an amount is a 400 and a rejected value is never echoed). Recipients come
 * from permissions and location scope, each member's preferences apply
 * (defaults: in-app and email on), and the in-app notification carries only the
 * kind, the location id and the count.
 *
 * Authenticated with `INTERNAL_COMMAND_TOKEN` only. Idempotent per event id and
 * member. A flag that is off, an unknown location or nobody to tell answers 200
 * with a `skipped` reason, so the node stops retrying what cannot succeed.
 */
type EnrichedPriceRiseDish = PriceRiseDishSummary & {
	menuItemId: string
	variantId: string | null
}

async function resolvePriceRiseDishes(
	organization: { id: string; dataRegion: string },
	entries: readonly PriceRiseDishAlertEntry[],
): Promise<EnrichedPriceRiseDish[]> {
	if (entries.length === 0) return []
	const needsVariantLookup = entries.some(
		(entry) => !entry.menuItemId && entry.variantId,
	)
	const menuItemIds = [
		...new Set(
			entries
				.map((entry) => entry.menuItemId)
				.filter((id): id is string => Boolean(id)),
		),
	]
	if (!needsVariantLookup && menuItemIds.length === 0) return []
	const [{ defaultLocale }, rows] = await Promise.all([
		orgSiteLocales(organization.id),
		needsVariantLookup
			? db
					.select({
						id: OrganizationMenuItem.id,
						displayName: OrganizationMenuItem.displayName,
						internalName: OrganizationMenuItem.internalName,
						price: OrganizationMenuItem.price,
						variations: OrganizationMenuItem.variations,
					})
					.from(OrganizationMenuItem)
					.where(eq(OrganizationMenuItem.organizationId, organization.id))
					.limit(500)
			: db
					.select({
						id: OrganizationMenuItem.id,
						displayName: OrganizationMenuItem.displayName,
						internalName: OrganizationMenuItem.internalName,
						price: OrganizationMenuItem.price,
						variations: OrganizationMenuItem.variations,
					})
					.from(OrganizationMenuItem)
					.where(
						and(
							eq(OrganizationMenuItem.organizationId, organization.id),
							inArray(OrganizationMenuItem.id, menuItemIds),
						),
					),
	])
	const byItemId = new Map<string, { name: string; price: number }>()
	const byVariantId = new Map<
		string,
		{ menuItemId: string; name: string; price: number }
	>()
	for (const row of rows) {
		const name =
			getLocalizedMenuValue(row.displayName, defaultLocale, defaultLocale) ||
			row.internalName ||
			''
		byItemId.set(row.id, { name, price: row.price })
		if (entries.some((entry) => entry.variantId)) {
			const parsed = parseMenuVariations(row.variations)
			const valueLabels = new Map<string, string>()
			for (const group of parsed.groups) {
				for (const val of group.values) {
					const label =
						getLocalizedMenuValue(val.name, defaultLocale, defaultLocale) || ''
					if (label) valueLabels.set(val.id, label)
				}
			}
			for (const variant of parsed.variants) {
				const variantLabel = variant.valueIds
					.map((id) => valueLabels.get(id))
					.filter(Boolean)
					.join(' / ')
				byVariantId.set(variant.id, {
					menuItemId: row.id,
					name: variantLabel ? `${name} (${variantLabel})` : name,
					price: variant.price,
				})
			}
		}
	}
	const currency = regionCurrency(organization.dataRegion)
	const out: EnrichedPriceRiseDish[] = []
	for (const entry of entries) {
		const variantInfo = entry.variantId
			? byVariantId.get(entry.variantId)
			: undefined
		const itemInfo = entry.menuItemId
			? byItemId.get(entry.menuItemId)
			: undefined
		const menuItemId = variantInfo?.menuItemId ?? entry.menuItemId ?? null
		const name = variantInfo?.name ?? itemInfo?.name ?? ''
		const price = variantInfo?.price ?? itemInfo?.price ?? null
		if (!menuItemId || !name || price === null) continue
		const sellingPriceMinor = majorToMinor(price, currency)
		const tax = {
			pricesIncludeTax: entry.pricesIncludeTax ?? false,
			taxRateBp: entry.taxRateBp ?? null,
		}
		const oldFoodCostBp = dishFoodCostBp(
			sellingPriceMinor,
			entry.previousCostMinor,
			tax,
		)
		const newFoodCostBp = dishFoodCostBp(
			sellingPriceMinor,
			entry.costMinor,
			tax,
		)
		const overTarget =
			newFoodCostBp !== null && newFoodCostBp > entry.targetFoodCostBp
		const crossedTarget =
			oldFoodCostBp !== null &&
			newFoodCostBp !== null &&
			oldFoodCostBp <= entry.targetFoodCostBp &&
			newFoodCostBp > entry.targetFoodCostBp
		out.push({
			menuItemId,
			variantId: entry.variantId ?? null,
			name,
			oldFoodCostBp,
			newFoodCostBp,
			targetFoodCostBp: entry.targetFoodCostBp,
			crossedTarget,
			overTarget,
		})
	}
	return out
}

export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		// Machine-to-machine endpoint: the 401 from internal auth is the answer.
		if (error instanceof Response && error.status === 401) return error
		throw error
	}

	const raw = await request.json().catch(() => null)
	const parsed = inventoryNotifyEventSchema.safeParse(raw)
	if (!parsed.success) {
		return Response.json(
			{
				error: 'invalid_request',
				issues: parsed.error.issues.slice(0, 10).map((issue) => ({
					path: issue.path.join('.'),
					code: issue.code,
				})),
			},
			{ status: 400, headers: NO_STORE },
		)
	}
	const event = parsed.data

	const organization = await db.query.Organization.findFirst({
		where: and(
			eq(Organization.id, event.orgId),
			eq(Organization.active, true),
			eq(Organization.hasProvisionedDb, true),
		),
		columns: { id: true, slug: true, dataRegion: true },
	})
	if (!organization) {
		return Response.json(
			{ error: 'org_not_found' },
			{ status: 404, headers: NO_STORE },
		)
	}

	if (!featureOn(await getInventoryFeatureState(organization.id), event.kind)) {
		return skipped('feature_off')
	}

	const [{ value: locationCount } = { value: 0 }] = await db
		.select({ value: count() })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))
	let locationName: string | null = null
	if (locationCount === 0) {
		// An organization without locations keeps its stock at the implicit
		// location `main`, named after the organization: nothing to add to copy.
		if (event.locationId !== DEFAULT_INVENTORY_LOCATION_ID) {
			return skipped('unknown_location')
		}
	} else {
		const location = await db.query.OrganizationLocation.findFirst({
			where: and(
				eq(OrganizationLocation.id, event.locationId),
				eq(OrganizationLocation.organizationId, organization.id),
			),
			columns: { name: true },
		})
		if (!location) return skipped('unknown_location')
		// With one location "at <name>" would only repeat the organization.
		locationName =
			locationCount > 1
				? displayLocationName(
						location.name,
						null,
						await orgDefaultLocale(organization.id),
					)
				: null
	}

	// Dishes off the menu by stock (#478): the same members and channels, with
	// quiet hours, snooze and the alert log applied.
	if (isSoldOutAlertKind(event.kind) && event.soldOut) {
		return answer(
			await deliverSoldOutAlert({
				organization,
				event: event as typeof event & {
					kind: 'inventory_sold_out' | 'inventory_sold_out_back'
				},
				locationName,
			}),
		)
	}

	const recipients = await resolveInventoryAlertRecipients({
		organizationId: organization.id,
		locationId: event.locationId,
		kind: event.kind,
	})
	if (recipients.length === 0) return skipped('no_recipients')

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

	const priceRiseDishes =
		event.kind === 'inventory_price_rise' && event.priceRiseDishes?.length
			? await resolvePriceRiseDishes(organization, event.priceRiseDishes)
			: []

	const copy = describeInventoryAlert({
		kind: event.kind,
		count: event.count,
		locationName,
		...(priceRiseDishes.length > 0 ? { priceRiseDishes } : {}),
		...(event.repeatOrderDraft
			? { repeatOrderDraft: event.repeatOrderDraft }
			: {}),
		...(event.orderApproval ? { orderApproval: event.orderApproval } : {}),
	})
	const baseUrl = String(ENV.BASE_URL ?? '').replace(/\/$/, '')
	const actionPath =
		event.kind === 'inventory_order_approval' && event.orderApproval
			? `/inventory/purchasing/orders/${encodeURIComponent(event.orderApproval.orderId)}`
			: inventoryAlertPath(event.kind)
	const actionUrl = `${baseUrl}/${organization.slug}${actionPath}`
	const inAppPayload = {
		kind: event.kind,
		locationId: event.locationId,
		count: event.count,
		orgSlug: organization.slug,
		...(locationName ? { locationName } : {}),
		...(priceRiseDishes.length > 0 ? { priceRiseDishes } : {}),
		...(event.orderApproval ? { orderApproval: event.orderApproval } : {}),
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

		// The row is also the claim for this event and member: a concurrent or
		// retried delivery that loses the insert sends nothing.
		const claimed = await db
			.insert(Notification)
			.values({
				userId: recipient.userId,
				organizationId: organization.id,
				type: channels.inApp ? type : INVENTORY_ALERT_MARKER_TYPE,
				entityId: event.eventId,
				payload: JSON.stringify(channels.inApp ? inAppPayload : {}),
				isRead: !channels.inApp,
				isSeen: !channels.inApp,
			})
			.onConflictDoNothing()
			.returning({ id: Notification.id })
		if (claimed.length === 0) continue
		if (channels.inApp) {
			inApp++
			pushRows.push({
				id: claimed[0]!.id,
				userId: recipient.userId,
				organizationId: organization.id,
				type,
				entityId: event.eventId,
				payload: inAppPayload,
			})
		}

		if (channels.email) {
			let sent = false
			try {
				const result = await sendEmail({
					to: recipient.email,
					subject: copy.subject,
					react: StaffingAlertEmail({
						eyebrow: copy.eyebrow,
						headline: copy.headline,
						detail: copy.detail,
						actionLabel: copy.actionLabel,
						actionUrl,
						settingsNote:
							'You can change these alerts in your notification settings.',
					}),
				})
				if (result.status === 'error') {
					console.error('Failed to send inventory alert email')
				} else {
					sent = true
					emailed++
				}
			} catch {
				console.error('Failed to send inventory alert email')
			}
			if (!sent && !channels.inApp && claimed[0]?.id) {
				await db.delete(Notification).where(eq(Notification.id, claimed[0].id))
			}
		}
	}

	// Mirrored as a push to the members who turned it on (#106).
	await pushStoredNotifications(pushRows)
	return answer({ inApp, emailed })
}
