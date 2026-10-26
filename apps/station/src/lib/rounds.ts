import { type CartLine } from './pricing.ts'

/** One trip to the kitchen: the lines one save sent, or (no time) what is not sent yet. */
export type Round = { sentAt: number | null; lines: CartLine[] }

/**
 * An order's lines in the order they went to the kitchen. Each save is one
 * round (its lines share the save's time); lines not sent yet come last.
 */
export function roundsOf(lines: readonly CartLine[]): Round[] {
	const sent = new Map<number, CartLine[]>()
	const pending: CartLine[] = []
	for (const line of lines) {
		if (!line.sentAt) {
			pending.push(line)
			continue
		}
		const round = sent.get(line.sentAt)
		if (round) round.push(line)
		else sent.set(line.sentAt, [line])
	}
	const rounds: Round[] = [...sent.entries()]
		.sort(([a], [b]) => a - b)
		.map(([sentAt, roundLines]) => ({ sentAt, lines: roundLines }))
	if (pending.length > 0) rounds.push({ sentAt: null, lines: pending })
	return rounds
}

/** How many items (quantities, not lines) are not sent yet. */
export const unsentCount = (lines: readonly CartLine[]): number =>
	lines.reduce((sum, line) => sum + (line.sentAt ? 0 : line.quantity), 0)

/** When the last dish of a round was marked served, once every one of them is. */
export function servedOf(lines: readonly CartLine[]): number | null {
	return lines.length > 0 && lines.every((line) => line.servedAt)
		? Math.max(...lines.map((line) => line.servedAt!))
		: null
}
