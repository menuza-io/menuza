import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { type LiveTableState } from '#app/utils/reservations/book-api.ts'
import {
	ACTIVE_WAITLIST_STATUSES,
	type WaitlistEntry,
	type WaitlistStatus,
	type WaitlistStatusTarget,
} from '#app/utils/reservations/waitlist-api.ts'

export const WAITLIST_STATUS_LABELS: Record<string, MessageDescriptor> = {
	waiting: msg`Waiting`,
	notified: msg`Notified`,
	on_the_way: msg`On the way`,
	seated: msg`Seated`,
	cancelled: msg`Cancelled`,
	left: msg`Left`,
	no_response: msg`No response`,
}

export type WaitlistBadgeVariant =
	'secondary' | 'warning' | 'success' | 'default' | 'outline' | 'destructive'

export function waitlistStatusVariant(status: string): WaitlistBadgeVariant {
	switch (status) {
		case 'waiting':
			return 'secondary'
		case 'notified':
			return 'warning'
		case 'on_the_way':
			return 'success'
		case 'seated':
			return 'default'
		case 'no_response':
			return 'destructive'
		default:
			return 'outline'
	}
}

export function isActiveWaitlistStatus(status: string): boolean {
	return (ACTIVE_WAITLIST_STATUSES as readonly string[]).includes(status)
}

/** Queue order as the server returns it: active entries first, by `position`. */
export function splitWaitlist(entries: readonly WaitlistEntry[]) {
	const active = entries
		.filter((entry) => isActiveWaitlistStatus(entry.status))
		.sort(
			(a, b) =>
				(a.position ?? Number.MAX_SAFE_INTEGER) -
					(b.position ?? Number.MAX_SAFE_INTEGER) || a.sortKey - b.sortKey,
		)
	const settled = entries
		.filter((entry) => !isActiveWaitlistStatus(entry.status))
		.sort((a, b) => b.createdAt - a.createdAt)
	return { active, settled }
}

export function splitMinutes(totalMin: number): {
	hours: number
	minutes: number
} {
	const safe = Math.max(0, Math.round(totalMin))
	return { hours: Math.floor(safe / 60), minutes: safe % 60 }
}

export function minutesSince(
	startMs: number | null | undefined,
	nowMs: number,
): number {
	if (startMs == null || !Number.isFinite(startMs)) return 0
	return Math.max(0, Math.floor((nowMs - startMs) / 60_000))
}

/** True once the party has waited longer than the wait that was quoted to them. */
export function isQuoteExceeded(entry: WaitlistEntry, nowMs: number): boolean {
	if (!isActiveWaitlistStatus(entry.status) || entry.quotedMin === null) {
		return false
	}
	return minutesSince(entry.joinedAt, nowMs) > entry.quotedMin
}

export type DeadlineCountdown = {
	expired: boolean
	totalSeconds: number
	minutes: number
	seconds: number
}

/** Time left to answer the table-ready message; `null` when there is no open offer. */
export function deadlineCountdown(
	entry: Pick<WaitlistEntry, 'status' | 'responseDeadlineAt'>,
	nowMs: number,
): DeadlineCountdown | null {
	if (entry.status !== 'notified' || entry.responseDeadlineAt === null) {
		return null
	}
	const remainingMs = entry.responseDeadlineAt - nowMs
	const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
	return {
		expired: remainingMs <= 0,
		totalSeconds,
		minutes: Math.floor(totalSeconds / 60),
		seconds: totalSeconds % 60,
	}
}

export function formatCountdown(countdown: DeadlineCountdown): string {
	return `${countdown.minutes}:${String(countdown.seconds).padStart(2, '0')}`
}

export type WaitlistActions = {
	notify: boolean
	seat: boolean
	edit: boolean
	reorder: boolean
	/** Status changes the host may request, in display order. */
	statuses: readonly WaitlistStatusTarget[]
}

const NO_ACTIONS: WaitlistActions = {
	notify: false,
	seat: false,
	edit: false,
	reorder: false,
	statuses: [],
}

/** Mirrors the server's transition table; the server stays the authority. */
export function availableActions(
	status: WaitlistStatus,
	canManage: boolean,
): WaitlistActions {
	if (!canManage) return NO_ACTIONS
	switch (status) {
		case 'waiting':
			return {
				notify: true,
				seat: true,
				edit: true,
				reorder: true,
				statuses: ['on_the_way', 'left', 'no_response', 'cancelled'],
			}
		case 'notified':
			return {
				notify: false,
				seat: true,
				edit: true,
				reorder: true,
				statuses: ['on_the_way', 'waiting', 'left', 'no_response', 'cancelled'],
			}
		case 'on_the_way':
			return {
				notify: true,
				seat: true,
				edit: true,
				reorder: true,
				statuses: ['waiting', 'left', 'no_response', 'cancelled'],
			}
		case 'no_response':
			return { ...NO_ACTIONS, statuses: ['waiting'] }
		default:
			return NO_ACTIONS
	}
}

export function moveWithin(
	ids: readonly string[],
	id: string,
	toIndex: number,
): string[] {
	const from = ids.indexOf(id)
	if (from < 0) return [...ids]
	const clamped = Math.max(0, Math.min(ids.length - 1, toIndex))
	if (clamped === from) return [...ids]
	const next = [...ids]
	next.splice(from, 1)
	next.splice(clamped, 0, id)
	return next
}

/** The new order after moving `id` one place up (-1) or down (1); `null` at an edge. */
export function reorderByStep(
	ids: readonly string[],
	id: string,
	step: -1 | 1,
): string[] | null {
	const from = ids.indexOf(id)
	const to = from + step
	if (from < 0 || to < 0 || to >= ids.length) return null
	return moveWithin(ids, id, to)
}

export function sameOrder(a: readonly string[], b: readonly string[]) {
	return a.length === b.length && a.every((id, index) => id === b[index])
}

/** Applies a pending order on top of the polled entries; unknown ids drop out. */
export function applyOrder(
	entries: readonly WaitlistEntry[],
	order: readonly string[] | null,
): WaitlistEntry[] {
	if (!order) return [...entries]
	const byId = new Map(entries.map((entry) => [entry.id, entry]))
	const ordered = order
		.map((id) => byId.get(id))
		.filter((entry): entry is WaitlistEntry => Boolean(entry))
	const seen = new Set(ordered.map((entry) => entry.id))
	return [...ordered, ...entries.filter((entry) => !seen.has(entry.id))]
}

export type TableCandidate = {
	table: LiveTableState
	free: boolean
	fits: boolean
}

/** Tables that are open right now first, then ones that fit the party, then the rest by size. */
export function tableCandidates(
	tableStates: readonly LiveTableState[],
	partySize: number,
): TableCandidate[] {
	return tableStates
		.map((table) => ({
			table,
			free: table.status === 'open' || table.status === 'reserved_soon',
			fits: table.minCovers <= partySize && partySize <= table.maxCovers,
		}))
		.sort((a, b) => {
			if (a.free !== b.free) return a.free ? -1 : 1
			if (a.fits !== b.fits) return a.fits ? -1 : 1
			return a.table.maxCovers - b.table.maxCovers
		})
}

export function describeWaitlistGuest(entry: WaitlistEntry): string {
	return `${entry.displayName} (${entry.partySize})`
}

/** Button text for each status change; the status labels read as states, not verbs. */
export const WAITLIST_STATUS_ACTION_LABELS: Record<
	WaitlistStatusTarget,
	MessageDescriptor
> = {
	waiting: msg`Back to waiting`,
	on_the_way: msg`Mark on the way`,
	no_response: msg`Mark no response`,
	left: msg`Mark left`,
	cancelled: msg`Remove from list`,
}

/** Changes that cannot be undone from the screen, so they ask first. */
export function needsConfirmation(status: WaitlistStatusTarget): boolean {
	return status === 'cancelled' || status === 'left'
}

/** The channel key `ChannelBadge` understands. */
export function waitlistChannelKey(entry: Pick<WaitlistEntry, 'channel'>) {
	return entry.channel === 'remote' ? 'online' : 'walk_in'
}
