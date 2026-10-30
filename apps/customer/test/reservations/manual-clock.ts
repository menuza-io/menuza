import { type ReservationsTimers } from '@/lib/reservations/reservations-store'

type Pending = { id: number; at: number; callback: () => void }

/** Lets the async work a resolved promise or timer started run to its next wait. */
export async function flush(rounds = 10): Promise<void> {
	for (let round = 0; round < rounds; round += 1) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
	}
}

/**
 * A device clock and timer queue the test moves by hand, so countdowns and
 * polls run without waiting and without Jest's fake timers (the stub
 * transport and the session still use real promises).
 */
export class ManualClock {
	#nowMs: number
	#nextId = 1
	#pending: Pending[] = []

	constructor(startMs: number) {
		this.#nowMs = startMs
	}

	readonly now = (): number => this.#nowMs

	readonly timers: ReservationsTimers = {
		setTimeout: (callback, ms) => {
			const id = this.#nextId
			this.#nextId += 1
			this.#pending.push({ id, at: this.#nowMs + Math.max(ms, 0), callback })
			return id
		},
		clearTimeout: (handle) => {
			this.#pending = this.#pending.filter((entry) => entry.id !== handle)
		},
	}

	get pendingCount(): number {
		return this.#pending.length
	}

	/** Moves the clock without firing timers (a device that slept). */
	jump(ms: number): void {
		this.#nowMs += ms
	}

	/** Moves the clock, firing every timer that falls due, in order, and letting each callback's work settle. */
	async advance(ms: number): Promise<void> {
		const target = this.#nowMs + ms
		for (;;) {
			const due = this.#pending
				.filter((entry) => entry.at <= target)
				.sort((a, b) => a.at - b.at || a.id - b.id)[0]
			if (!due) break
			this.#pending = this.#pending.filter((entry) => entry.id !== due.id)
			this.#nowMs = Math.max(this.#nowMs, due.at)
			due.callback()
			await flush()
		}
		this.#nowMs = target
		await flush()
	}
}
