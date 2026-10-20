/**
 * Injectable clock. `refresh` loads any persisted offset (the dev API can move
 * time forward) and is awaited at every emulator entry point; `now` is sync.
 */
export type MockClock = {
	now(): number
	refresh(): Promise<void>
	advance(milliseconds: number): Promise<number>
}

export function createSystemClock(): MockClock {
	let offset = 0
	return {
		now: () => Date.now() + offset,
		refresh: async () => {},
		advance: async (milliseconds) => {
			offset += milliseconds
			return offset
		},
	}
}

/** Fixed, manually advanced clock for tests. */
export function createFakeClock(start = Date.UTC(2026, 0, 15, 12, 0, 0)) {
	let current = start
	const clock: MockClock & { set(value: number): void } = {
		now: () => current,
		refresh: async () => {},
		advance: async (milliseconds) => {
			current += milliseconds
			return current
		},
		set: (value) => {
			current = value
		},
	}
	return clock
}
