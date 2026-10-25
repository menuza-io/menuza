import { type MessageDescriptor } from '@lingui/core'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { FINISHED_UNDO_WINDOW_MS, type WaitlistEntry } from '@repo/reservations'
import { Lock, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HostApiError } from './api.ts'
import {
	bookList,
	dayTotals,
	liveServices,
	newArrivals,
	statusMap,
	type BookList,
	type DayTotals,
} from './book.ts'
import { BookPanel } from './BookPanel.tsx'
import {
	DEFAULT_TURN_MIN,
	fits,
	isVip,
	rooms,
	shortName,
	tableState,
	type DayReservation,
	type DayTable,
	type TableState,
} from './feed.ts'
import { Floor, FreeCount, freeTables } from './Floor.tsx'
import { placingSize, type Placing } from './placing.ts'
import {
	BookingSheet,
	ChangePartySheet,
	JoinWaitlistSheet,
	PartySheet,
	TableSheet,
	WaitlistSheet,
	WalkInSheet,
	type BookingPrefill,
	type BookingReadBackInfo,
	type PartyCommand,
} from './sheets.tsx'
import {
	PaneTabs,
	StandHeader,
	type MainView,
	type PaneTab,
} from './StandHeader.tsx'
import { Timeline } from './Timeline.tsx'
import { useHostStand } from './useHostStand.ts'
import { clockLabel } from './zoned.ts'
import './book.css'
import { holdLock } from '~/lib/activity.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'
import { useMediaQuery } from '~/ui/hooks.ts'
import { Toast, type ToastMessage } from '~/ui/motion.tsx'
import { Button, cn, Modal, Reveal, Segmented } from '~/ui/primitives.tsx'

const ROOM_KEY = 'station.hostStand.room'
const VIEW_KEY = 'station.hostStand.view'

function readRoom(): string | null {
	try {
		return localStorage.getItem(ROOM_KEY)
	} catch {
		return null
	}
}

function readView(): MainView {
	try {
		return localStorage.getItem(VIEW_KEY) === 'timeline' ? 'timeline' : 'floor'
	} catch {
		return 'floor'
	}
}

/** A day's book on screen with nothing in it yet. */
const NO_LIST: BookList = {
	toSeat: [],
	seated: [],
	missed: [],
	finished: [],
	waitlist: [],
}
const NO_TOTALS: DayTotals = { parties: 0, covers: 0, toSeat: 0, seated: 0 }

/**
 * The host stand, as a reservation book. A header says what the day holds and
 * which day and service is on screen; a panel beside the main view lists the
 * waitlist, the bookings still to seat, who is seated and who never came; the
 * main view is the floor plan or a timeline of every table. On a phone the
 * panel is a tab. Pick a party up in the panel, tap a table that lifts, and
 * they are seated; a toast says so and offers to undo. Tap a table on its own
 * to see who is there or due, or to seat a walk-in on it. Another day is a
 * book to read and to book into: nothing is seated or marked there.
 *
 * Everything goes browser to region with a short-lived token for the person
 * signed in at the till; nothing about guests is kept on the device.
 */
export function HostStand({
	settings,
	session,
	online,
	onSignIn,
}: {
	settings: PosSettings
	session: Session | null
	online: boolean
	/** Lock the till so someone can sign in (again, online). */
	onSignIn: () => void
}) {
	const { _, i18n } = useLingui()
	const { state, api, refresh, now, clock, noteWrite, date, setDate } =
		useHostStand({
			settings,
			session,
			online,
		})
	const wide = useMediaQuery('(min-width: 700px)')
	const [roomId, setRoomId] = useState<string | null>(readRoom)
	const [view, setView] = useState<MainView>(readView)
	/** A phone shows one pane at a time. */
	const [tab, setTab] = useState<PaneTab>('list')
	const [serviceId, setServiceId] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const [bookingPrefill, setBookingPrefill] = useState<BookingPrefill | null>(
		null,
	)
	const [placing, setPlacing] = useState<Placing | null>(null)
	const [partyId, setPartyId] = useState<string | null>(null)
	/** The booking whose size or time is being changed. */
	const [changeId, setChangeId] = useState<string | null>(null)
	/** The last change got no answer: what it asked for, as it may have landed. */
	const [changeUnsure, setChangeUnsure] = useState<{
		id: string
		partySize: number
		time: string | null
		say: string
	} | null>(null)
	// Times for the change leave out the party's own table and covers.
	const changeSlots = useCallback(
		(date: string, partySize: number) =>
			api.availability(date, partySize, changeId ?? undefined),
		[api, changeId],
	)
	const [waitlistId, setWaitlistId] = useState<string | null>(null)
	/** The table whose sheet is open; its state is read from the live day. */
	const [tableTargetId, setTableTargetId] = useState<string | null>(null)
	const [walkInOpen, setWalkInOpen] = useState(false)
	const [bookingOpen, setBookingOpen] = useState(false)
	/** No answer to the booking: the form is frozen until the server is heard from. */
	const [bookingLocked, setBookingLocked] = useState(false)
	const [readBack, setReadBack] = useState<BookingReadBackInfo | null>(null)
	const [joinOpen, setJoinOpen] = useState(false)
	const [busy, setBusy] = useState(false)
	/** Settles when the change in flight (and its refresh) is done. */
	const settled = useRef<Promise<void>>(Promise.resolve())
	/**
	 * One key per booking or waitlist form: trying again after no answer sends
	 * the same key, so the server records the guest once. A new form, a success
	 * or a definite refusal starts a new one.
	 */
	const bookingKey = useRef(crypto.randomUUID())
	const joinKey = useRef(crypto.randomUUID())
	const keyed = useCallback(
		async (
			ref: { current: string },
			send: (key: string) => Promise<unknown>,
		) => {
			try {
				const result = await send(ref.current)
				ref.current = crypto.randomUUID()
				return result
			} catch (error) {
				// No answer, an answer about the server rather than this request, or
				// the server already has it under this key: keep the key, so the
				// frozen form's next tap is the same request. Only a definite
				// refusal starts a new one.
				const keep =
					error instanceof HostApiError &&
					(error.retryable || error.alreadyDone)
				if (!keep) ref.current = crypto.randomUUID()
				throw error
			}
		},
		[],
	)
	/** A party bigger than the table the host tapped: asked before seating. */
	const [tooSmall, setTooSmall] = useState<{
		placing: Placing
		table: DayTable
	} | null>(null)
	const [toast, setToast] = useState<ToastMessage | null>(null)
	// A booking taken on the phone, a party in hand: a short idle lock waits.
	const working =
		bookingOpen ||
		joinOpen ||
		walkInOpen ||
		changeId !== null ||
		placing !== null ||
		tooSmall !== null
	useEffect(() => {
		if (!working) return
		return holdLock()
	}, [working])
	// Escape puts a picked-up party down (a sheet open on top handles its own).
	useEffect(() => {
		if (!placing) return
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return
			if (document.querySelector('dialog[open]')) return
			setPlacing(null)
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [placing])
	const dismissToast = useCallback(() => setToast(null), [])
	const say = useCallback(
		(text: string, extra: Partial<ToastMessage> = {}) =>
			setToast({ id: Date.now(), text, ...extra }),
		[],
	)
	// A change that got no answer: once the day shows it, it landed. Say so and
	// close, instead of leaving the host with a Save that has nothing to save.
	const changedBooking = changeUnsure
		? state.status === 'ready'
			? state.feed.reservations.find((r) => r.id === changeUnsure.id)
			: undefined
		: undefined
	useEffect(() => {
		if (!changeUnsure || !changedBooking) return
		if (
			changedBooking.partySize === changeUnsure.partySize &&
			(changeUnsure.time === null || changedBooking.time === changeUnsure.time)
		) {
			setChangeId(null)
			setChangeUnsure(null)
			say(changeUnsure.say)
		}
	}, [changeUnsure, changedBooking, say])

	const ready = state.status === 'ready' ? state : null
	const feed = ready?.feed ?? null
	// What is on screen now, for a tap that acts on what the host sees (not what they picked up).
	const readyRef = useRef(ready)
	readyRef.current = ready
	const timeZone = feed?.settings?.timeZone ?? undefined
	const formatTime = useMemo(() => {
		const format = new Intl.DateTimeFormat(i18n.locale, {
			hour: 'numeric',
			minute: '2-digit',
			...(timeZone ? { timeZone } : {}),
		})
		return (epochMs: number) => format.format(epochMs)
	}, [i18n.locale, timeZone])
	const roomList = useMemo(() => (feed ? rooms(feed) : []), [feed])
	const room = roomList.find((r) => r.id === roomId) ?? roomList[0] ?? null
	const isToday = date === null
	/** Another day's feed is still on its way: what is drawn is the day before. */
	const dayLoading = ready !== null && ready.feedDate !== date
	const services = useMemo(() => (feed ? liveServices(feed) : []), [feed])
	// A service the day no longer has is "All day".
	const activeService =
		serviceId && services.some((s) => s.id === serviceId) ? serviceId : null
	const list = useMemo(
		() =>
			feed && ready
				? bookList({
						feed,
						waitlist: ready.waitlist,
						now,
						isToday,
						serviceId: activeService,
						query,
					})
				: NO_LIST,
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `ready` carries the waitlist; its other parts do not change the list
		[feed, ready?.waitlist, now, isToday, activeService, query],
	)
	const totals = useMemo(
		() =>
			feed
				? dayTotals({ feed, now, isToday, serviceId: activeService })
				: NO_TOTALS,
		[feed, now, isToday, activeService],
	)
	// While searching, the timeline lights what the search found and steps the rest back.
	const matchIds = useMemo(
		() =>
			query.trim()
				? new Set(
						[
							...list.toSeat,
							...list.seated,
							...list.missed,
							...list.finished,
						].map((r) => r.id),
					)
				: null,
		[list, query],
	)
	const party = feed?.reservations.find((r) => r.id === partyId) ?? null
	const waitlistEntry =
		ready?.waitlist.find((entry) => entry.id === waitlistId) ?? null

	// A party that turns up at another host's stand is announced here (a toast, and
	// to a screen reader), VIPs by name. What this tablet marked itself says so already.
	const seenStatus = useRef<Map<string, string> | null>(null)
	const selfArrived = useRef(new Set<string>())
	const feedDate = ready?.feedDate
	useEffect(() => {
		if (!feed || feedDate !== null) return
		const arrived = newArrivals(seenStatus.current, feed, selfArrived.current)
		seenStatus.current = statusMap(feed)
		if (arrived.length === 0) return
		const first = arrived[0]!
		const who = shortName(first, _(msg`Guest`))
		const count = arrived.length
		say(
			count > 1
				? _(msg`${count} parties have arrived.`)
				: isVip(first)
					? _(msg`VIP guest has arrived: ${who}.`)
					: _(msg`${who} has arrived.`),
		)
	}, [feed, feedDate, say, _])

	const chooseRoom = (id: string) => {
		setRoomId(id)
		try {
			localStorage.setItem(ROOM_KEY, id)
		} catch {
			/* remembered for this session only */
		}
	}

	/**
	 * Runs a change, says what happened (or what went wrong), and reloads the
	 * day. The floor takes taps again as soon as the change is answered; the
	 * reload runs behind it, and a toast action waits for it.
	 */
	const act = useCallback(
		async (
			work: () => Promise<unknown>,
			/** What to say once it is done (from the server's answer, when it matters). */
			done: string | ((result: unknown) => string),
			options: {
				undo?: () => Promise<unknown>
				/** When the table is booked for part of the party's time: try again as an overbook. */
				anyway?: { table: DayTable; run: () => void }
				/** Put the party back in the host's hand (it was not seated, or may not have been). */
				restore?: () => void
				/**
				 * Runs the moment the change is answered, before the floor reloads:
				 * a sheet closes (or shows its read-back) so a second tap cannot
				 * send it again. Gets the server's answer (null when it was a retry).
				 */
				onSuccess?: (result: unknown) => void
				/** No answer: the form is frozen, so a retry is the same request. */
				onUnsure?: () => void
				/** A definite refusal: the form can be changed again. */
				onRefused?: () => void
			} = {},
		) => {
			const { undo, anyway, restore, onSuccess, onUnsure, onRefused } = options
			setBusy(true)
			noteWrite()
			let finish: () => void = () => {}
			settled.current = new Promise((resolve) => {
				finish = resolve
			})
			let refreshed = false
			try {
				let result: unknown
				try {
					result = await work()
				} finally {
					setBusy(false)
					// A poll that left while the change was in flight may answer with
					// the floor as it was: it is dropped too.
					noteWrite()
				}
				onSuccess?.(result)
				say(
					typeof done === 'function' ? done(result) : done,
					undo
						? {
								action: {
									label: _(msg`Undo`),
									// A tap while the floor is still reloading waits for it, then undoes.
									run: () => {
										void settled.current.then(async () => {
											setBusy(true)
											noteWrite()
											try {
												await undo()
												say(_(msg`Undone.`))
											} catch {
												say(_(msg`Could not undo. Check the floor.`), {
													tone: 'danger',
												})
											} finally {
												setBusy(false)
												noteWrite()
												await refresh({ full: true })
											}
										})
									},
								},
							}
						: {},
				)
				return true
			} catch (error) {
				const failure = error instanceof HostApiError ? error : null
				// The same request already landed (a retry after no answer): done, not a clash.
				if (failure?.alreadyDone) {
					onSuccess?.(null)
					say(
						_(
							msg`That already went through as first sent. Check the floor for what was recorded.`,
						),
					)
					return true
				}
				if (failure?.occupied && anyway) {
					// Look again first: only a table that is still free may be overbooked.
					const fresh = await refresh({ full: true })
					refreshed = true
					const table = fresh?.tables.find((t) => t.id === anyway.table.id)
					const kind =
						table && fresh ? tableState(table, fresh, clock()).kind : null
					const label = anyway.table.label
					// Either way the party stays picked up, ready for a table.
					restore?.()
					if (kind !== 'open' && kind !== 'soon') {
						say(_(msg`Table ${label} was just taken. Choose another table.`), {
							tone: 'danger',
						})
						return false
					}
					say(
						_(
							msg`Someone is booked on that table before this party would be done.`,
						),
						{
							tone: 'danger',
							action: {
								label: _(msg`Seat anyway`),
								run: () => {
									void settled.current.then(anyway.run)
								},
							},
						},
					)
					return false
				}
				// Not seated, or not known to be: the party stays in the host's hand.
				// A form stays as sent when there was no answer (it may have landed).
				if (failure?.offline) {
					restore?.()
					onUnsure?.()
				} else if (!failure?.retryable) onRefused?.()
				say(
					failure?.stale
						? _(msg`Someone changed this a moment ago. Here is the latest.`)
						: failure?.unsure
							? _(
									msg`No answer in time. It may have gone through: check the floor before trying again.`,
								)
							: failure?.offline
								? _(msg`No connection. Nothing was changed.`)
								: _(refusalMessage(failure)),
					{ tone: 'danger' },
				)
				return false
			} finally {
				if (!refreshed) await refresh({ full: true })
				finish()
			}
		},
		[refresh, say, noteWrite, clock, _],
	)

	const seatAt = async (table: DayTable, tableState: TableState) => {
		if (!placing) return
		if (tableState.kind === 'seated' || tableState.kind === 'blocked') {
			say(_(msg`Table ${table.label} is taken. Choose another table.`), {
				tone: 'danger',
			})
			return
		}
		const current = placing
		setPlacing(null)
		// A bigger party than the table seats is the host's call, made on purpose.
		if (!fits(table, placingSize(current))) {
			setTooSmall({ placing: current, table })
			return
		}
		await seat(current, table, false)
	}

	/** Seats a party; when the table is booked soon, the host may insist (overbook). */
	const seat = async (current: Placing, table: DayTable, insist: boolean) => {
		const overbook = insist
			? { overbook: true, overbookReason: _(msg`Seated at the host stand`) }
			: {}
		const again = insist
			? undefined
			: {
					table,
					// Seating anyway puts the party down: nothing stays in hand after.
					run: () => {
						setPlacing(null)
						void seat(current, table, true)
					},
				}
		// Back in hand, unless the host has picked up someone else meanwhile.
		const restore = () => setPlacing((held) => held ?? current)
		const latest = readyRef.current
		if (current.kind === 'reservation') {
			const r = current.reservation
			const who = shortName(r, _(msg`Guest`))
			// The version on screen now: a poll may have moved it since the party was picked up.
			const version =
				latest?.feed.reservations.find((x) => x.id === r.id)?.version ??
				r.version
			await act(
				() =>
					api.transition(r.id, 'seated', {
						tableIds: [table.id],
						expectedVersion: version,
						...overbook,
					}),
				_(msg`Seated ${who} at ${table.label}.`),
				{ undo: () => api.undo(r.id), anyway: again, restore },
			)
		} else if (current.kind === 'waitlist') {
			const entry = current.entry
			const version =
				latest?.waitlist.find((x) => x.id === entry.id)?.version ??
				entry.version
			await act(
				() => api.seatWaitlist(entry.id, [table.id], version, overbook),
				_(msg`Seated ${entry.displayName} at ${table.label}.`),
				{ anyway: again, restore },
			)
		} else {
			const size = current.partySize
			await act(
				() =>
					api.walkIn(
						{
							partySize: size,
							tableIds: [table.id],
							guestName: current.guestName,
							...overbook,
						},
						// Each request keeps its own key for the party: a retry after no
						// answer is the same request, never a second party.
						insist ? current.overbookKey : current.key,
					),
				_(msg`Seated a walk-in of ${size} at ${table.label}.`),
				{ anyway: again, restore },
			)
		}
	}

	/** Picks a party up (or puts it down); on a phone the floor then comes to the front. */
	const pick = (next: Placing | null) => {
		setPlacing(next)
		if (next && !wide) setTab('floor')
	}

	/** A new booking, from the header or from a table and a time on the timeline. */
	const startBooking = (table: DayTable | null, startMin?: number) => {
		if (!feed) return
		bookingKey.current = crypto.randomUUID()
		setBookingLocked(false)
		setReadBack(null)
		setBookingPrefill({
			date: feed.businessDate,
			...(startMin !== undefined ? { time: clockLabel(startMin) } : {}),
			tableIds: table ? [table.id] : [],
			tableLabel: table?.label ?? '',
			maxCovers: table?.maxCovers ?? 0,
		})
		setBookingOpen(true)
	}

	const chooseDate = (next: string | null) => {
		// Seating is today's: nothing stays picked up on another day.
		if (next !== null) setPlacing(null)
		setDate(next)
	}

	const chooseView = (next: MainView) => {
		setView(next)
		try {
			localStorage.setItem(VIEW_KEY, next)
		} catch {
			/* remembered for this session only */
		}
	}

	const onCommand = async (r: DayReservation, command: PartyCommand) => {
		if (command.kind === 'place') {
			setPartyId(null)
			pick({ kind: 'reservation', reservation: r })
			return
		}
		// What this tablet marks itself is not announced again as an arrival.
		if (command.kind === 'status' && command.to === 'arrived')
			selfArrived.current.add(r.id)
		const who = shortName(r, _(msg`Guest`))
		if (command.kind === 'change') {
			setPartyId(null)
			setChangeId(r.id)
			return
		}
		if (command.kind === 'late') {
			const minutes = command.minutes
			await act(
				() => api.runningLate(r.id, minutes, r.version),
				minutes > 0
					? _(msg`${who} is running ${minutes} min late.`)
					: _(msg`${who} is on time.`),
			)
			return
		}
		if (command.kind === 'undo') {
			const wasNoShow = r.status === 'no_show'
			const ok = await act(() => api.undo(r.id), _(msg`Undone for ${who}.`))
			if (ok) {
				setPartyId(null)
				// The guest is here after all, maybe with no table now: pick them up to place.
				if (wasNoShow) pick({ kind: 'reservation', reservation: r })
			}
			return
		}
		const done =
			command.to === 'arrived'
				? _(msg`${who} is here.`)
				: command.to === 'finished'
					? _(msg`${who} finished. Table cleared.`)
					: command.to === 'no_show'
						? _(msg`${who} marked as a no-show.`)
						: command.to === 'cancelled'
							? _(msg`Booking for ${who} cancelled.`)
							: _(msg`Booking for ${who} confirmed.`)
		const reversible = command.to === 'finished' || command.to === 'no_show'
		const ok = await act(
			() =>
				api.transition(r.id, command.to, {
					// An armed confirm carries the version the host decided on.
					expectedVersion: command.expectedVersion ?? r.version,
					...(command.reason ? { reason: command.reason } : {}),
				}),
			done,
			reversible ? { undo: () => api.undo(r.id) } : {},
		)
		if (ok) setPartyId(null)
	}

	// ---------------------------------------------------------------------
	// States before there is a floor to show
	// ---------------------------------------------------------------------

	if (state.status === 'blocked') {
		return (
			<Blocked
				error={state.error}
				online={online}
				onSignIn={onSignIn}
				onRetry={() => void refresh({ full: true })}
			/>
		)
	}
	if (!ready || !feed) {
		return (
			<div className="floor-room flex flex-1 items-center justify-center">
				<p className="t-shimmer text-lg font-medium">
					<Trans>Opening today’s floor…</Trans>
				</p>
			</div>
		)
	}

	const free = room ? freeTables(feed, room.id, now) : { free: 0, total: 0 }
	const targetTable = tableTargetId
		? (feed.tables.find((t) => t.id === tableTargetId) ?? null)
		: null
	const tableTarget = targetTable
		? { table: targetTable, state: tableState(targetTable, feed, now) }
		: null
	// Parties cleared from this table still inside the undo window, while
	// nobody else sits there (a no-show leaves its table, so it waits in the
	// Didn't-arrive lane instead).
	const recentlyCleared =
		targetTable && tableTarget?.state.kind !== 'seated'
			? feed.reservations.filter(
					(r) =>
						r.status === 'finished' &&
						r.canUndo !== false &&
						r.tableIds.includes(targetTable.id) &&
						r.finishedAt != null &&
						now - r.finishedAt <= FINISHED_UNDO_WINDOW_MS,
				)
			: []
	/** Not seating here after all: the party stays picked up for another table. */
	const backToPlacing = () => {
		const pending = tooSmall
		setTooSmall(null)
		if (pending) setPlacing(pending.placing)
	}
	const tooSmallLabel = tooSmall?.table.label ?? ''
	const tooSmallSeats = tooSmall?.table.maxCovers ?? 0
	const tooSmallParty = tooSmall ? placingSize(tooSmall.placing) : 0
	const placingName = placing
		? placing.kind === 'reservation'
			? shortName(placing.reservation, _(msg`Guest`))
			: placing.kind === 'waitlist'
				? placing.entry.displayName
				: placing.guestName.trim() || _(msg`Walk-in`)
		: ''
	const picking = placing
		? {
				partySize: placingSize(placing),
				durationMin:
					placing.kind === 'reservation'
						? placing.reservation.durationMin
						: DEFAULT_TURN_MIN,
				reservationId:
					placing.kind === 'reservation' ? placing.reservation.id : undefined,
			}
		: null
	const onTable = (table: DayTable, state: TableState) => {
		if (busy || !isToday) return
		if (placing) void seatAt(table, state)
		else setTableTargetId(table.id)
	}
	// Another day has no floor to look at (it is how the room is now): the timeline stands in.
	const mainView: MainView = isToday ? view : 'timeline'
	const pane: PaneTab = wide
		? mainView
		: tab === 'floor' && !isToday
			? 'timeline'
			: tab
	const paneOrder: PaneTab[] = wide
		? ['floor', 'timeline']
		: ['list', 'floor', 'timeline']
	const paneProps = (id: PaneTab) =>
		({
			'data-active': pane === id,
			'aria-hidden': pane === id ? undefined : true,
			inert: pane !== id,
			style: {
				'--bk-dir': paneOrder.indexOf(id) < paneOrder.indexOf(pane) ? -1 : 1,
			} as React.CSSProperties,
		}) as const
	const panel = (single: boolean) => (
		<BookPanel
			list={list}
			query={query}
			onQuery={setQuery}
			placing={placing}
			now={now}
			formatTime={formatTime}
			isToday={isToday}
			waitlistOn={ready.grant.features.waitlist}
			single={single}
			onPick={pick}
			onDetails={(r) => setPartyId(r.id)}
			onWaitlistDetails={(entry) => setWaitlistId(entry.id)}
			onAddWaitlist={() => {
				joinKey.current = crypto.randomUUID()
				setJoinOpen(true)
			}}
		/>
	)

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			<StandHeader
				totals={totals}
				filtered={activeService !== null}
				date={feed.businessDate}
				isToday={isToday}
				today={ready.today}
				onDate={chooseDate}
				services={services}
				serviceId={activeService}
				onService={setServiceId}
				wide={wide}
				view={view}
				onView={chooseView}
				waitlistOn={ready.grant.features.waitlist}
				stale={ready.stale}
				onWalkIn={() => setWalkInOpen(true)}
				onWaitlist={() => {
					joinKey.current = crypto.randomUUID()
					setJoinOpen(true)
				}}
				onBooking={() => startBooking(null)}
			/>
			{!wide ? (
				<PaneTabs
					value={pane}
					onChange={setTab}
					floorOn={isToday}
					listCount={list.toSeat.length + list.waitlist.length}
				/>
			) : null}

			<p role="status" className="sr-only">
				{placing
					? _(msg`Picked up ${placingName}. Tap a table to seat them.`)
					: ''}
			</p>
			<Reveal open={placing !== null}>
				<div className="bg-primary text-primary-foreground flex items-center gap-3 px-4 py-2.5">
					<p className="min-w-0 flex-1 font-semibold">
						<Trans>
							Tap a table for {placingName}, party of{' '}
							{placing ? placingSize(placing) : 0}
						</Trans>
					</p>
					<Button
						variant="ghost"
						onClick={() => setPlacing(null)}
						className="text-primary-foreground hover:bg-primary-foreground/15"
					>
						<X className="size-4" />
						<Trans>Cancel</Trans>
					</Button>
				</div>
			</Reveal>

			{feed.dayState !== 'open' ? (
				<p className="bg-warning/12 text-warning px-4 py-2 text-sm font-medium">
					{feed.closedLabel ?? (
						<Trans>Closed today. Walk-ins can still be seated.</Trans>
					)}
				</p>
			) : null}

			<div className="bk-shell relative">
				{wide ? panel(false) : null}
				<div className="bk-pages">
					{!wide ? (
						<div className="bk-page" {...paneProps('list')}>
							{panel(true)}
						</div>
					) : null}
					<div className="bk-page" {...paneProps('floor')}>
						{room ? (
							<>
								<div className="border-border bg-card flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5">
									{roomList.length > 1 ? (
										<Segmented
											label={_(msg`Room`)}
											value={room.id}
											onChange={chooseRoom}
											options={roomList.map((r) => ({
												value: r.id,
												label: r.name,
											}))}
											wrap={false}
										/>
									) : (
										<h2 className="text-lg font-semibold">{room.name}</h2>
									)}
									<FreeCount free={free.free} total={free.total} />
									<ul
										aria-label={_(msg`Table colours`)}
										className="text-muted-foreground ms-auto flex items-center gap-3 text-xs font-medium max-xl:hidden"
									>
										<li className="flex items-center gap-1.5">
											<span className="bk-dot" data-kind="open" />
											<Trans>Open</Trans>
										</li>
										<li className="flex items-center gap-1.5">
											<span className="bk-dot" data-kind="soon" />
											<Trans>Due soon</Trans>
										</li>
										<li className="flex items-center gap-1.5">
											<span className="bk-dot" data-kind="seated" />
											<Trans>Seated</Trans>
										</li>
										<li className="flex items-center gap-1.5">
											<span className="bk-dot" data-kind="blocked" />
											<Trans>Blocked</Trans>
										</li>
									</ul>
								</div>
								<Floor
									area={room}
									feed={feed}
									now={now}
									picking={picking}
									formatTime={formatTime}
									onTable={onTable}
								/>
							</>
						) : (
							<div className="floor-room flex flex-1 items-center justify-center p-6 text-center">
								<p className="text-muted-foreground max-w-sm">
									<Trans>
										No tables yet. A manager adds the floor plan in the app,
										under Reservations, Setup.
									</Trans>
								</p>
							</div>
						)}
					</div>
					<div className="bk-page" {...paneProps('timeline')}>
						<Timeline
							feed={feed}
							now={now}
							isToday={isToday}
							bookable={feed.businessDate >= ready.today}
							serviceId={activeService}
							matchIds={matchIds}
							picking={picking}
							active={pane === 'timeline'}
							formatTime={formatTime}
							onBar={(r) => setPartyId(r.id)}
							onTable={onTable}
							onEmpty={(table, minute) => startBooking(table, minute)}
						/>
					</div>
				</div>
				{dayLoading ? (
					<div
						role="status"
						className="bg-background/70 absolute inset-0 z-20 flex items-center justify-center"
					>
						<p className="t-shimmer text-lg font-medium">
							{ready.stale ? (
								<Trans>Could not open this day. Try the arrows again.</Trans>
							) : (
								<Trans>Opening the book…</Trans>
							)}
						</p>
					</div>
				) : null}
			</div>

			<PartySheet
				reservation={party}
				viewOnly={!isToday}
				canReadGuest={ready.grant.canReadGuest}
				busy={busy}
				now={now}
				formatTime={formatTime}
				onCommand={(r, command) => void onCommand(r, command)}
				onClose={() => setPartyId(null)}
			/>
			<WaitlistSheet
				entry={waitlistEntry}
				canReadGuest={ready.grant.canReadGuest}
				busy={busy}
				now={now}
				onClose={() => setWaitlistId(null)}
				onPlace={(entry: WaitlistEntry) => {
					setWaitlistId(null)
					pick({ kind: 'waitlist', entry })
				}}
				onNotify={(entry) =>
					void act(
						() => api.notifyWaitlist(entry.id, entry.version),
						_(msg`${entry.displayName} has been texted.`),
					)
				}
				onRemove={(entry) =>
					void act(
						() => api.leaveWaitlist(entry.id, entry.version),
						_(msg`${entry.displayName} left the waitlist.`),
					).then((ok) => ok && setWaitlistId(null))
				}
			/>
			<TableSheet
				target={tableTarget}
				recent={recentlyCleared}
				busy={busy}
				now={now}
				formatTime={formatTime}
				onClose={() => setTableTargetId(null)}
				onDetails={(r) => {
					setTableTargetId(null)
					setPartyId(r.id)
				}}
				onFinish={(r) => {
					setTableTargetId(null)
					void onCommand(r, { kind: 'status', to: 'finished' })
				}}
				onWalkIn={(table, size) => {
					setTableTargetId(null)
					const walkIn: Placing = {
						kind: 'walk_in',
						partySize: size,
						guestName: '',
						key: crypto.randomUUID(),
						overbookKey: crypto.randomUUID(),
					}
					if (!fits(table, size)) setTooSmall({ placing: walkIn, table })
					else void seat(walkIn, table, false)
				}}
			/>
			<ChangePartySheet
				reservation={feed.reservations.find((r) => r.id === changeId) ?? null}
				busy={busy}
				date={feed.businessDate}
				loadSlots={changeSlots}
				formatTime={formatTime}
				onClose={() => {
					setChangeId(null)
					setChangeUnsure(null)
				}}
				onSave={(change) => {
					const r = feed.reservations.find((x) => x.id === changeId)
					if (!r) return
					const who = shortName(r, _(msg`Guest`))
					const size = change.partySize ?? r.partySize
					const time = change.timeLabel ?? formatTime(r.startAt)
					const done = _(msg`${who} is now ${size} at ${time}.`)
					void act(
						() =>
							api.changeParty(
								r.id,
								{
									...(change.partySize ? { partySize: change.partySize } : {}),
									...(change.time ? { time: change.time } : {}),
								},
								r.version,
							),
						done,
						{
							onSuccess: () => {
								setChangeId(null)
								setChangeUnsure(null)
							},
							onUnsure: () =>
								setChangeUnsure({
									id: r.id,
									partySize: size,
									time: change.time ?? null,
									say: done,
								}),
						},
					)
				}}
			/>
			<WalkInSheet
				open={walkInOpen}
				onClose={() => setWalkInOpen(false)}
				onPlace={(partySize, guestName) => {
					setWalkInOpen(false)
					pick({
						kind: 'walk_in',
						partySize,
						guestName,
						key: crypto.randomUUID(),
						overbookKey: crypto.randomUUID(),
					})
				}}
			/>
			<BookingSheet
				open={bookingOpen}
				busy={busy}
				locked={bookingLocked}
				readBack={readBack}
				today={ready.today}
				prefill={bookingPrefill}
				loadSlots={api.availability}
				onClose={() => setBookingOpen(false)}
				onBook={(input) => {
					const first = input.firstName
					const size = input.partySize
					const time = input.timeLabel
					// Another day is said out loud: it is what the caller will hear read back.
					const day =
						input.date === ready.today
							? null
							: new Intl.DateTimeFormat(i18n.locale, {
									weekday: 'short',
									month: 'short',
									day: 'numeric',
									timeZone: 'UTC',
								}).format(new Date(`${input.date}T12:00:00Z`))
					void act(
						() => keyed(bookingKey, (key) => api.book(input, key)),
						day
							? _(msg`Booked ${first} for ${size} on ${day} at ${time}.`)
							: _(msg`Booked ${first} for ${size} at ${time}.`),
						{
							// The sheet turns into the read-back at once: nothing to tap twice.
							onSuccess: (result) => {
								setBookingLocked(false)
								// A retry the server already had: it recorded the first
								// request, which may differ from the form now.
								if (result === null) {
									setReadBack({
										name: '',
										partySize: 0,
										when: '',
										code: null,
										asFirstSent: true,
									})
									return
								}
								setReadBack({
									name: [first, input.lastName].join(' ').trim(),
									partySize: size,
									when: day
										? _(msg`${day} at ${time}`)
										: _(msg`Today at ${time}`),
									code: confirmationCodeOf(result),
								})
							},
							onUnsure: () => setBookingLocked(true),
							onRefused: () => setBookingLocked(false),
						},
					)
				}}
			/>
			<JoinWaitlistSheet
				open={joinOpen}
				busy={busy}
				loadQuote={api.waitlistQuote}
				onClose={() => setJoinOpen(false)}
				onJoin={(input) =>
					void act(
						() => keyed(joinKey, (key) => api.joinWaitlist(input, key)),
						(entry) => {
							const name = input.displayName
							const quoted = (entry as { quotedMin?: number | null } | null)
								?.quotedMin
							return typeof quoted === 'number'
								? _(msg`${name} is on the waitlist, about ${quoted} min.`)
								: _(msg`${name} is on the waitlist.`)
						},
						{ onSuccess: () => setJoinOpen(false) },
					)
				}
			/>
			<Modal
				open={tooSmall !== null}
				onClose={backToPlacing}
				title={_(msg`Table ${tooSmallLabel} is small for them`)}
				footer={
					<div className="mb-safe grid grid-cols-2 gap-3">
						<Button size="lg" onClick={backToPlacing}>
							<Trans>Choose another</Trans>
						</Button>
						<Button
							variant="primary"
							size="lg"
							disabled={busy}
							onClick={() => {
								const pending = tooSmall
								setTooSmall(null)
								if (pending) void seat(pending.placing, pending.table, false)
							}}
						>
							<Trans>Seat them here</Trans>
						</Button>
					</div>
				}
			>
				<p className="text-muted-foreground p-5">
					<Trans>
						Table {tooSmallLabel} seats {tooSmallSeats}. This party is{' '}
						{tooSmallParty}.
					</Trans>
				</p>
			</Modal>
			<Toast message={toast} onDone={dismissToast} />
		</div>
	)
}

/** What a refusal means, in the host's language (the server's own text is English). */
function refusalMessage(failure: HostApiError | null): MessageDescriptor {
	switch (failure?.code) {
		case 'manager_required':
			return msg`This booking has a payment on it. A manager handles it in the app.`
		case 'guest_permission_required':
			return msg`That needs guest details, which this sign-in does not have.`
		case 'not_for_station':
		case 'undo_not_allowed':
			return msg`That is done in the app, not at a till.`
		case 'not_a_host':
			return msg`You are not on this terminal’s host list.`
		case 'no_availability':
		case 'slot_unavailable':
			return msg`That time is no longer available. Choose another.`
		case 'invalid_status_transition':
		// A till seats today's bookings, and calls a no-show once its time has passed.
		case 'not_today':
		case 'too_early':
		// An undo too late, or onto a table someone else now has: not worth a retry.
		case 'table_occupied':
		case 'undo_window_expired':
		case 'cannot_undo':
			return msg`That cannot be done to this booking now. Here is the latest.`
		case 'closed_day':
			return msg`The restaurant is closed that day.`
		default:
			return msg`That did not go through. Try again.`
	}
}

/** The code a booking's answer carries, to read back to the caller. */
function confirmationCodeOf(result: unknown): string | null {
	const reservation = (
		result as { reservation?: { confirmationCode?: unknown } }
	)?.reservation
	return typeof reservation?.confirmationCode === 'string' &&
		reservation.confirmationCode
		? reservation.confirmationCode
		: null
}

/** Why the host stand cannot open, and the one thing that fixes it. */
function Blocked({
	error,
	online,
	onSignIn,
	onRetry,
}: {
	error: HostApiError
	online: boolean
	onSignIn: () => void
	onRetry: () => void
}) {
	let title: React.ReactNode
	let body: React.ReactNode
	let action: React.ReactNode = null
	if (error.needsSignIn) {
		title = <Trans>Sign in to open reservations</Trans>
		body = (
			<Trans>
				Guests’ bookings open for the person signed in at this terminal, and
				only after an online sign-in.
			</Trans>
		)
		action = (
			<Button variant="primary" size="lg" onClick={onSignIn}>
				<Lock className="size-5" />
				<Trans>Sign in</Trans>
			</Button>
		)
	} else if (error.offline || !online) {
		title = <Trans>Reservations need a connection</Trans>
		body = (
			<Trans>
				The till keeps selling offline; bookings open again when the connection
				is back.
			</Trans>
		)
		action = (
			<Button size="lg" onClick={onRetry}>
				<RefreshCw className="size-5" />
				<Trans>Try again</Trans>
			</Button>
		)
	} else if (error.code === 'not_a_host') {
		title = <Trans>You are not on this terminal’s host list</Trans>
		body = (
			<Trans>
				A manager adds hosts in the app, under Settings, Terminals. Someone on
				the list can sign in here instead.
			</Trans>
		)
		action = (
			<Button variant="primary" size="lg" onClick={onSignIn}>
				<Lock className="size-5" />
				<Trans>Switch user</Trans>
			</Button>
		)
	} else if (
		[
			'reservations_not_enabled',
			'reservations_disabled',
			'reservations_needs_location',
			'reservations_needs_sign_in',
		].includes(error.code)
	) {
		title = <Trans>Reservations are off on this terminal</Trans>
		body = (
			<Trans>
				A manager turns them on in the app, under Settings, Terminals. The
				terminal needs a location and staff sign-in.
			</Trans>
		)
	} else {
		title = <Trans>Today’s bookings could not be loaded</Trans>
		body = <Trans>Try again in a moment.</Trans>
		action = (
			<Button size="lg" onClick={onRetry}>
				<RefreshCw className="size-5" />
				<Trans>Try again</Trans>
			</Button>
		)
	}
	return (
		<div className="floor-room flex flex-1 items-center justify-center p-6">
			<div className="bg-card border-border elevated-card flex max-w-md flex-col items-center gap-4 rounded-3xl border p-8 text-center">
				<h2 className="text-2xl font-bold">{title}</h2>
				<p className={cn('text-muted-foreground')}>{body}</p>
				{action}
			</div>
		</div>
	)
}
