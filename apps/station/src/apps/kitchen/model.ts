import {
	kdsFireAt,
	kdsTicketStage,
	type KdsConfig,
	type KdsLine,
	type KdsTicket,
	type KdsStage,
} from '@repo/common/kds'

export type KitchenView = 'active' | 'scheduled' | 'done'

const stationLines = (ticket: KdsTicket, stationId: string | null) =>
	ticket.lines.filter((line) => !stationId || line.stationId === stationId)

/**
 * The dishes a table added after the kitchen made the earlier ones: every dish
 * not ready yet, when each was sent later than every ready one. Null when the
 * open dishes are not a later round (or there is nothing left to make).
 */
export function laterRound(
	ticket: KdsTicket,
	stationId: string | null,
): KdsLine[] | null {
	const lines = stationLines(ticket, stationId)
	const open = lines.filter((line) => line.stage !== 'ready')
	const ready = lines.filter((line) => line.stage === 'ready')
	if (!open.length || !ready.length) return null
	if (open.some((line) => line.firedAt == null)) return null
	const sent = Math.min(...open.map((line) => line.firedAt!))
	return ready.every((line) => (line.firedAt ?? ticket.createdAt) < sent)
		? open
		: null
}

/**
 * When the work still to make was fired: a later round counts from when the
 * table added it, so dessert ordered an hour in is not already late, and it
 * queues behind the tickets that came in before it.
 */
export function workFiredAt(
	ticket: KdsTicket,
	config: KdsConfig,
	stationId: string | null,
): number {
	const fired = kdsFireAt(ticket, config)
	const round = laterRound(ticket, stationId)
	return round
		? Math.max(fired, ...round.map((line) => line.firedAt ?? fired))
		: fired
}

export function visibleTickets(
	tickets: KdsTicket[],
	config: KdsConfig,
	filter: { stationId: string | null; channel: string; view: KitchenView },
	now: number,
) {
	return tickets
		.filter(
			(ticket) =>
				(filter.channel === 'all' || ticket.channel === filter.channel) &&
				(!filter.stationId ||
					ticket.lines.some((line) => line.stationId === filter.stationId)) &&
				(filter.view === 'done'
					? ticket.completedAt !== null
					: ticket.completedAt === null &&
						(filter.view === 'scheduled'
							? kdsFireAt(ticket, config) > now
							: kdsFireAt(ticket, config) <= now)),
		)
		.sort((a, b) =>
			filter.view === 'done'
				? (b.completedAt ?? 0) - (a.completedAt ?? 0)
				: workFiredAt(a, config, filter.stationId) -
						workFiredAt(b, config, filter.stationId) ||
					a.createdAt - b.createdAt,
		)
}

export function nextKitchenStage(stage: KdsStage, config: KdsConfig): KdsStage {
	return stage === 'new' && config.showPreparing
		? 'preparing'
		: stage === 'ready'
			? 'new'
			: 'ready'
}

/** Where a ticket stands for a screen. A later round that nobody started is new work. */
export function stationStage(ticket: KdsTicket, stationId: string | null) {
	return kdsTicketStage(
		laterRound(ticket, stationId) ?? stationLines(ticket, stationId),
	)
}

/** One dish still to make across the board, with how many. */
export type AllDayCount = {
	key: string
	itemId: string
	name: string
	variant: string | null
	quantity: number
}

/**
 * The "all day" count: how many of each dish are still to make on the open
 * tickets (new or preparing, not ready), for one station or all of them. Most
 * first, so the cook batches what the board needs most.
 */
export function allDayCounts(
	tickets: readonly KdsTicket[],
	stationId: string | null,
): AllDayCount[] {
	const counts = new Map<string, AllDayCount>()
	for (const ticket of tickets) {
		if (ticket.cancelled || ticket.completedAt !== null) continue
		for (const line of ticket.lines) {
			if (line.stage === 'ready') continue
			if (stationId && line.stationId !== stationId) continue
			const key = `${line.itemId}|${line.variantId ?? ''}`
			const count = counts.get(key)
			if (count) count.quantity += line.quantity
			else
				counts.set(key, {
					key,
					itemId: line.itemId,
					name: line.name,
					variant: line.variant,
					quantity: line.quantity,
				})
		}
	}
	return [...counts.values()].sort(
		(a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name),
	)
}

/**
 * How long tickets take from firing to cleared, on average, over the last
 * `windowMs` (minutes, rounded). Null with fewer than `minimum` tickets: a
 * figure from two tickets says nothing.
 */
export function averageTicketMinutes(
	tickets: readonly KdsTicket[],
	config: KdsConfig,
	now: number,
	windowMs = 2 * 60 * 60_000,
	minimum = 3,
): number | null {
	const times = tickets
		.filter(
			(ticket) =>
				!ticket.cancelled &&
				ticket.completedAt !== null &&
				ticket.completedAt >= now - windowMs,
		)
		// From the last round's firing: a tab that ordered dessert later is not one long ticket.
		.map(
			(ticket) =>
				ticket.completedAt! -
				Math.max(
					kdsFireAt(ticket, config),
					...ticket.lines.map((line) => line.firedAt ?? 0),
				),
		)
		.filter((ms) => ms >= 0)
	if (times.length < minimum) return null
	return Math.round(
		times.reduce((sum, ms) => sum + ms, 0) / times.length / 60_000,
	)
}
