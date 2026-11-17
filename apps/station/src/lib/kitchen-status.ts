import { type KdsTicket } from '@repo/common/kds'
import { autoFireDueCourses } from '@repo/common/kitchen-ticket'
import { useEffect, useSyncExternalStore } from 'react'
import { markCleared, openTabs, replaceOpenLines } from './orders.ts'
import { type CartLine } from './pricing.ts'
import { usePos } from './store.ts'
import { createKitchenApi } from '~/apps/kitchen/api.ts'
import { demoKitchen } from '~/apps/kitchen/demo.ts'

/** Where a dish that went to the kitchen is now, as the register shows it. */
export type DishStatus = 'queued' | 'preparing' | 'ready' | 'served'

const POLL_MS = 10_000
/** No kitchen in use, or it could not be reached: look again in a minute. */
const IDLE_POLL_MS = 60_000

type Tickets = ReadonlyMap<string, KdsTicket> | null

/**
 * One reader for the whole till, however many screens want it (the header, the
 * cart, Orders): each holds it while it needs it, and the last to let go stops it.
 */
const shared = {
	tickets: null as Tickets,
	listeners: new Set<() => void>(),
	holders: 0,
	generation: 0,
	timer: 0,
}

function publish(tickets: Tickets) {
	shared.tickets = tickets
	for (const listener of shared.listeners) listener()
}

function poll(generation: number) {
	if (generation !== shared.generation) return
	const { settings, session, online } = usePos.getState()
	const reachable =
		settings.demo ||
		(online && Boolean(settings.deviceToken && settings.tenantApiUrl))
	const again = (ms: number) => {
		if (generation === shared.generation)
			shared.timer = window.setTimeout(() => poll(generation), ms)
	}
	if (!reachable) {
		publish(null)
		return again(IDLE_POLL_MS)
	}
	const api = settings.demo ? demoKitchen : createKitchenApi(settings, session)
	void api.feed().then(
		(feed) => {
			if (generation !== shared.generation) return
			const inUse = feed.tickets.some(
				(ticket) =>
					ticket.completedAt !== null ||
					ticket.lines.some((line) => line.stage !== 'new'),
			)
			publish(
				inUse
					? new Map(
							feed.tickets
								.filter((ticket) => ticket.source === 'pos')
								.map((ticket) => [ticket.id, ticket]),
						)
					: null,
			)
			if (inUse) {
				void noteCleared(feed.tickets)
				void autoFireReadyCourses(feed.tickets)
			}
			// A restaurant that does not use the kitchen screen is asked far less often.
			again(inUse ? POLL_MS : IDLE_POLL_MS)
		},
		() => {
			if (generation !== shared.generation) return
			publish(null)
			again(IDLE_POLL_MS)
		},
	)
}

const courseReadySince = new Map<string, number>()

/**
 * When a course has been ready for the location's wait, fire the next one.
 * The time starts the first time this till sees every dish in that course ready.
 */
async function autoFireReadyCourses(tickets: readonly KdsTicket[]) {
	const { location } = usePos.getState()
	const minutes = location?.courses?.autoFireMinutes
	if (!location?.courses?.enabled || !minutes) return
	const now = Date.now()
	const open = await openTabs()
	for (const order of open) {
		if (order.orderType !== 'dine_in') continue
		const ticket = tickets.find(
			(item) => item.source === 'pos' && item.id === order.id,
		)
		if (!ticket) continue
		const byCourse = new Map<string, typeof ticket.lines>()
		for (const line of ticket.lines) {
			if (!line.courseId) continue
			const list = byCourse.get(line.courseId) ?? []
			list.push(line)
			byCourse.set(line.courseId, list)
		}
		const readyAt = new Map<string, number>()
		for (const [courseId, courseLines] of byCourse) {
			const key = `${order.id}:${courseId}`
			if (
				courseLines.length > 0 &&
				courseLines.every((line) => line.stage === 'ready' && !line.held)
			) {
				const at = courseReadySince.get(key) ?? now
				courseReadySince.set(key, at)
				readyAt.set(courseId, at)
			} else {
				courseReadySince.delete(key)
			}
		}
		const next = autoFireDueCourses(order.lines, readyAt, minutes, now)
		if (next.every((line, index) => line === order.lines[index])) continue
		await replaceOpenLines(order.id, next, now)
		if (usePos.getState().activeOrderId !== order.id) continue
		usePos.setState((state) => ({
			lines: state.lines.map((line) => {
				const updated = next.find((item) => item.id === line.id)
				if (!updated || line.courseHeld === updated.courseHeld) return line
				return {
					...line,
					courseHeld: updated.courseHeld,
					courseFiredAt: updated.courseFiredAt,
				}
			}),
		}))
	}
}

/** Tickets the kitchen cleared: their open tabs on this till record those dishes as served. */
async function noteCleared(tickets: readonly KdsTicket[]) {
	const cleared = tickets.filter(
		(ticket) => ticket.source === 'pos' && ticket.completedAt !== null,
	)
	if (cleared.length === 0) return
	const open = new Set((await openTabs()).map((order) => order.id))
	for (const ticket of cleared)
		if (open.has(ticket.id)) await markCleared(ticket.id, ticket.completedAt!)
}

/** Coming online, signing in or a new pairing asks at once, not on the next slow tick. */
let unwatch: (() => void) | null = null
function restart() {
	shared.generation += 1
	window.clearTimeout(shared.timer)
	poll(shared.generation)
}

function hold(): () => void {
	shared.holders += 1
	if (shared.holders === 1) {
		poll(++shared.generation)
		unwatch = usePos.subscribe((now, before) => {
			if (
				now.online !== before.online ||
				now.session !== before.session ||
				now.settings !== before.settings
			)
				restart()
		})
	}
	return () => {
		shared.holders -= 1
		if (shared.holders > 0) return
		unwatch?.()
		unwatch = null
		shared.generation += 1
		window.clearTimeout(shared.timer)
		// Nobody looks now: the next look starts fresh, not from minutes-old tickets.
		shared.tickets = null
	}
}

function subscribe(listener: () => void) {
	shared.listeners.add(listener)
	return () => shared.listeners.delete(listener)
}

/**
 * What the kitchen has done with this till's sales, by order id, read while
 * `active` (a tab is being looked at). Null when there is no kitchen to ask
 * (offline, not paired) or nobody uses it: a restaurant without a kitchen
 * screen never sees every dish "in queue".
 */
export function useKitchenTickets(active: boolean): Tickets {
	useEffect(() => (active ? hold() : undefined), [active])
	const tickets = useSyncExternalStore(
		subscribe,
		() => shared.tickets,
		() => null,
	)
	return active ? tickets : null
}

/**
 * Where the dish at `index` of an order is, from its kitchen ticket (the
 * ticket keeps the order's line order). Null when the kitchen has no ticket for
 * it yet, for example before the order uploads.
 */
export function dishStatus(
	ticket: KdsTicket | undefined,
	index: number,
): DishStatus | null {
	if (!ticket || ticket.cancelled) return null
	if (ticket.completedAt !== null) return 'served'
	const line = ticket.lines[index]
	if (!line) return null
	return line.stage === 'new' ? 'queued' : line.stage
}

/**
 * Where each sent line of an order is in the kitchen, by line id. Lines are
 * matched to the ticket's dishes by what they are (item, variant, quantity,
 * choices and notes), in order, so a line taken off before saving does not
 * shift the rest, and a medium burger never takes a well-done one's status.
 */
export function dishStatuses(
	lines: readonly CartLine[],
	ticket: KdsTicket | undefined,
): ReadonlyMap<string, DishStatus> {
	const statuses = new Map<string, DishStatus>()
	if (!ticket || ticket.cancelled) {
		for (const line of lines)
			if (line.sentAt && line.servedAt) statuses.set(line.id, 'served')
		return statuses
	}
	const choices = (
		options: ReadonlyArray<{ name: string; quantity: number }>,
	) =>
		options
			.map((option) => `${option.quantity}×${option.name}`)
			.sort()
			.join('|')
	const used = new Set<number>()
	for (const line of lines) {
		const chosen = choices(
			line.options.map((option) => ({
				name: option.optionName,
				quantity: option.quantity,
			})),
		)
		if (!line.sentAt) continue
		const index = ticket.lines.findIndex(
			(dish, at) =>
				!used.has(at) &&
				dish.itemId === line.itemId &&
				dish.variantId === line.variantId &&
				dish.quantity === line.quantity &&
				dish.instructions.trim() === line.instructions.trim() &&
				choices(dish.options) === chosen,
		)
		if (index >= 0) used.add(index)
		// A server said it reached the table: that is where it is, whatever the pass shows.
		if (line.servedAt) {
			statuses.set(line.id, 'served')
			continue
		}
		if (index < 0) continue
		const status = dishStatus(ticket, index)
		if (status) statuses.set(line.id, status)
	}
	return statuses
}

/** How many of an open order's dishes wait at the pass (quantities, not lines). */
export function readyDishes(
	order: { lines: readonly CartLine[] },
	ticket: KdsTicket | undefined,
): number {
	const statuses = dishStatuses(order.lines, ticket)
	return order.lines.reduce(
		(sum, line) =>
			sum + (statuses.get(line.id) === 'ready' ? line.quantity : 0),
		0,
	)
}
