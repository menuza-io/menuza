import { type PosReservationsTokenResponse } from '@repo/common/pos-orders'
import { type WaitlistEntry } from '@repo/reservations'
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import { createHostApi, HostApiError, type HostApi } from './api.ts'
import type * as DemoNamespace from './demo.ts'
import { type DayFeed } from './feed.ts'
import { staysOnStand } from './waitlist.ts'
import { serverNow } from '~/lib/clock.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

/** The host stand redraws from the server (the day and the waitlist) this often while it is on screen. */
export const DAY_POLL_MS = 10_000

/** Refusals that are about this person or this till, not about the moment: the stand closes. */
const BLOCKING_CODES = new Set([
	'not_a_host',
	'reservations_not_enabled',
	'reservations_disabled',
	'reservations_needs_location',
	'reservations_needs_sign_in',
	'invalid_device',
	'device_revoked',
])

type DemoModule = typeof DemoNamespace
let demoModule: DemoModule | null = null

/**
 * The sample day lives in its own chunk (it is over a thousand lines of sample
 * data), loaded the first time a demo stand opens: a till with a real server
 * never downloads it.
 */
const loadDemo = () =>
	demoModule
		? Promise.resolve(demoModule)
		: import('./demo.ts').then((loaded) => (demoModule = loaded))

/**
 * The demo's api while its code may still be on its way: each call waits for
 * the module, then goes to the one shared sample day. One stable object, with
 * one stable function per call, so it can sit in effect dependencies.
 */
export function lazyDemoApi(): HostApi {
	const calls = new Map<string, unknown>()
	return new Proxy({} as HostApi, {
		get: (_target, name) => {
			if (typeof name !== 'string') return undefined
			// The sample day has nothing to forget (no token).
			if (name === 'forget') return () => {}
			let call = calls.get(name)
			if (!call) {
				call = async (...args: unknown[]) => {
					const loaded = await loadDemo()
					const api = loaded.demoHostApi() as unknown as Record<
						string,
						(...a: unknown[]) => unknown
					>
					return api[name]!(...args)
				}
				calls.set(name, call)
			}
			return call
		},
	})
}

export const blocksStand = (failure: HostApiError) =>
	failure.needsSignIn || BLOCKING_CODES.has(failure.code)

/**
 * What a failed refresh does to the stand. A floor already on screen stays
 * (marked not up to date) through anything passing: an outage, a rate limit, a
 * flag the server could not read. Only a refusal about the person or the till
 * closes it.
 */
export function afterFailedRefresh(
	previous: HostStandState,
	failure: HostApiError,
	/** The day the failed look was for (null is today). */
	askedDate: string | null = null,
): HostStandState {
	if (previous.status === 'ready' && !blocksStand(failure))
		return { ...previous, stale: true, dayFailed: { date: askedDate } }
	return { status: 'blocked', error: failure }
}

/**
 * Whether the day the host asked for is the one that failed to open: its own
 * failure, so an older waitlist failure (`stale`) never reads as "could not
 * open this day" while a day is merely loading.
 */
export const dayFailedFor = (state: HostStandState, date: string | null) =>
	state.status === 'ready' &&
	state.dayFailed !== null &&
	state.dayFailed.date === date

/**
 * The day on screen: today is `null` (it follows the server's date, so the stand
 * left open past midnight is on the new today), any other day is its business
 * date. A date that turns out to be today is today.
 */
export const viewDate = (date: string | null, today: string | null) =>
	date !== null && date === today ? null : date

/** How many days the stand keeps for a quick way back (today and the day on screen are never let go). */
export const HELD_DAYS = 7

/** Where a day is held while the stand is open: one entry per day, with its ETag. */
export const TODAY_KEY = 'today'
export const dayKey = (date: string | null) => date ?? TODAY_KEY

/**
 * Whether an answer may be drawn: it is for the person still signed in, and for
 * the day still on screen (a slow answer for the day before never paints over
 * the day the host just moved to).
 */
export const mayPaint = (
	answer: { generation: number; date: string | null },
	now: { generation: number; date: string | null },
) => answer.generation === now.generation && answer.date === now.date

export type HostStandState =
	| { status: 'loading' }
	| { status: 'blocked'; error: HostApiError }
	| {
			status: 'ready'
			feed: DayFeed
			/** The day `feed` is for: null is today. It lags `date` while another day loads. */
			feedDate: string | null
			/** Today's business date at the location (known once today has loaded). */
			today: string
			waitlist: WaitlistEntry[]
			grant: PosReservationsTokenResponse
			/** The last refresh failed (offline, an outage); what is shown may be stale. */
			stale: boolean
			/** When the book on screen was last read successfully (epoch ms, by the stand's clock). */
			readAt: number
			/** The last look at this day failed: which day it was for (null: none failed). */
			dayFailed: { date: string | null } | null
	  }

/**
 * The stand's days, held apart from React so the date and ETag logic is tested
 * on its own: the day on screen (null is today), each day loaded with its
 * ETag, and the rules for which answer may be drawn. The hook below wraps one
 * store per person, and the screen reads it.
 *
 * - Every refresh takes a number; an answer older than one already shown is
 *   dropped, so a slow poll never paints over a change the host just made.
 * - `generation` changes with the person: answers for the one before are dropped.
 * - `writes` counts changes started: a refresh sent before one may answer after
 *   it with the day as it was, so such an answer is dropped.
 */
export function createDayStore(
	api: HostApi,
	/** The stand's clock, for when the book was last read. */
	clock: () => number = Date.now,
) {
	let state: HostStandState = { status: 'loading' }
	/** The day asked for (null is today): what the arrows move from. */
	let date: string | null = null
	/** The day the screen is drawn for (undefined before the first look). */
	let painted: string | null | undefined = undefined
	/** Each day the stand has loaded, with its ETag, so a poll can ask "unchanged?". */
	const held = new Map<
		string,
		{ feed: DayFeed; etag: string | null; ticket: number }
	>()
	/**
	 * Keeps a day's answer, unless a newer look at that day is already held (a
	 * slow older answer must not put an older day over a newer one, nor its
	 * ETag). The map is kept in the order days were last used and holds a
	 * week of them: the one longest unused goes first, never today and never
	 * the day on screen.
	 */
	const hold = (
		key: string,
		answer: { feed: DayFeed; etag: string | null },
		ticket: number,
	): boolean => {
		const existing = held.get(key)
		if (existing && existing.ticket >= ticket) return false
		held.delete(key)
		held.set(key, { ...answer, ticket })
		for (const candidate of held.keys()) {
			if (held.size <= HELD_DAYS) break
			if (
				candidate === TODAY_KEY ||
				candidate === dayKey(date) ||
				candidate === key
			)
				continue
			held.delete(candidate)
		}
		return true
	}
	/** A held day was just used: it is the last to go. */
	const touch = (key: string) => {
		const entry = held.get(key)
		if (!entry) return
		held.delete(key)
		held.set(key, entry)
	}
	let today: string | null = null
	let issued = 0
	let shown = 0
	let generation = 0
	let writes = 0
	let polling = false
	const listeners = new Set<() => void>()
	const emit = () => listeners.forEach((listener) => listener())
	const update = (next: (previous: HostStandState) => HostStandState) => {
		const changed = next(state)
		if (changed === state) return
		state = changed
		emit()
	}

	const loadWaitlist = async (grant: PosReservationsTokenResponse) => {
		if (!grant.features.waitlist) return []
		const listing = await api.waitlist()
		// In line, or a hold that just ended with no answer (kept to be put back in line).
		return listing.entries.filter((e) => staysOnStand(e, listing.now))
	}

	/** A new person, a lock: their own token, a clean screen, and today. */
	function reset() {
		generation += 1
		api.forget()
		held.clear()
		today = null
		date = null
		painted = undefined
		state = { status: 'loading' }
		emit()
	}

	async function refresh(
		options: { full?: boolean } = {},
	): Promise<DayFeed | null> {
		const ticket = ++issued
		const asked = { generation, date }
		const key = dayKey(asked.date)
		const sentAfterWrites = writes
		const current = () =>
			mayPaint(asked, { generation, date }) &&
			ticket > shown &&
			sentAfterWrites === writes
		const heldNow = () => held.get(key)?.feed ?? null
		try {
			const grant = await api.grant()
			// "Unchanged" only means something against a day the stand still holds.
			const have = held.get(key)
			const askDay = api.day(
				options.full || !have ? undefined : (have.etag ?? undefined),
				asked.date ?? undefined,
			)
			// While another day is on screen, today is still looked at (a 304 when
			// nothing moved): it is how a stand left on tomorrow learns it is now
			// tomorrow, and what the way back to today is drawn from.
			const askToday =
				asked.date !== null
					? api
							.day(held.get(TODAY_KEY)?.etag ?? undefined, undefined)
							.catch(() => null)
					: null
			const [day, todayDay] = await Promise.all([askDay, askToday])
			// The waitlist is today's: another day leaves it as it was.
			const waitlist =
				asked.date === null ? await loadWaitlist(grant).catch(() => null) : null
			// A waitlist that did not load is shown as it was, marked not up to date.
			const waitlistStale =
				asked.date === null && grant.features.waitlist && waitlist === null
			// Whatever the answer, the day stays held for the next look, unless a
			// change started after it was asked for: it may be the day as it was
			// before that change, and holding it (with its ETag) would let going to
			// another day and back draw the floor without the change.
			if (asked.generation === generation && sentAfterWrites === writes) {
				if (!('unchanged' in day)) {
					if (hold(key, day, ticket) && asked.date === null)
						today = day.feed.businessDate
				}
				if (todayDay && !('unchanged' in todayDay)) {
					if (hold(TODAY_KEY, todayDay, ticket))
						today = todayDay.feed.businessDate
				}
				// The day the host is looking at has become today (midnight passed):
				// it is today now, with seating, and follows the server's date.
				if (
					asked.date !== null &&
					asked.date === today &&
					date === asked.date
				) {
					date = null
					emit()
					return await refresh()
				}
			}
			if (!current()) return heldNow() ?? null
			shown = ticket
			const feed = heldNow()
			if (!feed) return null
			painted = asked.date
			update((previous) => ({
				status: 'ready',
				feed,
				feedDate: asked.date,
				today:
					asked.date === null
						? feed.businessDate
						: (today ??
							(previous.status === 'ready'
								? previous.today
								: feed.businessDate)),
				grant,
				waitlist:
					waitlist ?? (previous.status === 'ready' ? previous.waitlist : []),
				stale: waitlistStale,
				readAt: clock(),
				dayFailed: null,
			}))
			return feed
		} catch (error) {
			if (!current()) return heldNow()
			const failure =
				error instanceof HostApiError
					? error
					: new HostApiError(0, 'network_unavailable')
			// A closed stand asks for the whole day when it opens again.
			if (blocksStand(failure)) held.clear()
			update((previous) => afterFailedRefresh(previous, failure, asked.date))
			return heldNow()
		}
	}

	/**
	 * Looks at another day (null is today); the day on screen follows at once if
	 * it is held. Asking again for the day already asked for looks again when the
	 * screen is still on another day (that look failed or is slow): a retry.
	 */
	function setDate(next: string | null) {
		const target = viewDate(next, today)
		const cached = held.get(dayKey(target))
		const paint = () => {
			if (!cached) return
			touch(dayKey(target))
			painted = target
			update((previous) =>
				previous.status === 'ready'
					? { ...previous, feed: cached.feed, feedDate: target }
					: previous,
			)
		}
		if (target === date) {
			if (painted === target) return
			paint()
			void refresh({ full: !cached })
			return
		}
		date = target
		emit()
		paint()
		void refresh({ full: !cached })
	}

	/** A timed look: skipped while the previous one is still out, or the page is hidden. */
	async function poll() {
		if (
			polling ||
			(typeof document !== 'undefined' &&
				document.visibilityState !== 'visible')
		)
			return
		polling = true
		try {
			await refresh()
		} finally {
			polling = false
		}
	}

	/** Starts the timed looks (and one on coming back to the page); returns how to stop. */
	function start(): () => void {
		void refresh()
		const timer = setInterval(() => void poll(), DAY_POLL_MS)
		const onVisible = () => void poll()
		if (typeof document !== 'undefined')
			document.addEventListener('visibilitychange', onVisible)
		return () => {
			clearInterval(timer)
			if (typeof document !== 'undefined')
				document.removeEventListener('visibilitychange', onVisible)
		}
	}

	return {
		getState: () => state,
		getDate: () => date,
		subscribe(listener: () => void) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		/** The state to show when there is no one signed in. */
		block(error: HostApiError) {
			state = { status: 'blocked', error }
			emit()
		},
		/** A change is starting: a refresh already out may answer with the day as it was. */
		noteWrite() {
			writes += 1
		},
		/** The days held, the one longest unused first (for tests). */
		heldDays: () => [...held.keys()],
		reset,
		refresh,
		setDate,
		poll,
		start,
	}
}

export type DayStore = ReturnType<typeof createDayStore>

/**
 * Loads and keeps the day of service fresh: the day feed (with its ETag, so an
 * unchanged day costs a 304), the waitlist when it is on, and a clock for the
 * timers on the floor. The host may look at another day: that day is read and
 * polled the same way (its own ETag), and everything about seating stays on
 * today. It stops while the page is hidden and when the session ends, and
 * starts again on the next sign-in, always on today.
 *
 * In demo mode the day comes from an in-memory sample (`demo.ts`), with no
 * sign-in or network.
 */
export function useHostStand({
	settings,
	session,
	online,
}: {
	settings: PosSettings
	session: Session | null
	online: boolean
}) {
	const settingsRef = useRef(settings)
	settingsRef.current = settings
	const sessionRef = useRef(session)
	sessionRef.current = session
	const demo = settings.demo
	const api: HostApi = useMemo(
		() =>
			demo
				? lazyDemoApi()
				: createHostApi({
						settings: () => settingsRef.current,
						session: () => sessionRef.current,
					}),
		[demo, settingsRef, sessionRef],
	)
	const sessionToken = demo ? 'demo' : (session?.serverSession?.token ?? null)
	// The clock the stand shows times by (the demo's moves it into the afternoon).
	const readClock = useRef<() => number>(() => Date.now())
	const store = useMemo(
		() => createDayStore(api, () => readClock.current()),
		[api],
	)
	const state = useSyncExternalStore(store.subscribe, store.getState)
	const date = useSyncExternalStore(store.subscribe, store.getDate)
	/** The server's time (the demo keeps its own). */
	const clock = useCallback(
		() => (demo ? (demoModule?.demoClock() ?? Date.now()) : serverNow()),
		[demo],
	)
	readClock.current = clock
	const [now, setNow] = useState(clock)
	// The demo's own clock starts once its code is in.
	useEffect(() => {
		if (!demo) return
		let live = true
		void loadDemo().then(() => live && setNow(clock()))
		return () => {
			live = false
		}
	}, [demo, clock])

	// A new person, a lock: their own token, a clean screen, and today; then the
	// timed looks, for as long as someone is signed in.
	useEffect(() => {
		store.reset()
		if (!sessionToken) {
			store.block(new HostApiError(401, 'staff_session_required'))
			return
		}
		return store.start()
	}, [store, sessionToken])

	// Coming back online, look again at once (the first load is the effect above's).
	const wasOnline = useRef(online)
	useEffect(() => {
		const cameBack = online && !wasOnline.current
		wasOnline.current = online
		if (cameBack && sessionToken) void store.refresh()
	}, [online, sessionToken, store, wasOnline])

	// Lateness and waits count in the server's time, like the clock does.
	useEffect(() => {
		const timer = window.setInterval(() => setNow(clock()), 30_000)
		return () => window.clearInterval(timer)
	}, [clock])

	return {
		state,
		api,
		refresh: store.refresh,
		now,
		clock,
		noteWrite: store.noteWrite,
		date,
		setDate: store.setDate,
	}
}
