import { describe, expect, it, vi } from 'vitest'
import { HostApiError, type HostApi } from './api.ts'
import { connectionOf } from './connection.ts'
import { dayFeedSchema } from './feed.ts'
import dayFeed from './fixtures/day-feed.json'
import {
	afterFailedRefresh,
	createDayStore,
	DAY_POLL_MS,
	dayFailedFor,
	dayKey,
	HELD_DAYS,
	mayPaint,
	TODAY_KEY,
	viewDate,
	type HostStandState,
} from './useHostStand.ts'

const grant = {
	token: 't'.repeat(30),
	expiresAt: 0,
	locationId: 'loc',
	canReadGuest: false,
	features: { waitlist: true, online: true },
}

const ready: HostStandState = {
	status: 'ready',
	feed: dayFeedSchema.parse(dayFeed),
	feedDate: null,
	today: '2026-01-16',
	waitlist: [],
	grant,
	stale: false,
	readAt: 0,
	dayFailed: null,
}

describe('a failed refresh', () => {
	it('keeps the floor through anything passing, marked not up to date', () => {
		for (const failure of [
			new HostApiError(0, 'network_unavailable'),
			new HostApiError(503, 'service_unavailable'),
			new HostApiError(429, 'rate_limit_exceeded'),
			new HostApiError(403, 'forbidden'),
		]) {
			expect(afterFailedRefresh(ready, failure)).toMatchObject({
				status: 'ready',
				stale: true,
			})
		}
	})

	it('closes the stand for a refusal about the person or the till', () => {
		for (const code of [
			'staff_session_invalid',
			'not_a_host',
			'reservations_disabled',
			'device_revoked',
		]) {
			expect(
				afterFailedRefresh(ready, new HostApiError(403, code)),
			).toMatchObject({ status: 'blocked' })
		}
	})

	it('with no floor yet, says what went wrong', () => {
		expect(
			afterFailedRefresh(
				{ status: 'loading' },
				new HostApiError(0, 'network_unavailable'),
			),
		).toMatchObject({ status: 'blocked' })
	})
})

describe('looking at another day', () => {
	it('keeps today as null, so it follows the server past midnight', () => {
		expect(viewDate(null, '2026-01-16')).toBeNull()
		expect(viewDate('2026-01-16', '2026-01-16')).toBeNull()
		expect(viewDate('2026-01-17', '2026-01-16')).toBe('2026-01-17')
		// Before today is known, a date stays a date.
		expect(viewDate('2026-01-17', null)).toBe('2026-01-17')
	})

	it('holds each day under its own key (and its own ETag)', () => {
		expect(dayKey(null)).toBe(TODAY_KEY)
		expect(dayKey('2026-01-17')).toBe('2026-01-17')
		expect(dayKey('2026-01-17')).not.toBe(dayKey(null))
	})

	it('draws an answer only for the person and the day still on screen', () => {
		const now = { generation: 3, date: '2026-01-17' as string | null }
		expect(mayPaint({ generation: 3, date: '2026-01-17' }, now)).toBe(true)
		// A slow poll for today, after the host moved to tomorrow.
		expect(mayPaint({ generation: 3, date: null }, now)).toBe(false)
		// An answer for the person before (the till was locked meanwhile).
		expect(mayPaint({ generation: 2, date: '2026-01-17' }, now)).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// The store: dates, ETags and the timed looks (no React, a fake api, fake timers)
// ---------------------------------------------------------------------------

type DayAnswer =
	| { unchanged: true }
	| { feed: ReturnType<typeof dayFeedSchema.parse>; etag: string | null }

/** A feed for a business date, with a version in its ETag. */
const feedFor = (businessDate: string) =>
	dayFeedSchema.parse({ ...dayFeed, businessDate })

/** What the store asks of the api, scripted per test. */
function fakeApi(
	options: {
		today?: () => string
		fail?: (date: string | undefined) => boolean
		waitlistFails?: () => boolean
	} = {},
) {
	const calls: Array<{ etag: string | undefined; date: string | undefined }> =
		[]
	const known = new Map<string, string>()
	const api = {
		forget: vi.fn(),
		grant: vi.fn(async () => grant),
		waitlist: vi.fn(async () => {
			if (options.waitlistFails?.()) throw new HostApiError(0, 'network')
			return { entries: [] }
		}),
		day: vi.fn(async (etag: string | undefined, date: string | undefined) => {
			calls.push({ etag, date })
			if (options.fail?.(date)) throw new HostApiError(0, 'network')
			const businessDate = date ?? options.today?.() ?? '2026-01-16'
			const tag = `"v1-${businessDate}"`
			if (etag && etag === tag) return { unchanged: true } as DayAnswer
			known.set(businessDate, tag)
			return { feed: feedFor(businessDate), etag: tag } as DayAnswer
		}),
	}
	return { api: api as unknown as HostApi, calls, raw: api }
}

/** What the store has drawn: the day on screen, or null before there is one. */
const drawn = (store: ReturnType<typeof createDayStore>) => {
	const state = store.getState()
	return state.status === 'ready' ? state : null
}

/**
 * An api whose look at today waits until the test answers it, so answers can
 * come in any order; a look at another day answers at once.
 */
function gatedApi() {
	const waiting: Array<{
		etag: string | undefined
		answer: (value: DayAnswer) => void
		fail: (error: unknown) => void
	}> = []
	const raw = {
		forget: vi.fn(),
		grant: vi.fn(async () => grant),
		waitlist: vi.fn(async () => ({ entries: [] })),
		day: vi.fn((etag: string | undefined, date: string | undefined) => {
			if (date !== undefined)
				return Promise.resolve({
					feed: feedFor(date),
					etag: `"v1-${date}"`,
				} as DayAnswer)
			return new Promise<DayAnswer>((answer, fail) =>
				waiting.push({ etag, answer, fail }),
			)
		}),
	}
	return { api: raw as unknown as HostApi, waiting, raw }
}

/** Today's feed as a given look saw it (told apart by its etag field). */
const lookAt = (version: string) => ({
	feed: dayFeedSchema.parse({ ...dayFeed, etag: version }),
	etag: `"${version}"`,
})

describe('the day store', () => {
	it('asks "unchanged?" with the ETag it holds, and keeps the feed on a 304', async () => {
		const { api, calls } = fakeApi()
		const store = createDayStore(api)
		await store.refresh()
		const first = store.getState()
		expect(first).toMatchObject({ status: 'ready', feedDate: null })
		await store.refresh()
		expect(calls[1]!.etag).toBe('"v1-2026-01-16"')
		// Unchanged: the same day, still drawn.
		const second = store.getState()
		expect(second.status === 'ready' && second.feed).toBe(
			first.status === 'ready' && first.feed,
		)
		// A full look asks for the whole day.
		await store.refresh({ full: true })
		expect(calls[2]!.etag).toBeUndefined()
	})

	it('moves one day per tap however quickly, then draws the last day asked for', async () => {
		const { api } = fakeApi()
		const store = createDayStore(api)
		await store.refresh()
		store.setDate('2026-01-17')
		expect(store.getDate()).toBe('2026-01-17')
		store.setDate('2026-01-18')
		store.setDate('2026-01-19')
		expect(store.getDate()).toBe('2026-01-19')
		await vi.waitFor(() => expect(drawn(store)?.feedDate).toBe('2026-01-19'))
		expect(drawn(store)?.feed.businessDate).toBe('2026-01-19')
	})

	it('looks again when the day asked for is not the one on screen (a retry)', async () => {
		let down = true
		const { api, raw } = fakeApi({ fail: (date) => down && date !== undefined })
		const store = createDayStore(api)
		await store.refresh()
		store.setDate('2026-01-17')
		await vi.waitFor(() =>
			expect(dayFailedFor(store.getState(), '2026-01-17')).toBe(true),
		)
		// Offline: the day before stays on screen, and this day's own look failed.
		let state = store.getState()
		expect(state.status === 'ready' && state.feedDate).toBeNull()
		expect(dayFailedFor(state, '2026-01-17')).toBe(true)
		expect(dayFailedFor(state, null)).toBe(false)
		const askedBefore = raw.day.mock.calls.length
		// Asking again for the same day is a retry, not a no-op.
		down = false
		store.setDate('2026-01-17')
		await vi.waitFor(() => expect(drawn(store)?.feedDate).toBe('2026-01-17'))
		expect(raw.day.mock.calls.length).toBeGreaterThan(askedBefore)
		state = store.getState()
		expect(state.status === 'ready' && state.feedDate).toBe('2026-01-17')
		expect(dayFailedFor(state, '2026-01-17')).toBe(false)
	})

	it('does not read a waitlist that failed to load as a day that failed to open', async () => {
		let waitlistDown = false
		const { api } = fakeApi({ waitlistFails: () => waitlistDown })
		const store = createDayStore(api)
		await store.refresh()
		waitlistDown = true
		await store.refresh()
		const stale = store.getState()
		expect(stale).toMatchObject({
			status: 'ready',
			stale: true,
			dayFailed: null,
		})
		// Now a day is merely loading: nothing says it failed.
		store.setDate('2026-01-17')
		const loading = store.getState()
		expect(dayFailedFor(loading, '2026-01-17')).toBe(false)
	})

	it('draws a slow answer for the day before only if it is still the day asked for', async () => {
		const { api, raw } = fakeApi()
		const store = createDayStore(api)
		await store.refresh()
		store.setDate('2026-01-17')
		store.setDate(null)
		// Let the look at the day just left come in: it is not drawn.
		await vi.waitFor(() => expect(raw.day.mock.calls.length).toBeGreaterThan(2))
		await vi.waitFor(() => expect(store.heldDays()).toContain('2026-01-17'))
		const state = store.getState()
		expect(state.status === 'ready' && state.feedDate).toBeNull()
		expect(store.getDate()).toBeNull()
	})

	it('reads a day that turns out to be today as today', async () => {
		const { api } = fakeApi()
		const store = createDayStore(api)
		await store.refresh()
		store.setDate('2026-01-16')
		expect(store.getDate()).toBeNull()
	})

	it('leaves another day for today when midnight passes while it is on screen', async () => {
		let today = '2026-01-16'
		const { api } = fakeApi({ today: () => today })
		const store = createDayStore(api)
		await store.refresh()
		store.setDate('2026-01-17')
		await vi.waitFor(() => expect(drawn(store)?.feedDate).toBe('2026-01-17'))
		let state = store.getState()
		expect(state.status === 'ready' && state.today).toBe('2026-01-16')
		// The clock passes midnight at the location: tomorrow is today now.
		today = '2026-01-17'
		await store.refresh()
		await vi.waitFor(() => expect(store.getDate()).toBeNull())
		await vi.waitFor(() => expect(drawn(store)?.feedDate).toBeNull())
		state = store.getState()
		expect(state).toMatchObject({
			status: 'ready',
			feedDate: null,
			today: '2026-01-17',
		})
		expect(state.status === 'ready' && state.feed.businessDate).toBe(
			'2026-01-17',
		)
	})

	it('keeps today current while another day is on screen', async () => {
		let today = '2026-01-16'
		const { api } = fakeApi({ today: () => today })
		const store = createDayStore(api)
		await store.refresh()
		store.setDate('2026-01-20')
		await vi.waitFor(() => expect(drawn(store)?.feedDate).toBe('2026-01-20'))
		today = '2026-01-17'
		await store.refresh()
		const state = store.getState()
		expect(state.status === 'ready' && state.today).toBe('2026-01-17')
		expect(state.status === 'ready' && state.feedDate).toBe('2026-01-20')
	})

	it('polls on a timer with the ETag it holds, and not while the page is hidden', async () => {
		vi.useFakeTimers()
		const visibility = { value: 'visible' }
		vi.stubGlobal('document', {
			get visibilityState() {
				return visibility.value
			},
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})
		try {
			const { api, calls } = fakeApi()
			const store = createDayStore(api)
			const stop = store.start()
			await vi.waitFor(() => expect(drawn(store)).not.toBeNull())
			expect(calls).toHaveLength(1)
			await vi.advanceTimersByTimeAsync(DAY_POLL_MS)
			expect(calls).toHaveLength(2)
			expect(calls[1]!.etag).toBe('"v1-2026-01-16"')
			visibility.value = 'hidden'
			await vi.advanceTimersByTimeAsync(DAY_POLL_MS * 3)
			expect(calls).toHaveLength(2)
			visibility.value = 'visible'
			await vi.advanceTimersByTimeAsync(DAY_POLL_MS)
			expect(calls).toHaveLength(3)
			stop()
			await vi.advanceTimersByTimeAsync(DAY_POLL_MS * 3)
			expect(calls).toHaveLength(3)
		} finally {
			vi.useRealTimers()
			vi.unstubAllGlobals()
		}
	})

	it('drops what a refresh sent before a change answers after it', async () => {
		const { api } = fakeApi()
		const store = createDayStore(api)
		await store.refresh()
		const before = store.getState()
		const slow = store.refresh({ full: true })
		store.noteWrite()
		await slow
		expect(store.getState()).toBe(before)
	})

	it('does not hold today as a look sent before a change saw it', async () => {
		const { api, waiting } = gatedApi()
		const store = createDayStore(api)
		const first = store.refresh()
		await vi.waitFor(() => expect(waiting).toHaveLength(1))
		waiting[0]!.answer(lookAt('first'))
		await first
		const slow = store.refresh()
		await vi.waitFor(() => expect(waiting).toHaveLength(2))
		store.noteWrite()
		waiting[1]!.answer(lookAt('before-change'))
		await slow
		expect(drawn(store)?.feed.etag).toBe('first')
		// The next look asks with what was held before, never with the dropped answer's ETag,
		// and going to another day and back draws no floor from before the change.
		store.setDate('2026-01-17')
		store.setDate(null)
		expect(drawn(store)?.feed.etag).toBe('first')
		const asked = waiting.length
		const next = store.refresh()
		await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(asked))
		expect(waiting.at(-1)!.etag).toBe('"first"')
		for (const look of waiting.slice(2)) look.answer({ unchanged: true })
		await next
	})

	it('blocks writes after a failed look at today (today is null on both sides)', async () => {
		let down = false
		const { api } = fakeApi({ fail: () => down })
		const store = createDayStore(api)
		await store.refresh()
		down = true
		await store.refresh()
		const state = store.getState()
		expect(state).toMatchObject({ stale: true, dayFailed: { date: null } })
		expect(connectionOf(true, state, store.getDate())).toMatchObject({
			kind: 'stale',
			blocksWrites: true,
		})
	})

	it('starts clean for a new person', async () => {
		const { api, raw } = fakeApi()
		const store = createDayStore(api)
		await store.refresh()
		store.setDate('2026-01-17')
		store.reset()
		expect(raw.forget).toHaveBeenCalled()
		expect(store.getState()).toEqual({ status: 'loading' })
		expect(store.getDate()).toBeNull()
	})

	it('keeps the newest look at a day when an older, slower answer comes in after it', async () => {
		const { api, waiting } = gatedApi()
		const store = createDayStore(api)
		const older = store.refresh()
		const newer = store.refresh({ full: true })
		await vi.waitFor(() => expect(waiting).toHaveLength(2))
		waiting[1]!.answer(lookAt('newer'))
		await newer
		expect(drawn(store)?.feed.etag).toBe('newer')
		waiting[0]!.answer(lookAt('older'))
		await older
		// Not drawn, and not held: going to another day and back draws the newer one.
		expect(drawn(store)?.feed.etag).toBe('newer')
		store.setDate('2026-01-17')
		store.setDate(null)
		expect(drawn(store)?.feed.etag).toBe('newer')
		// And its ETag is the one the next look asks with.
		const asked = waiting.length
		const next = store.refresh()
		await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(asked))
		expect(waiting.at(-1)!.etag).toBe('"newer"')
		waiting.at(-1)!.answer({ unchanged: true })
		await next
	})

	it('holds a week of days, never today or the day on screen', async () => {
		const { api } = fakeApi()
		const store = createDayStore(api)
		await store.refresh()
		for (let day = 17; day <= 28; day += 1) {
			const date = `2026-01-${day}`
			store.setDate(date)
			await vi.waitFor(() => expect(drawn(store)?.feedDate).toBe(date))
			expect(store.heldDays().length).toBeLessThanOrEqual(HELD_DAYS)
			expect(store.heldDays()).toContain(TODAY_KEY)
			expect(store.heldDays()).toContain(date)
		}
		// The longest unused went first.
		expect(store.heldDays()).not.toContain('2026-01-17')
		expect(store.heldDays()).toContain('2026-01-28')
		// A day used again outlives the ones after it.
		store.setDate('2026-01-24')
		await vi.waitFor(() => expect(drawn(store)?.feedDate).toBe('2026-01-24'))
		store.setDate('2026-01-29')
		await vi.waitFor(() => expect(drawn(store)?.feedDate).toBe('2026-01-29'))
		store.setDate('2026-01-30')
		await vi.waitFor(() => expect(drawn(store)?.feedDate).toBe('2026-01-30'))
		expect(store.heldDays()).toContain('2026-01-24')
	})

	it('drops an answer that comes in after the person changed', async () => {
		const { api, waiting, raw } = gatedApi()
		const store = createDayStore(api)
		const inFlight = store.refresh()
		await vi.waitFor(() => expect(waiting).toHaveLength(1))
		store.reset()
		expect(raw.forget).toHaveBeenCalled()
		waiting[0]!.answer(lookAt('before'))
		await inFlight
		// Still the clean screen of the new person, and nothing of the old one held.
		expect(store.getState()).toEqual({ status: 'loading' })
		expect(store.heldDays()).toEqual([])
		// The new person's own look draws.
		const own = store.refresh()
		await vi.waitFor(() => expect(waiting).toHaveLength(2))
		expect(waiting[1]!.etag).toBeUndefined()
		waiting[1]!.answer(lookAt('own'))
		await own
		expect(drawn(store)?.feed.etag).toBe('own')
	})

	it('looks again when the page comes back, once, and stops listening when it stops', async () => {
		vi.useFakeTimers()
		const visibility = { value: 'visible' }
		const listeners = new Map<string, () => void>()
		vi.stubGlobal('document', {
			get visibilityState() {
				return visibility.value
			},
			addEventListener: vi.fn((name: string, fn: () => void) =>
				listeners.set(name, fn),
			),
			removeEventListener: vi.fn((name: string, fn: () => void) => {
				if (listeners.get(name) === fn) listeners.delete(name)
			}),
		})
		try {
			const { api, calls } = fakeApi()
			const store = createDayStore(api)
			const stop = store.start()
			await vi.waitFor(() => expect(calls).toHaveLength(1))
			const onVisible = listeners.get('visibilitychange')!
			expect(onVisible).toBeTypeOf('function')
			// Hidden: the change of visibility asks nothing.
			visibility.value = 'hidden'
			onVisible()
			await vi.advanceTimersByTimeAsync(0)
			expect(calls).toHaveLength(1)
			// Back on screen: one look at once, asking with the ETag held.
			visibility.value = 'visible'
			onVisible()
			await vi.waitFor(() => expect(calls).toHaveLength(2))
			expect(calls[1]!.etag).toBe('"v1-2026-01-16"')
			stop()
			expect(listeners.has('visibilitychange')).toBe(false)
		} finally {
			vi.useRealTimers()
			vi.unstubAllGlobals()
		}
	})

	it('does not start a second look while one is still out', async () => {
		const { api, waiting } = gatedApi()
		const store = createDayStore(api)
		const first = store.poll()
		await vi.waitFor(() => expect(waiting).toHaveLength(1))
		await store.poll()
		expect(waiting).toHaveLength(1)
		waiting[0]!.answer(lookAt('a'))
		await first
		const second = store.poll()
		await vi.waitFor(() => expect(waiting).toHaveLength(2))
		waiting[1]!.answer({ unchanged: true })
		await second
	})
})
