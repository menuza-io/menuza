import { z } from 'zod'

import { restaurantOrderLineSchema } from './restaurant-orders.ts'

/**
 * Group orders (#170): a signed-in host starts a shared order, friends open a
 * link, add their own dishes by first name, and the host checks out once. The
 * group lives in the region only (first names are guest data); the link's
 * token rides in the URL fragment and the `X-Group-Token` header.
 */

export const GROUP_ORDER_FLAG = 'ordering.group'
export const GROUP_TOKEN_HEADER = 'X-Group-Token'
/** Clients poll the group view; there are no sockets. */
export const GROUP_POLL_INTERVAL_MS = 5000

export const GROUP_MIN_DEADLINE_MS = 15 * 60 * 1000
export const GROUP_MAX_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000
export const GROUP_MAX_PEOPLE = 25
export const GROUP_MAX_LINES = 100
/** A group with no activity for this long is deleted. */
export const GROUP_INACTIVE_PURGE_MS = 7 * 24 * 60 * 60 * 1000
export const GROUP_FIRST_NAME_MAX = 40

export const GROUP_STATUSES = ['open', 'locked', 'ordered', 'ended'] as const
export type GroupStatus = (typeof GROUP_STATUSES)[number]

export const GROUP_ERROR_CODES = [
	'group_not_found',
	'group_limit_reached',
	'group_locked',
	'group_deadline_passed',
	'group_full',
	'group_lines_full',
	'group_already_ordered',
	'group_changed',
	'host_cannot_leave',
	'group_items_unavailable',
	'group_empty',
	'group_disabled',
	'forbidden',
] as const
export type GroupErrorCode = (typeof GROUP_ERROR_CODES)[number]

const moneySchema = z.number().int().min(1).max(1_000_000_000)

/** `POST /orders/group` (customer token): the host starts a group. */
export const createGroupSchema = z.strictObject({
	locationId: z.string().trim().min(1).max(100),
	/** ISO instant 15 minutes to 7 days ahead; absent means no deadline. */
	deadlineAt: z.string().datetime({ offset: true }).max(40).optional(),
	perPersonLimitMinor: moneySchema.optional(),
	totalLimitMinor: moneySchema.optional(),
})
export type CreateGroupRequest = z.infer<typeof createGroupSchema>

/** Friends need only a first name: no account, no phone. */
export const joinGroupSchema = z.strictObject({
	firstName: z.string().trim().min(1).max(GROUP_FIRST_NAME_MAX),
})
export type JoinGroupRequest = z.infer<typeof joinGroupSchema>

/** One dish: the same line the cart sends to `POST /orders`. */
export const groupLineSchema = z.strictObject({
	line: restaurantOrderLineSchema,
})
export type GroupLineRequest = z.infer<typeof groupLineSchema>

/** The host's changes: only the host may send these. */
export const updateGroupSchema = z
	.strictObject({
		deadlineAt: z
			.string()
			.datetime({ offset: true })
			.max(40)
			.nullable()
			.optional(),
		perPersonLimitMinor: moneySchema.nullable().optional(),
		totalLimitMinor: moneySchema.nullable().optional(),
		/** Lock stops adding; unlocking is allowed until the order is placed. */
		locked: z.boolean().optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: 'Nothing to change',
	})
export type UpdateGroupRequest = z.infer<typeof updateGroupSchema>

export type GroupPersonView = {
	id: string
	firstName: string
	isHost: boolean
	isYou: boolean
	done: boolean
	lineCount: number
	subtotalMinor: number
}

export type GroupLineView = {
	id: string
	personId: string
	line: z.infer<typeof restaurantOrderLineSchema>
	itemName: string
	amountMinor: number
	/** Sold out or off the menu now: listed, and removed before paying. */
	available: boolean
	/** The viewer may remove it (their own, or any as the host). */
	canRemove: boolean
}

/** What a poll returns. Never a phone, an email or another person's token. */
export type GroupView = {
	id: string
	status: GroupStatus
	locationId: string
	hostFirstName: string
	deadlineAt: number | null
	perPersonLimitMinor: number | null
	totalLimitMinor: number | null
	totalMinor: number
	currency: string | null
	/** Bumped on every change; checkout names it (409 `group_changed`). */
	version: number
	people: GroupPersonView[]
	lines: GroupLineView[]
	you: { personId: string; isHost: boolean } | null
	/** Set once the host checked out: the link then shows the order status. */
	order: { id: string; number: string; status: string } | null
	/** The viewer may still add dishes. */
	canAdd: boolean
	serverNow: number
}

/** The HMAC message of a group's share token. Bumping the version burns links. */
export function groupShareTokenMessage(
	orgId: string,
	groupId: string,
	version: number,
): string {
	return `group_share:${orgId}:${groupId}:${version}`
}

/** The deadline rule shared by create and update. Returns an error or null. */
export function groupDeadlineError(
	deadlineMs: number,
	now: number,
): 'group_deadline_too_soon' | 'group_deadline_too_far' | null {
	if (deadlineMs - now < GROUP_MIN_DEADLINE_MS) return 'group_deadline_too_soon'
	if (deadlineMs - now > GROUP_MAX_DEADLINE_MS) return 'group_deadline_too_far'
	return null
}

/** Whether people may add or change dishes at `now`. */
export function groupAcceptsEdits(
	group: { status: GroupStatus; deadlineAt: number | null },
	now: number,
): 'open' | 'group_locked' | 'group_deadline_passed' | 'group_already_ordered' {
	if (group.status === 'ordered') return 'group_already_ordered'
	if (group.status === 'ended' || group.status === 'locked') {
		return 'group_locked'
	}
	if (group.deadlineAt != null && now >= group.deadlineAt) {
		return 'group_deadline_passed'
	}
	return 'open'
}

/**
 * Would adding `amountMinor` break a limit? The per-person limit counts one
 * person's dishes, the total limit counts the whole group. Pure.
 */
export function groupLimitBreak(input: {
	personSubtotalMinor: number
	groupSubtotalMinor: number
	amountMinor: number
	perPersonLimitMinor: number | null
	totalLimitMinor: number | null
}): 'group_limit_reached' | null {
	if (
		input.perPersonLimitMinor != null &&
		input.personSubtotalMinor + input.amountMinor > input.perPersonLimitMinor
	) {
		return 'group_limit_reached'
	}
	if (
		input.totalLimitMinor != null &&
		input.groupSubtotalMinor + input.amountMinor > input.totalLimitMinor
	) {
		return 'group_limit_reached'
	}
	return null
}

/** "For Sam": the label on the receipt and the kitchen ticket. */
export function groupLineLabel(
	firstName: string | null | undefined,
): string | null {
	const name = (firstName ?? '').trim()
	return name ? name.slice(0, GROUP_FIRST_NAME_MAX) : null
}
