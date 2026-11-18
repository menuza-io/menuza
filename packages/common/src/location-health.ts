/**
 * Can this location take orders right now? (#332) One pure function turns what
 * the App already holds for a location (its hours and pause, the payments
 * account, the menu, the site and domain, POS and delivery connections, the
 * phone agent) into typed checks, each with plain words and a link to the
 * setting that fixes it. No I/O, so Admin and support can reuse it.
 *
 * Checks run on page load from existing data. A check whose data does not exist
 * for the location (no custom domain, no POS connection, no phone agent) is left
 * out rather than shown as passed. Not covered here: whether a kitchen screen or
 * printer is online. That status lives with the Station terminals in the
 * regional database and needs a regional call; see `UNSUPPORTED_HEALTH_CHECKS`.
 */
import { weeklyScheduleHasOpenDay } from '@repo/opening-hours'

import { isLocationOpenForOrdering } from './location-availability.ts'
import {
	WeeklyScheduleSchema,
	type SpecialHour,
	type WeeklySchedule,
} from './location-types.ts'

export type HealthStatus = 'ok' | 'info' | 'warning' | 'blocking'

export type HealthCheckId =
	| 'ordering'
	| 'hours'
	| 'payments'
	| 'menu'
	| 'website'
	| 'domain'
	| 'sync'
	| 'phone_agent'

/** Checks this version does not run, and why (listed in the PR and docs). */
export const UNSUPPORTED_HEALTH_CHECKS = [
	{
		id: 'kitchen_device',
		reason:
			'Kitchen screen and printer status is kept per Station terminal in the regional database; it cannot be read on page load from the control plane.',
	},
] as const

export type HealthCheck = {
	id: HealthCheckId
	status: HealthStatus
	/** Stable code the App words in the reader's language. */
	code: string
	/** Plain-words English message (fallback and for support tools). */
	message: string
	/** App path (without the organization slug) that fixes it; null when nothing to fix. */
	href: string | null
	/** Values the message mentions, as strings. */
	params?: Record<string, string>
}

export type HealthSummary =
	'taking_orders' | 'taking_orders_with_problems' | 'not_taking_orders'

export type LocationHealthInput = {
	now: Date
	location: {
		id: string
		name: string
		timezone: string
		/** JSON text as stored, or already parsed. */
		storeHours: string | WeeklySchedule | null
		onlineHours: string | WeeklySchedule | null
		specialHours: string | SpecialHour[] | null
		orderingPausedAt: Date | null
		orderingPausedUntil: Date | null
	}
	organization: {
		/** Online payments can be taken (`resolveRestaurantOnlinePayment(...).enabled`). */
		onlinePaymentsEnabled: boolean
		/** The restaurant chose "pay at pickup only" on purpose. */
		payAtPickupOnly: boolean
		sitePublished: boolean
		customDomain: string | null
		customDomainStatus: string | null
	}
	/** Whether a menu is on sale at this location now. */
	hasActiveMenu: boolean
	/** POS and delivery connections linked to this location. */
	connections: Array<{
		providerName: string
		isActive: boolean
		lastSyncAt: Date | null
	}>
	/** `null` when the organization has no phone agent set up. */
	phoneAgent: { enabled: boolean; hasActiveLine: boolean } | null
}

export type LocationHealth = {
	locationId: string
	name: string
	summary: HealthSummary
	/** Closed by its hours right now (informational: not a problem). */
	closedNow: boolean
	checks: HealthCheck[]
	/** Every check passed (informational notes such as "closed now" do not count against it). */
	allPassed: boolean
}

const BROKEN_DOMAIN = new Set(['error', 'blocked', 'moved', 'deleted'])
/** A connection that has not synced for this long is reported. */
export const STALE_SYNC_MS = 48 * 60 * 60 * 1000

function parseSchedule(
	value: string | WeeklySchedule | null,
): WeeklySchedule | null {
	if (!value) return null
	let raw: unknown = value
	if (typeof value === 'string') {
		try {
			raw = JSON.parse(value)
		} catch {
			return null
		}
	}
	const parsed = WeeklyScheduleSchema.safeParse(raw)
	return parsed.success ? (parsed.data as WeeklySchedule) : null
}

function parseSpecial(
	value: string | SpecialHour[] | null,
): SpecialHour[] | null {
	if (!value) return null
	if (Array.isArray(value)) return value
	try {
		const parsed: unknown = JSON.parse(value)
		return Array.isArray(parsed) ? (parsed as SpecialHour[]) : null
	} catch {
		return null
	}
}

export function summarizeStatuses(
	statuses: readonly HealthStatus[],
): HealthSummary {
	if (statuses.includes('blocking')) return 'not_taking_orders'
	if (statuses.includes('warning')) return 'taking_orders_with_problems'
	return 'taking_orders'
}

/** The restaurant-level summary: the worst state of any location. */
export function summarizeLocations(
	locations: readonly Pick<LocationHealth, 'summary'>[],
): HealthSummary {
	if (locations.some((l) => l.summary === 'not_taking_orders'))
		return 'not_taking_orders'
	if (locations.some((l) => l.summary === 'taking_orders_with_problems'))
		return 'taking_orders_with_problems'
	return 'taking_orders'
}

export function getLocationHealth(input: LocationHealthInput): LocationHealth {
	const { location, organization, now } = input
	const checks: HealthCheck[] = []
	const storeHours = parseSchedule(location.storeHours)
	const onlineHours = parseSchedule(location.onlineHours)
	const specialHours = parseSpecial(location.specialHours)
	const editLocation = `/settings/locations/${location.id}`

	// 1. Ordering paused by an operator.
	const pauseEnd = location.orderingPausedUntil
	const paused =
		location.orderingPausedAt !== null &&
		(pauseEnd === null || pauseEnd.getTime() > now.getTime())
	checks.push(
		paused
			? {
					id: 'ordering',
					status: 'blocking',
					code: 'ordering_paused',
					message:
						'Online ordering is paused. Guests cannot order until it is resumed.',
					href: '/orders',
					...(pauseEnd ? { params: { until: pauseEnd.toISOString() } } : {}),
				}
			: {
					id: 'ordering',
					status: 'ok',
					code: 'ordering_on',
					message: 'Online ordering is on.',
					href: null,
				},
	)

	// 2. Hours: none set, closed right now, or open.
	const hasHours =
		weeklyScheduleHasOpenDay(location.storeHours) ||
		weeklyScheduleHasOpenDay(location.onlineHours)
	if (!hasHours) {
		checks.push({
			id: 'hours',
			status: 'warning',
			code: 'no_hours',
			message:
				'No opening hours are set, so guests cannot tell when you are open.',
			href: editLocation,
		})
	}
	const availability = isLocationOpenForOrdering(
		{
			timezone: location.timezone,
			storeHours,
			onlineHours,
			specialHours,
			isActive: true,
		},
		now,
	)
	const closedNow = hasHours && !availability.isOpen
	if (hasHours) {
		checks.push(
			closedNow
				? {
						id: 'hours',
						status: 'info',
						code: 'closed_now',
						message: 'Closed right now by its opening hours.',
						href: editLocation,
						...(availability.nextOpen
							? { params: { nextOpen: availability.nextOpen } }
							: {}),
					}
				: {
						id: 'hours',
						status: 'ok',
						code: 'open_now',
						message: 'Open now by its opening hours.',
						href: null,
					},
		)
	}

	// 3. Payments account.
	if (organization.onlinePaymentsEnabled) {
		checks.push({
			id: 'payments',
			status: 'ok',
			code: 'payments_ready',
			message: 'The payments account can take card payments.',
			href: null,
		})
	} else if (organization.payAtPickupOnly) {
		checks.push({
			id: 'payments',
			status: 'ok',
			code: 'pay_at_pickup_only',
			message: 'Guests pay at pickup (online payments are off on purpose).',
			href: null,
		})
	} else {
		checks.push({
			id: 'payments',
			status: 'blocking',
			code: 'payments_disabled',
			message:
				'The payments account is not active, so guests cannot pay online. Finish connecting it.',
			href: '/settings/shop',
		})
	}

	// 4. A menu on sale here.
	checks.push(
		input.hasActiveMenu
			? {
					id: 'menu',
					status: 'ok',
					code: 'menu_on_sale',
					message: 'A menu is on sale here.',
					href: null,
				}
			: {
					id: 'menu',
					status: 'blocking',
					code: 'no_active_menu',
					message:
						'No menu is on sale at this location, so there is nothing to order.',
					href: '/menu/menus',
				},
	)

	// 5. The website guests order from.
	checks.push(
		organization.sitePublished
			? {
					id: 'website',
					status: 'ok',
					code: 'site_published',
					message: 'The website is published.',
					href: null,
				}
			: {
					id: 'website',
					status: 'blocking',
					code: 'site_unpublished',
					message:
						'The website is not published, so guests cannot reach your menu.',
					href: '/website',
				},
	)

	// 6. Custom domain (only when there is one).
	if (organization.customDomain) {
		checks.push(
			BROKEN_DOMAIN.has(organization.customDomainStatus ?? '')
				? {
						id: 'domain',
						status: 'warning',
						code: 'domain_error',
						message:
							'Your custom domain has a problem. Guests can still reach the site on its Menuza address.',
						href: '/website',
						params: { domain: organization.customDomain },
					}
				: {
						id: 'domain',
						status: 'ok',
						code: 'domain_ok',
						message: 'The custom domain works.',
						href: null,
					},
		)
	}

	// 7. POS and delivery connections linked to this location.
	for (const connection of input.connections) {
		const stale =
			connection.lastSyncAt !== null &&
			now.getTime() - connection.lastSyncAt.getTime() > STALE_SYNC_MS
		if (!connection.isActive) {
			checks.push({
				id: 'sync',
				status: 'warning',
				code: 'sync_disconnected',
				message: `${connection.providerName} is disconnected, so its orders and menu are not syncing.`,
				href: `/settings/integrations?locationId=${encodeURIComponent(location.id)}`,
				params: { provider: connection.providerName },
			})
		} else if (stale) {
			checks.push({
				id: 'sync',
				status: 'warning',
				code: 'sync_stale',
				message: `${connection.providerName} has not synced for over two days.`,
				href: `/settings/integrations?locationId=${encodeURIComponent(location.id)}`,
				params: { provider: connection.providerName },
			})
		} else {
			checks.push({
				id: 'sync',
				status: 'ok',
				code: 'sync_ok',
				message: `${connection.providerName} is connected.`,
				href: null,
				params: { provider: connection.providerName },
			})
		}
	}

	// 8. The phone agent, when it is on.
	if (input.phoneAgent?.enabled) {
		checks.push(
			input.phoneAgent.hasActiveLine
				? {
						id: 'phone_agent',
						status: 'ok',
						code: 'phone_agent_ready',
						message: 'The phone agent is on and has an active line.',
						href: null,
					}
				: {
						id: 'phone_agent',
						status: 'warning',
						code: 'phone_line_inactive',
						message:
							'The phone agent is on but has no active phone line for this location.',
						href: '/phone-agent',
					},
		)
	}

	return {
		locationId: location.id,
		name: location.name,
		summary: summarizeStatuses(checks.map((check) => check.status)),
		closedNow,
		checks,
		allPassed: checks.every(
			(check) => check.status === 'ok' || check.status === 'info',
		),
	}
}
