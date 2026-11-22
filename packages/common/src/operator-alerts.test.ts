import { describe, expect, it } from 'vitest'
import {
	alertKeywordEventSchema,
	alertPhoneHash,
	DEV_ORDER_ALERT_HASH_SECRET,
	resolveOrderAlertHashSecret,
	ALERT_SETTINGS_WORKFLOW,
	decideDelivery,
	defaultPushEnabled,
	EMPTY_ALERT_POLICY,
	inQuietHours,
	isCriticalAlert,
	isLargeForAlert,
	largeOrderAlertRule,
	ORDER_ALERT_KINDS,
	orderAlertKindFromNotificationType,
	orderAlertNotificationType,
	orderPlacedEventSchema,
	ordersAlertSettingsSchema,
	ordersNotifyEventSchema,
	previewAlertCount,
	pushCategoryForNotificationType,
	PUSH_CATEGORIES,
	PUSH_CATEGORY_WORKFLOW,
	quietHoursEnd,
	snoozeEnd,
	stationOfflineEventSchema,
	type AlertPolicySettings,
} from './operator-alerts.ts'

const HOUR = 60 * 60 * 1000

const night: AlertPolicySettings = {
	quietStart: '22:00',
	quietEnd: '07:00',
	timeZone: 'America/New_York',
	snoozedUntil: null,
}

// 2026-11-21 23:30 in New York (EST, UTC-5) is 04:30 UTC on the 22nd.
const AT_NIGHT = Date.UTC(2026, 10, 22, 4, 30)
// 2026-11-21 12:00 New York.
const AT_NOON = Date.UTC(2026, 10, 21, 17, 0)

describe('notification types and push categories', () => {
	it('round-trips every kind through its notification type', () => {
		for (const kind of ORDER_ALERT_KINDS) {
			expect(
				orderAlertKindFromNotificationType(orderAlertNotificationType(kind)),
			).toBe(kind)
		}
		expect(orderAlertKindFromNotificationType('inventory-low-stock')).toBeNull()
	})

	it('files notifications under the categories a member can switch on', () => {
		expect(pushCategoryForNotificationType('orders-new')).toBe('new_orders')
		expect(pushCategoryForNotificationType('orders-due-soon')).toBe(
			'orders_waiting',
		)
		expect(pushCategoryForNotificationType('orders-paused-long')).toBe(
			'ordering_paused',
		)
		expect(pushCategoryForNotificationType('station-offline')).toBe(
			'station_offline',
		)
		expect(pushCategoryForNotificationType('staffing-no-clock-in')).toBe(
			'staff',
		)
		expect(pushCategoryForNotificationType('inventory-low-stock')).toBe(
			'inventory',
		)
		expect(pushCategoryForNotificationType('inventory-email-sent')).toBeNull()
		expect(pushCategoryForNotificationType('reservations-large-party')).toBe(
			'reservations',
		)
		expect(pushCategoryForNotificationType('chat-mention')).toBe(
			'chat_mentions',
		)
		expect(pushCategoryForNotificationType('mention')).toBeNull()
		expect(pushCategoryForNotificationType(undefined)).toBeNull()
	})

	it('keeps each category on its own preference row', () => {
		const workflows = PUSH_CATEGORIES.map((c) => PUSH_CATEGORY_WORKFLOW[c])
		expect(new Set(workflows).size).toBe(PUSH_CATEGORIES.length)
		expect(workflows).not.toContain(ALERT_SETTINGS_WORKFLOW)
	})

	it('defaults new-order push on for managers only; payment review is always on', () => {
		expect(defaultPushEnabled('new_orders', true)).toBe(true)
		expect(defaultPushEnabled('new_orders', false)).toBe(false)
		expect(defaultPushEnabled('large_orders', true)).toBe(true)
		expect(defaultPushEnabled('inventory', true)).toBe(false)
		expect(defaultPushEnabled('payment_review', false)).toBe(true)
	})

	it('marks payment review and the all-kitchens-offline case critical', () => {
		expect(isCriticalAlert('orders_payment_review')).toBe(true)
		expect(isCriticalAlert('station_offline')).toBe(false)
		expect(
			isCriticalAlert('station_offline', { allKitchenTabletsOffline: true }),
		).toBe(true)
		expect(isCriticalAlert('orders_new')).toBe(false)
	})
})

describe('events carry no guest fields', () => {
	const placed = {
		kind: 'order_placed' as const,
		orgId: 'org_ksa',
		eventId: 'order-1',
		locationId: 'loc-1',
		orderNumber: 'W-0042',
		fulfillment: 'pickup' as const,
		scheduledForMs: null,
		totalCents: 3850,
		currency: 'SAR',
		dishCount: 3,
		large: false,
	}

	it('accepts the ids, number, total and count', () => {
		expect(ordersNotifyEventSchema.parse(placed)).toEqual(placed)
	})

	it.each([
		'contactName',
		'contactPhone',
		'contactEmail',
		'deliveryAddress',
		'notes',
		'items',
		'lines',
	])('refuses a %s field', (field) => {
		expect(
			orderPlacedEventSchema.safeParse({ ...placed, [field]: 'x' }).success,
		).toBe(false)
	})

	it('refuses an order number that could carry a name', () => {
		expect(
			orderPlacedEventSchema.safeParse({ ...placed, orderNumber: 'Jo Smith' })
				.success,
		).toBe(false)
	})

	it('refuses extra fields on the tablet event too', () => {
		const offline = {
			kind: 'station_offline' as const,
			orgId: 'o',
			eventId: 'd1:1',
			locationId: null,
			deviceId: 'd1',
			deviceLabel: 'Kitchen',
			state: 'offline' as const,
			minutes: 5,
			allKitchenOffline: false,
			waitingOrderNumber: null,
		}
		expect(stationOfflineEventSchema.safeParse(offline).success).toBe(true)
		expect(
			stationOfflineEventSchema.safeParse({ ...offline, staffName: 'x' })
				.success,
		).toBe(false)
	})

	it('settings and keyword schemas are shaped as documented', () => {
		expect(
			ordersAlertSettingsSchema.safeParse({
				enabled: true,
				locations: [
					{
						id: 'l',
						waitingMinutes: 10,
						openIntervals: null,
						largeOrder: null,
					},
				],
			}).success,
		).toBe(true)
		expect(
			alertKeywordEventSchema.safeParse({
				keyword: 'stop',
				phoneHash: 'a'.repeat(64),
				providerMessageId: 'SM1',
			}).success,
		).toBe(true)
		// The number itself must never travel.
		expect(
			alertKeywordEventSchema.safeParse({
				keyword: 'stop',
				phoneHash: 'a'.repeat(64),
				providerMessageId: 'SM1',
				phone: '+15555550100',
			}).success,
		).toBe(false)
	})
})

describe('quiet hours and snooze', () => {
	it('knows when the member is in quiet hours, across midnight', () => {
		expect(inQuietHours(night, AT_NIGHT)).toBe(true)
		expect(inQuietHours(night, AT_NOON)).toBe(false)
		expect(inQuietHours(EMPTY_ALERT_POLICY, AT_NIGHT)).toBe(false)
		expect(
			inQuietHours(
				{ ...night, quietStart: '08:00', quietEnd: '08:00' },
				AT_NIGHT,
			),
		).toBe(false)
	})

	it('says when they end', () => {
		// 23:30 -> 07:00 next morning New York = 12:00 UTC.
		expect(quietHoursEnd(night, AT_NIGHT)).toBe(Date.UTC(2026, 10, 22, 12, 0))
		// 03:00 local the same night ends the same morning.
		const earlyMorning = Date.UTC(2026, 10, 22, 8, 0)
		expect(quietHoursEnd(night, earlyMorning)).toBe(
			Date.UTC(2026, 10, 22, 12, 0),
		)
		expect(quietHoursEnd(night, AT_NOON)).toBeNull()
	})

	it('snoozes for an hour, until tomorrow morning, or a custom time', () => {
		expect(snoozeEnd('1h', AT_NOON, 'America/New_York')).toBe(AT_NOON + HOUR)
		// 06:00 on the 22nd in New York = 11:00 UTC.
		expect(snoozeEnd('tomorrow', AT_NOON, 'America/New_York')).toBe(
			Date.UTC(2026, 10, 22, 11, 0),
		)
		expect(snoozeEnd('custom', AT_NOON, null, AT_NOON + 3 * HOUR)).toBe(
			AT_NOON + 3 * HOUR,
		)
		expect(snoozeEnd('custom', AT_NOON, null, AT_NOON - 1)).toBeNull()
		expect(snoozeEnd('custom', AT_NOON, null, null)).toBeNull()
	})
})

describe('decideDelivery', () => {
	it('delivers when nothing holds it back', () => {
		expect(
			decideDelivery({
				settings: EMPTY_ALERT_POLICY,
				critical: false,
				nowMs: AT_NOON,
			}),
		).toEqual({ outcome: 'deliver' })
	})

	it('snoozes for an hour', () => {
		const settings = { ...EMPTY_ALERT_POLICY, snoozedUntil: AT_NOON + HOUR }
		expect(
			decideDelivery({ settings, critical: false, nowMs: AT_NOON }),
		).toEqual({ outcome: 'snoozed', until: AT_NOON + HOUR })
		// The hour is over.
		expect(
			decideDelivery({ settings, critical: false, nowMs: AT_NOON + HOUR + 1 }),
		).toEqual({ outcome: 'deliver' })
	})

	it('holds non-critical alerts in quiet hours until they end', () => {
		expect(
			decideDelivery({ settings: night, critical: false, nowMs: AT_NIGHT }),
		).toEqual({ outcome: 'held', until: Date.UTC(2026, 10, 22, 12, 0) })
	})

	it('never holds or snoozes a critical alert', () => {
		expect(
			decideDelivery({
				settings: { ...night, snoozedUntil: AT_NIGHT + HOUR },
				critical: true,
				nowMs: AT_NIGHT,
			}),
		).toEqual({ outcome: 'critical' })
	})

	it('applies the threshold before snooze and quiet hours', () => {
		expect(
			decideDelivery({
				settings: EMPTY_ALERT_POLICY,
				critical: false,
				nowMs: AT_NOON,
				threshold: 3,
				occurrencesInHour: 2,
			}),
		).toEqual({ outcome: 'below_threshold' })
		expect(
			decideDelivery({
				settings: EMPTY_ALERT_POLICY,
				critical: false,
				nowMs: AT_NOON,
				threshold: 3,
				occurrencesInHour: 3,
			}),
		).toEqual({ outcome: 'deliver' })
	})
})

describe('previewAlertCount', () => {
	// Ten orders, five minutes apart, at noon New York.
	const burst = Array.from({ length: 10 }, (_, i) => AT_NOON + i * 5 * 60_000)

	it('changes when the threshold changes', () => {
		const every = previewAlertCount({
			occurrences: burst,
			settings: EMPTY_ALERT_POLICY,
			threshold: 1,
		})
		const third = previewAlertCount({
			occurrences: burst,
			settings: EMPTY_ALERT_POLICY,
			threshold: 3,
		})
		expect(every.delivered).toBe(10)
		expect(third.delivered).toBe(8)
		expect(third.belowThreshold).toBe(2)
		expect(third.delivered).toBeLessThan(every.delivered)
	})

	it('counts alerts held by quiet hours separately', () => {
		const nightBurst = [AT_NIGHT, AT_NIGHT + 60_000]
		const preview = previewAlertCount({
			occurrences: [...burst, ...nightBurst],
			settings: night,
			threshold: 1,
		})
		expect(preview.held).toBe(2)
		expect(preview.delivered).toBe(10)
		expect(preview.perDay).toBeCloseTo(10 / 7, 1)
	})

	it('is zero for no history', () => {
		expect(
			previewAlertCount({ occurrences: [], settings: EMPTY_ALERT_POLICY }),
		).toMatchObject({ delivered: 0, held: 0, perDay: 0 })
	})
})

describe('large orders', () => {
	it('is strictly over the threshold, by dishes or by amount', () => {
		const rule = { itemThreshold: 8, amountThresholdMinor: 20_000 }
		expect(isLargeForAlert(rule, { itemCount: 9, subtotalCents: 100 })).toBe(
			true,
		)
		expect(isLargeForAlert(rule, { itemCount: 8, subtotalCents: 100 })).toBe(
			false,
		)
		expect(isLargeForAlert(rule, { itemCount: 1, subtotalCents: 20_001 })).toBe(
			true,
		)
		expect(isLargeForAlert(rule, { itemCount: 1, subtotalCents: 20_000 })).toBe(
			false,
		)
		expect(isLargeForAlert(null, { itemCount: 99, subtotalCents: 9e9 })).toBe(
			false,
		)
		expect(
			isLargeForAlert(
				{ itemThreshold: 8 },
				{ itemCount: 3, subtotalCents: 9e9 },
			),
		).toBe(false)
	})

	it("defaults to the location's existing large-order threshold", () => {
		expect(
			largeOrderAlertRule({
				alert: null,
				threshold: 100,
				thresholdType: 'dollars',
			}),
		).toEqual({ amountThresholdMinor: 10_000 })
		expect(
			largeOrderAlertRule({
				alert: null,
				threshold: 8,
				thresholdType: 'items',
			}),
		).toEqual({ itemThreshold: 8 })
		expect(
			largeOrderAlertRule({
				alert: null,
				threshold: null,
				thresholdType: 'dollars',
			}),
		).toBeNull()
	})

	it("prefers the location's large-order prep rule over its older single threshold", () => {
		expect(
			largeOrderAlertRule({
				alert: null,
				saved: { itemThreshold: 12, amountMinor: null },
				threshold: 100,
				thresholdType: 'dollars',
			}),
		).toEqual({ itemThreshold: 12 })
		expect(
			largeOrderAlertRule({
				alert: null,
				saved: { itemThreshold: 12, amountMinor: 30000 },
				threshold: 100,
				thresholdType: 'dollars',
			}),
		).toEqual({ itemThreshold: 12, amountThresholdMinor: 30000 })
	})

	it('lets the alert set its own threshold', () => {
		expect(
			largeOrderAlertRule({
				alert: { itemThreshold: 12, amountThreshold: 250 },
				threshold: 100,
				thresholdType: 'dollars',
			}),
		).toEqual({ itemThreshold: 12, amountThresholdMinor: 25_000 })
	})
})

describe('resolveOrderAlertHashSecret', () => {
	const good = 'a-real-order-alert-hash-secret-0123456789'
	it('accepts a long secret that is not the command token', () => {
		expect(
			resolveOrderAlertHashSecret({
				secret: good,
				internalCommandToken: 'another-internal-token-long-enough',
				placeholderAllowed: false,
			}),
		).toBe(good)
	})

	it('is unusable when missing, short, or equal to the command token', () => {
		const base = { internalCommandToken: good, placeholderAllowed: true }
		expect(resolveOrderAlertHashSecret({ ...base, secret: '' })).toBe('')
		expect(resolveOrderAlertHashSecret({ ...base, secret: undefined })).toBe('')
		expect(resolveOrderAlertHashSecret({ ...base, secret: 'short' })).toBe('')
		expect(resolveOrderAlertHashSecret({ ...base, secret: good })).toBe('')
	})

	it('refuses the development default except in development and test', () => {
		expect(
			resolveOrderAlertHashSecret({
				secret: DEV_ORDER_ALERT_HASH_SECRET,
				placeholderAllowed: false,
			}),
		).toBe('')
		expect(
			resolveOrderAlertHashSecret({
				secret: DEV_ORDER_ALERT_HASH_SECRET,
				placeholderAllowed: true,
			}),
		).toBe(DEV_ORDER_ALERT_HASH_SECRET)
	})

	it('hashes a number the same way however it is typed, and differently per secret', async () => {
		const one = await alertPhoneHash('+14155550100', good)
		expect(await alertPhoneHash('+1 (415) 555-0100', good)).toBe(one)
		expect(one).toMatch(/^[0-9a-f]{64}$/)
		expect(await alertPhoneHash('+14155550100', good + 'x')).not.toBe(one)
	})
})
