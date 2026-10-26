import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { FINISHED_UNDO_WINDOW_MS, type WaitlistEntry } from '@repo/reservations'
import { Icon } from '@repo/ui/icon'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	JoinWaitlistSheet,
	WalkInSheet,
	type WaitlistPrefill,
} from './AddSheets.tsx'
import { HostApiError, type LeaveTarget } from './api.ts'
import { earlyArrival } from './arrival.ts'
import {
	bookList,
	createSelfMarks,
	dayNotices,
	daySnapshot,
	dayTotals,
	liveServices,
	newArrivals,
	snapshotToCompare,
	type BookList,
	type DayTotals,
	type SeenDay,
} from './book.ts'
import { bookingAnswerOf } from './bookingAnswer.ts'
import {
	BookingSheet,
	type BookingPrefill,
	type BookingReadBackInfo,
} from './BookingSheet.tsx'
import { BookPanel } from './BookPanel.tsx'
import {
	comboFor,
	fitsByRoom,
	groupVerdict,
	joinVerdict,
	MAX_COMBINED_TABLES,
	noFitOf,
} from './combine.ts'
import { connectionOf } from './connection.ts'
import { useDrawerFocus } from './drawer.ts'
import {
	fits,
	fitVerdict,
	rooms,
	shortName,
	tableState,
	UNDO_WINDOW_MS,
	type DayReservation,
	type DayTable,
	type TableKind,
	type TableState,
} from './feed.ts'
import { Floor, FreeCount, freeTables } from './Floor.tsx'
import {
	FREE_OFFER_MS,
	newlyFree,
	pickOffer,
	tableKinds,
	type FreeTableOffer,
} from './freeTable.ts'
import { FreeTableBanner, offerText } from './FreeTableBanner.tsx'
import { formatPhone } from './guest.ts'
import { keyed } from './keyed.ts'
import { formatCount, noTablesText } from './labels.ts'
import { hourPressure } from './listView.ts'
import {
	displayNameOf,
	findLateGuests,
	findRepeat,
	guestFromQuery,
	type LateGuest,
	type Repeat,
} from './lookup.ts'
import { liveTags, newsOf } from './news.ts'
import { OfflineStrip } from './OfflineStrip.tsx'
import { PartySheet } from './PartySheet.tsx'
import { locationCountryCode } from './phone.ts'
import { NoFitBanner, PickBar } from './PickBar.tsx'
import {
	partyToPlace,
	placingKey,
	placingSize,
	reservationPlacing,
	type Placing,
} from './placing.ts'
import {
	refusalMessage,
	wantsAnotherTable,
	type RefusalContext,
} from './refusals.ts'
import {
	floorSections,
	sectionByTable,
	sectionLoads,
	upNext,
} from './sections.ts'
import { SectionsSheet } from './SectionsSheet.tsx'
import { SectionStrip } from './SectionStrip.tsx'
import { ChangePartySheet, type PartyCommand } from './sheets.tsx'
import { slotReason as reasonOfSlot } from './slotReasons.ts'
import {
	PaneTabs,
	StandDock,
	StandHeader,
	TableLegend,
	ViewTabs,
	type MainView,
	type PaneTab,
} from './StandHeader.tsx'
import { EXTEND_STEP_MIN, extendPlan } from './stay.ts'
import { TableSheet } from './TableSheet.tsx'
import { Timeline, type TimelineRefusal } from './Timeline.tsx'
import { dayFailedFor, useHostStand } from './useHostStand.ts'
import {
	holdEndOf,
	notifiedToast,
	QUOTE_SIZES,
	removedToast,
	textQueuedOf,
	waitlistSummary,
} from './waitlist.ts'
import { WaitlistSheet } from './WaitlistSheet.tsx'
import { zonedEpoch, zonedMinutes } from './zoned.ts'
import './book.css'
import { holdLock } from '~/lib/activity.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'
import { usePos } from '~/lib/store.ts'
import { useMediaQuery } from '~/ui/hooks.ts'
import { Toast, type ToastMessage } from '~/ui/motion.tsx'
import { Button, cn, Modal, Reveal, Segmented } from '~/ui/primitives.tsx'

const ROOM_KEY = 'station.hostStand.room'
const VIEW_KEY = 'station.hostStand.view'
const SECTIONS_KEY = 'station.hostStand.sections'

/** Whether the floor shows server sections (on until the host hides them). */
function readSectionsShown(): boolean {
	try {
		return localStorage.getItem(SECTIONS_KEY) !== 'hidden'
	} catch {
		return true
	}
}

function readRoom(): string | null {
	try {
		return localStorage.getItem(ROOM_KEY)
	} catch {
		return null
	}
}

function readView(): MainView {
	try {
		const saved = localStorage.getItem(VIEW_KEY)
		return saved === 'timeline' || saved === 'list' ? saved : 'floor'
	} catch {
		return 'floor'
	}
}

/** A day's book on screen with nothing in it yet. */
const NO_LIST: BookList = {
	toSeat: [],
	awaiting: [],
	seated: [],
	missed: [],
	finished: [],
	waitlist: [],
	noResponse: [],
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
	renderHeader = (controls) => controls,
}: {
	/** App chrome surrounds both the ready book and its loading/blocked states. */
	renderHeader?: (controls?: React.ReactNode) => React.ReactNode
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
	// A narrow tablet (an iPad upright): the list folds into a rail, so the floor keeps its room.
	const roomy = useMediaQuery('(min-width: 900px)')
	const rail = wide && !roomy
	const [railOpen, setRailOpen] = useState(false)
	// Focus goes into the drawer once when it opens, and back to its button when it closes.
	const railButton = useRef<HTMLButtonElement>(null)
	const drawerRef = useDrawerFocus<HTMLDivElement>(railOpen, railButton)
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
	/**
	 * Joining tables for the party in hand: the tables chosen so far, in the
	 * order they were tapped (null: a tap seats them at that one table).
	 */
	const [joining, setJoining] = useState<string[] | null>(null)
	/** Nothing seats the party in hand: the host chose to seat them at a table too small, anyway. */
	const [forceSmall, setForceSmall] = useState(false)
	/** What a party this size would be quoted on the waitlist now (for the "no table fits" offer). */
	const [noFitQuote, setNoFitQuote] = useState<number | null>(null)
	const dockRef = useRef<HTMLElement>(null)
	/** The tables of a joined seating that failed: chosen again when the party is back in hand. */
	const keepJoined = useRef<string[] | null>(null)
	const [partyId, setPartyId] = useState<string | null>(null)
	/** The booking whose size or time is being changed. */
	const [changeId, setChangeId] = useState<string | null>(null)
	/** The last change got no answer: what it asked for, as it may have landed. */
	const [changeUnsure, setChangeUnsure] = useState<{
		id: string
		partySize: number
		/** The new time as minutes after the day's midnight (null: not changed). */
		localStartMin: number | null
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
	/** A name or number a search found no one for, carried onto the waitlist form. */
	const [joinPrefill, setJoinPrefill] = useState<WaitlistPrefill | null>(null)
	/** Bookings that came in online while the host was looking, until their details are opened. */
	const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set())
	/** What the last updates changed, each with when: a "New" or "Changed" tag for a minute. */
	const [tagged, setTagged] = useState<
		ReadonlyMap<string, { tag: 'new' | 'changed'; at: number }>
	>(new Map())
	/** The list shows only what the last update changed (the host tapped its toast). */
	const [onlyIds, setOnlyIds] = useState<ReadonlySet<string> | null>(null)
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
	/** A party bigger than the table the host tapped: asked before seating. */
	const [tooSmall, setTooSmall] = useState<{
		placing: Placing
		table: DayTable
	} | null>(null)
	/** A table still being reset, tapped for a party: asked before seating. */
	const [resetAsk, setResetAsk] = useState<{
		placing: Placing
		table: DayTable
		readyAt: number
	} | null>(null)
	/**
	 * What "tell them it's ready" answered about a text, per waitlist entry:
	 * true only when one was queued. Kept for this tablet's session; a party
	 * told elsewhere has no answer here.
	 */
	const [textedBy, setTextedBy] = useState<ReadonlyMap<string, boolean>>(
		new Map(),
	)
	/** Tables that freed up while the host was looking, and the offers already put away. */
	const [freed, setFreed] = useState<ReadonlyMap<string, number>>(new Map())
	const [dismissedOffers, setDismissedOffers] = useState<ReadonlySet<string>>(
		new Set(),
	)
	const [toast, setToast] = useState<ToastMessage | null>(null)
	const toastRef = useRef<ToastMessage | null>(null)
	toastRef.current = toast
	/** Arrival toasts that came while a toast with a button was up: shown after it goes. */
	const queued = useRef<ToastMessage[]>([])
	const toastId = useRef(0)
	/**
	 * What a change at the stand says to a screen reader at once, whatever toast
	 * is showing. A new `seq` re-announces the same words (a region whose text
	 * did not change is not read again).
	 */
	const [news, setNews] = useState<{ seq: number; text: string }>({
		seq: 0,
		text: '',
	})
	// A booking taken on the phone, a party in hand: a short idle lock waits.
	const working =
		bookingOpen ||
		joinOpen ||
		walkInOpen ||
		changeId !== null ||
		placing !== null ||
		tooSmall !== null ||
		resetAsk !== null
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
	// Another party in hand (or none) starts over: no tables joined, no "anyway".
	const placingId = placingKey(placing)
	useEffect(() => {
		// A joined seating that was not made puts the party back in hand with its tables still chosen.
		setJoining(keepJoined.current)
		keepJoined.current = null
		setForceSmall(false)
	}, [placingId])
	// A toast goes; the next one waiting (an arrival) takes its place.
	const dismissToast = useCallback(
		() => setToast(queued.current.shift() ?? null),
		[],
	)
	const say = useCallback((text: string, extra: Partial<ToastMessage> = {}) => {
		// A newer message replaces what shows, and what waits was about older news.
		queued.current = []
		toastId.current += 1
		setToast({ id: toastId.current, text, ...extra })
	}, [])
	/**
	 * A change at the stand (a party arriving, a booking made online or
	 * cancelled): told in a live region of its own at once, and shown as a toast
	 * that never replaces one with a button on it (an Undo, a Seat anyway). It
	 * waits behind that one instead.
	 */
	const sayNews = useCallback(
		(
			text: string,
			spoken: string,
			extra: Partial<Pick<ToastMessage, 'tone' | 'action'>> = {},
		) => {
			setNews((previous) => ({ seq: previous.seq + 1, text: spoken }))
			toastId.current += 1
			const message: ToastMessage = {
				id: toastId.current,
				text,
				silent: true,
				...extra,
			}
			if (toastRef.current?.action) queued.current.push(message)
			else setToast(message)
		},
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
			(changeUnsure.localStartMin === null ||
				changedBooking.localStartMin === changeUnsure.localStartMin)
		) {
			setChangeId(null)
			setChangeUnsure(null)
			say(changeUnsure.say)
		}
	}, [changeUnsure, changedBooking, say])

	// Opening someone else's details (or a table, or a form) sets aside a toast
	// about a party: its Undo is for the party it was about, not for this sheet.
	const sheetKey = [
		partyId,
		tableTargetId,
		waitlistId,
		changeId,
		walkInOpen,
		bookingOpen,
		joinOpen,
	].join('|')
	useEffect(() => {
		const about = toastRef.current?.subject
		if (!about) return
		const opened =
			partyId !== null ||
			tableTargetId !== null ||
			waitlistId !== null ||
			changeId !== null ||
			walkInOpen ||
			bookingOpen ||
			joinOpen
		if (opened && partyId !== about) dismissToast()
		// eslint-disable-next-line react-hooks/exhaustive-deps -- runs when a sheet opens or changes, not when the toast does
	}, [sheetKey])

	const ready = state.status === 'ready' ? state : null
	// What a walk-in party would be quoted on the waitlist, to say it if no table seats them.
	const quoteFor =
		placing?.kind === 'walk_in' && ready?.grant.features.waitlist === true
			? placing.partySize
			: null
	useEffect(() => {
		setNoFitQuote(null)
		if (quoteFor === null) return
		let live = true
		api.waitlistQuote(quoteFor).then(
			(answer) => live && setNoFitQuote(answer.quotedMin),
			() => undefined,
		)
		return () => {
			live = false
		}
	}, [quoteFor, api])
	const feed = ready?.feed ?? null
	// Whether the book can be trusted, and whether a change can be sent: offline, or after a failed look,
	// seating, booking and texts wait for the connection (said on each control, not after each tap).
	const connection = connectionOf(online, state, date)
	const offlineReason =
		connection.kind !== 'ok' && connection.blocksWrites
			? _(msg`Offline: this waits for the connection.`)
			: null
	const offlineRef = useRef(offlineReason)
	offlineRef.current = offlineReason
	const locationName = usePos((pos) => pos.location?.name ?? null)
	// What is on screen now, for a tap that acts on what the host sees (not what they picked up).
	const readyRef = useRef(ready)
	readyRef.current = ready
	const timeZone = feed?.settings?.timeZone ?? undefined
	// "7:30 PM", and "7:30" for a table or a bar with no room for the rest. A
	// zone name the runtime does not know (the server's, not ours) must not
	// throw while drawing: times then show in this tablet's own zone.
	const { formatTime, formatShort, formatDay } = useMemo(() => {
		const make = (zone: string | undefined) =>
			new Intl.DateTimeFormat(i18n.locale, {
				hour: 'numeric',
				minute: '2-digit',
				...(zone ? { timeZone: zone } : {}),
			})
		const makeDay = (zone: string | undefined) =>
			new Intl.DateTimeFormat(i18n.locale, {
				month: 'short',
				day: 'numeric',
				...(zone ? { timeZone: zone } : {}),
			})
		let format: Intl.DateTimeFormat
		let dayFormat: Intl.DateTimeFormat
		try {
			format = make(timeZone)
			dayFormat = makeDay(timeZone)
		} catch {
			format = make(undefined)
			dayFormat = makeDay(undefined)
		}
		return {
			formatTime: (epochMs: number) => format.format(epochMs),
			/** "Oct 3": a day in the restaurant's own zone. */
			formatDay: (epochMs: number) => dayFormat.format(epochMs),
			formatShort: (epochMs: number) =>
				format
					.formatToParts(epochMs)
					.filter((part) => part.type !== 'dayPeriod')
					.map((part) => part.value)
					.join('')
					.trim(),
		}
	}, [i18n.locale, timeZone])
	const roomList = useMemo(() => (feed ? rooms(feed) : []), [feed])
	const room = roomList.find((r) => r.id === roomId) ?? roomList[0] ?? null
	const isToday = date === null
	/** Another day's feed is still on its way: what is drawn is the day before. */
	const dayLoading = ready !== null && ready.feedDate !== date
	/** That day's own look failed (not a waitlist that did not load): the way is to try it again. */
	const dayFailed = dayLoading && dayFailedFor(state, date)
	const services = useMemo(() => (feed ? liveServices(feed) : []), [feed])
	// A service the day no longer has is "All day".
	const activeService =
		serviceId && services.some((s) => s.id === serviceId) ? serviceId : null
	// Server sections: those of the service chosen, else (today) of the one seating now.
	const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
	const minuteNow = isToday ? zonedMinutes(now, zone) : null
	const sectionService =
		services.find((s) => s.id === activeService) ??
		(minuteNow === null
			? null
			: (services.find(
					// Half an hour before the first seating, servers are already set.
					(s) => minuteNow >= s.firstSeatingMin - 30 && minuteNow < s.endMin,
				) ?? null))
	const sections = useMemo(
		() =>
			feed && sectionService ? floorSections(feed, sectionService.id) : [],
		[feed, sectionService],
	)
	const tableSections = useMemo(() => sectionByTable(sections), [sections])
	const loads = useMemo(
		() => (feed && isToday ? sectionLoads(sections, feed, now) : []),
		[sections, feed, isToday, now],
	)
	const upNextId = useMemo(() => upNext(loads), [loads])
	// The rotation: of two tables of one size, the one in the section whose turn it is.
	const rotation = useCallback(
		(tableId: string) => (tableSections.get(tableId)?.id === upNextId ? 0 : 1),
		[tableSections, upNextId],
	)
	const [sectionsShown, setSectionsShown] = useState(readSectionsShown)
	const toggleSections = () => {
		const next = !sectionsShown
		setSectionsShown(next)
		try {
			localStorage.setItem(SECTIONS_KEY, next ? 'shown' : 'hidden')
		} catch {
			/* remembered for this session only */
		}
	}
	const [assigning, setAssigning] = useState(false)
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
	// What each party size would be quoted on the waitlist now (the panel's quote strip):
	// asked again when the line changes, and every two minutes while it stands still.
	const [quotes, setQuotes] = useState<ReadonlyMap<number, number | null>>(
		() => new Map(),
	)
	const quoteKey =
		ready && ready.grant.features.waitlist && isToday && online
			? `${ready.waitlist.map((entry) => `${entry.id}:${entry.status}`).join(',')}|${Math.floor(now / 120_000)}`
			: null
	useEffect(() => {
		if (quoteKey === null) return
		let live = true
		void Promise.allSettled(
			QUOTE_SIZES.map((size) => api.waitlistQuote(size)),
		).then((answers) => {
			if (!live) return
			const next = new Map<number, number | null>()
			answers.forEach((answer, index) => {
				if (answer.status === 'fulfilled')
					next.set(QUOTE_SIZES[index]!, answer.value.quotedMin)
			})
			if (next.size > 0) setQuotes(next)
		})
		return () => {
			live = false
		}
	}, [quoteKey, api])
	// Hours with a slot near its cap, and the "New"/"Changed" tags still on their minute.
	const pressure = useMemo(
		() => (feed ? hourPressure(feed, activeService) : undefined),
		[feed, activeService],
	)
	const tags = useMemo(() => liveTags(tagged, now), [tagged, now])
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
							...list.awaiting,
							...list.seated,
							...list.missed,
							...list.finished,
						].map((r) => r.id),
					)
				: null,
		[list, query],
	)
	const party = feed?.reservations.find((r) => r.id === partyId) ?? null
	const changing = feed?.reservations.find((r) => r.id === changeId) ?? null
	const waitlistEntry =
		ready?.waitlist.find((entry) => entry.id === waitlistId) ?? null

	// What changed since the last look is said quietly: a party that turns up at
	// another host's stand (VIPs by name), a booking made online or cancelled, a
	// party size changed. What this tablet did itself says so already. Only today
	// is watched, and the first look at a day (or a new day) says nothing.
	const seen = useRef<SeenDay | null>(null)
	/** Parties this tablet marked here, and changes it made to a booking: not news to it. */
	const selfArrived = useRef(createSelfMarks())
	const selfChanged = useRef(createSelfMarks())
	const feedDate = ready?.feedDate
	useEffect(() => {
		if (!feed || feedDate !== null) {
			// Another day, or none yet: coming back to today is a first look again.
			seen.current = null
			return
		}
		const at = clock()
		// A look long ago (a tablet that slept) is no basis for news: nothing is announced.
		const before = snapshotToCompare(seen.current, feed.businessDate, at)
		seen.current = {
			date: feed.businessDate,
			snapshot: daySnapshot(feed),
			at,
		}
		const arrivals = newArrivals(before, feed, selfArrived.current.live(at))
		const notices = dayNotices(before, feed, {
			now: at,
			byUs: selfChanged.current.live(at),
		})
		// What the day has now shown is no longer the stand's to hide from the next look.
		selfArrived.current.settle(before, feed)
		selfChanged.current.settle(before, feed)
		const news = newsOf(_, {
			arrivals,
			notices,
			formatTime,
			locale: i18n.locale,
		})
		if (news.toast === null) return
		const changedIds = news.ids
		sayNews(news.toast, news.items.join(' '), {
			...(news.highlight ? { tone: 'highlight' as const } : {}),
			// A summary can be tapped: the list then shows only what changed.
			...(news.summary
				? {
						action: {
							label: _(msg`Show`),
							run: () => {
								setOnlyIds(new Set(changedIds))
								setTab('list')
								setRailOpen(true)
							},
						},
					}
				: {}),
		})
		// A booking made or resized is tagged for a minute.
		if (news.tags.size > 0)
			setTagged((previous) => {
				const next = new Map(previous)
				for (const [id, tag] of news.tags) next.set(id, { tag, at })
				return next
			})
		// A booking a guest made is marked until the host opens it.
		const made = notices
			.filter((notice) => notice.kind === 'online')
			.map((notice) => notice.reservation.id)
		if (made.length > 0)
			setFreshIds((previous) => new Set([...previous, ...made]))
	}, [ready, feed, feedDate, sayNews, clock, formatTime, _, i18n.locale])
	// Opening a booking's details clears its dot.
	useEffect(() => {
		if (partyId === null) return
		setFreshIds((previous) => {
			if (!previous.has(partyId)) return previous
			const next = new Set(previous)
			next.delete(partyId)
			return next
		})
	}, [partyId])

	// A table that frees up (a party cleared, or its reset over) is offered to
	// whoever has waited longest and fits. Only what happens while the host is
	// looking counts: the first look at a day offers nothing.
	const kindsSeen = useRef<{
		date: string
		kinds: Map<string, TableKind>
	} | null>(null)
	useEffect(() => {
		if (!feed || feedDate !== null) {
			kindsSeen.current = null
			return
		}
		const at = clock()
		const kinds = tableKinds(feed, at)
		const before =
			kindsSeen.current?.date === feed.businessDate
				? kindsSeen.current.kinds
				: null
		kindsSeen.current = { date: feed.businessDate, kinds }
		const ids = newlyFree(before, kinds)
		if (ids.length === 0) return
		setFreed((previous) => {
			const next = new Map(previous)
			for (const id of ids) next.set(id, at)
			return next
		})
	}, [ready, feed, feedDate, now, clock])
	const offer: FreeTableOffer | null = useMemo(() => {
		if (!feed || !ready || feedDate !== null || placing !== null) return null
		const recent = [...freed]
			.filter(([, at]) => now - at <= FREE_OFFER_MS)
			.sort((a, b) => b[1] - a[1])
			.map(([id]) => id)
		if (recent.length === 0) return null
		return pickOffer({
			freed: recent,
			feed,
			waitlist: ready.waitlist,
			now,
			dismissed: dismissedOffers,
		})
	}, [feed, ready, feedDate, placing, freed, now, dismissedOffers])

	// A table offered to a party: said at once to a screen reader (the bar mounts filled, so it is no live region itself).
	const offerKey = offer?.key ?? null
	useEffect(() => {
		if (!offer) return
		const text = offerText(_, offer)
		setNews((previous) => ({ seq: previous.seq + 1, text }))
		// eslint-disable-next-line react-hooks/exhaustive-deps -- once per offer (its key), not on every look at the day
	}, [offerKey])

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
	 * day. The answer is said (and a sheet closes) at once, but the floor and
	 * the sheets take the next change only once the reload is in: until then
	 * what is on screen carries the versions from before this change, and a
	 * quick second tap on the same party would be refused as stale. A toast
	 * action waits for the reload too.
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
				/** The booking the toast is about, so another's details set it aside. */
				subject?: string
				/** What the host was doing, for the refusals that mean different things in each. */
				context?: RefusalContext
			} = {},
		) => {
			const {
				undo,
				anyway,
				restore,
				onSuccess,
				onUnsure,
				onRefused,
				subject,
				context,
			} = options
			// Offline: nothing is sent. The controls say so already; this catches any tap that got past them.
			if (offlineRef.current) {
				say(offlineRef.current, { tone: 'danger' })
				restore?.()
				return false
			}
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
					// A poll that left while the change was in flight may answer with
					// the floor as it was: it is dropped too.
					noteWrite()
				}
				onSuccess?.(result)
				say(
					typeof done === 'function' ? done(result) : done,
					undo
						? {
								...(subject ? { subject } : {}),
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
												noteWrite()
												try {
													await refresh({ full: true })
												} finally {
													setBusy(false)
												}
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
					// A table still being reset can be overbooked too: it is not "taken".
					if (kind !== 'open' && kind !== 'soon' && kind !== 'resetting') {
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
				} else if (!failure?.retryable) {
					// A table that cannot take them: they stay in hand for another one.
					if (wantsAnotherTable(failure)) restore?.()
					onRefused?.()
				}
				say(
					failure?.stale
						? _(msg`Someone changed this a moment ago. Here is the latest.`)
						: failure?.unsure
							? _(
									msg`No answer in time. It may have gone through: check the floor before trying again.`,
								)
							: failure?.offline
								? _(msg`No connection. Nothing was changed.`)
								: _(refusalMessage(failure, context)),
					{ tone: 'danger' },
				)
				return false
			} finally {
				try {
					if (!refreshed) await refresh({ full: true })
				} finally {
					// The day on screen now has this change's versions: the next tap may go.
					setBusy(false)
					finish()
				}
			}
		},
		[refresh, say, noteWrite, clock, _],
	)

	/** What a table is doing now, as the day stands (for a tap that acts on what is on screen). */
	const stateOf = (table: DayTable): TableState => {
		const latest = readyRef.current
		return latest
			? tableState(table, latest.feed, clock())
			: { kind: 'open', next: null }
	}

	/**
	 * Takes a party to a table the host chose, asking first where it matters: a
	 * table still being reset (it can be seated anyway), and a party bigger than
	 * the table seats (the host's call, made on purpose). `reset` skips the
	 * first question once it has been answered.
	 */
	const proceed = (
		current: Placing,
		table: DayTable,
		state: TableState,
		reset = false,
	) => {
		if (state.kind === 'resetting' && !reset && current.kind !== 'assign') {
			setResetAsk({ placing: current, table, readyAt: state.readyAt })
			return
		}
		if (!fits(table, placingSize(current))) {
			setTooSmall({ placing: current, table })
			return
		}
		void seat(current, [table], false)
	}

	const seatAt = async (table: DayTable, tableState: TableState) => {
		if (!placing) return
		// Joining tables: a tap adds the table to the group (or takes it out).
		if (joining !== null) {
			toggleJoined(table, tableState)
			return
		}
		// Picked up to be moved: the table they are at is not a place to move them to.
		if (
			(placing.kind === 'move' || placing.kind === 'assign') &&
			placing.reservation.tableIds.includes(table.id)
		) {
			say(_(msg`They are at Table ${table.label} already. Choose another.`))
			return
		}
		// A booking given a table for its own time may go where someone sits now (the window says).
		if (
			(tableState.kind === 'seated' || tableState.kind === 'blocked') &&
			placing.kind !== 'assign'
		) {
			say(_(msg`Table ${table.label} is taken. Choose another table.`), {
				tone: 'danger',
			})
			return
		}
		// A table taped off from a time inside their stay is not one the server seats
		// them at (`table_blocked`): said here, with no "Seat anyway" for it.
		const latest = readyRef.current
		if (latest) {
			const verdict = fitVerdict(
				table,
				tableState,
				partyToPlace(placing, clock()),
				clock(),
				latest.feed,
			)
			if (!verdict.fits && verdict.why === 'blocked') {
				const label = table.label
				const from = formatTime(verdict.at)
				say(
					_(
						msg`Table ${label} is blocked from ${from}, during their stay. Choose another table.`,
					),
					{ tone: 'danger' },
				)
				return
			}
		}
		const current = placing
		setPlacing(null)
		proceed(current, table, tableState)
	}

	/**
	 * Seats a party at one table or several joined; when a table is booked
	 * soon, the host may insist (overbook). Several tables are one seating: the
	 * server gets all of them, and the combination when they are one.
	 */
	const seat = async (
		current: Placing,
		tables: DayTable[],
		insist: boolean,
	) => {
		const overbook = insist
			? { overbook: true, overbookReason: _(msg`Seated at the host stand`) }
			: {}
		const again = insist
			? undefined
			: {
					table: tables[0]!,
					// Seating anyway puts the party down: nothing stays in hand after.
					run: () => {
						setPlacing(null)
						void seat(current, tables, true)
					},
				}
		// Back in hand, unless the host has picked up someone else meanwhile.
		const latest = readyRef.current
		const ids = tables.map((t) => t.id)
		const restore = () => {
			if (ids.length > 1) keepJoined.current = ids
			setPlacing((held) => held ?? current)
		}
		const where = tables.map((t) => t.label).join(' + ')
		const comboId = latest ? comboFor(latest.feed, ids)?.id : undefined
		if (current.kind === 'reservation') {
			const r = current.reservation
			const who = shortName(r, _(msg`Guest`))
			// The version on screen now: a poll may have moved it since the party was picked up.
			const fresh = latest?.feed.reservations.find((x) => x.id === r.id) ?? r
			const covers = current.covers ?? r.partySize
			const size = r.partySize
			const partial = covers < size
			await act(
				() =>
					// One call, tables and count together: the server seats them where it is
					// told, and records how many sat (it has no partial statuses for a till).
					// The count is always said: left out, it would be the number marked here.
					api.transition(r.id, 'seated', {
						tableIds: ids,
						...(comboId ? { comboId } : {}),
						seatedCovers: covers,
						expectedVersion: fresh.version,
						...overbook,
					}),
				partial
					? _(msg`Seated ${covers} of ${size} for ${who} at ${where}.`)
					: _(msg`Seated ${who} at ${where}.`),
				{
					undo: () => api.undo(r.id),
					anyway: again,
					restore,
					subject: r.id,
					...(partial ? { context: 'partial' as const } : {}),
				},
			)
		} else if (current.kind === 'waitlist') {
			const entry = current.entry
			const version =
				latest?.waitlist.find((x) => x.id === entry.id)?.version ??
				entry.version
			const name = entry.displayName
			await act(
				() => api.seatWaitlist(entry.id, ids, version, overbook),
				_(msg`Seated ${name} at ${where}.`),
				{ anyway: again, restore },
			)
		} else if (current.kind === 'assign') {
			// A booking given a table for its own time: not seated, so no covers and no stay changes.
			const r = current.reservation
			const who = shortName(r, _(msg`Guest`))
			const fresh = latest?.feed.reservations.find((x) => x.id === r.id) ?? r
			const from = fresh.tableIds
			const fromCombo = fresh.comboId ?? null
			await act(
				() => api.assign(r.id, ids, fresh.version, overbook, comboId),
				_(msg`Table ${where} for ${who}.`),
				{
					// Back to no table (or to the tables they had) is not offered when they had none:
					// a till cannot take a table away.
					...(from.length > 0
						? {
								undo: () =>
									api.assign(
										r.id,
										from,
										readyRef.current?.feed.reservations.find(
											(x) => x.id === r.id,
										)?.version,
										{},
										fromCombo,
									),
							}
						: {}),
					anyway: again,
					restore,
					subject: r.id,
				},
			)
		} else if (current.kind === 'move') {
			const r = current.reservation
			const who = shortName(r, _(msg`Guest`))
			const fresh = latest?.feed.reservations.find((x) => x.id === r.id) ?? r
			const from = fresh.tableIds
			const fromCombo = fresh.comboId ?? null
			await act(
				() => api.assign(r.id, ids, fresh.version, overbook, comboId),
				_(msg`Moved ${who} to ${where}.`),
				{
					// Back to where they were, as one combination if they sat at one, under the
					// version the booking has by then (a poll or the move itself moved it).
					undo: () =>
						api.assign(
							r.id,
							from,
							readyRef.current?.feed.reservations.find((x) => x.id === r.id)
								?.version,
							{},
							fromCombo,
						),
					anyway: again,
					restore,
					subject: r.id,
				},
			)
		} else {
			const size = current.partySize
			await act(
				() =>
					api.walkIn(
						{
							partySize: size,
							tableIds: ids,
							guestName: current.guestName,
							...overbook,
						},
						// Each request keeps its own key for the party: a retry after no
						// answer is the same request, never a second party.
						insist ? current.overbookKey : current.key,
					),
				_(msg`Seated a walk-in of ${size} at ${where}.`),
				{ anyway: again, restore },
			)
		}
	}

	/** Why a table cannot be part of the group, in a sentence (for a tap that did nothing). */
	const whyNot = (
		label: string,
		why: 'taken' | 'resetting' | 'booked' | 'blocked' | 'far' | 'full',
		at?: number,
	): string => {
		const time = at !== undefined ? formatTime(at) : ''
		switch (why) {
			case 'resetting':
				return _(msg`Table ${label} is still being reset.`)
			case 'booked':
				return _(msg`Table ${label} is booked at ${time}, during their stay.`)
			case 'blocked':
				return _(
					msg`Table ${label} is blocked from ${time}, during their stay.`,
				)
			case 'far':
				return _(msg`Table ${label} is not next to the tables chosen.`)
			case 'full':
				return _(msg`A group can be at most ${MAX_COMBINED_TABLES} tables.`)
			default:
				return _(msg`Table ${label} is taken.`)
		}
	}

	/** Starts joining tables, from the tables given (the best group) or from none. */
	const startJoining = (ids: string[] = []) => {
		setJoining(ids)
		setForceSmall(false)
		const first = readyRef.current?.feed.tables.find((t) => t.id === ids[0])
		if (first) chooseRoom(first.areaId)
	}

	/** A tap while joining tables: takes the table into the group, takes it out again, or says why not. */
	const toggleJoined = (table: DayTable, state: TableState) => {
		const latest = readyRef.current
		if (!latest || !placing || joining === null) return
		const selected = joining
			.map((id) => latest.feed.tables.find((t) => t.id === id))
			.filter((t): t is DayTable => t !== undefined)
		const verdict = joinVerdict({
			table,
			state,
			selected,
			feed: latest.feed,
			party: partyToPlace(placing, clock()),
			now: clock(),
		})
		if (verdict.kind === 'selected') {
			setJoining(joining.filter((id) => id !== table.id))
			return
		}
		if (verdict.kind === 'addable') {
			setJoining([...joining, table.id])
			return
		}
		const label = table.label
		if (verdict.kind === 'far' || verdict.kind === 'full') {
			say(whyNot(label, verdict.kind), { tone: 'danger' })
			return
		}
		const why = verdict.verdict
		say(
			whyNot(
				label,
				why.fits || why.why === 'small' ? 'taken' : why.why,
				'at' in why ? why.at : undefined,
			),
			{ tone: 'danger' },
		)
	}

	/** Seats the party at the tables joined: the same checks as one table, over the whole group. */
	const seatJoined = () => {
		const latest = readyRef.current
		if (!latest || !placing || joining === null) return
		const tables = joining
			.map((id) => latest.feed.tables.find((t) => t.id === id))
			.filter((t): t is DayTable => t !== undefined)
		if (tables.length === 0) return
		const verdict = groupVerdict(
			tables,
			latest.feed,
			partyToPlace(placing, clock()),
			clock(),
		)
		if (!verdict.fits) {
			if (verdict.why === 'small') {
				const seats = verdict.seats
				const size = placingSize(placing)
				say(_(msg`These tables seat ${seats}. This party is ${size}.`), {
					tone: 'danger',
				})
			} else {
				const label = tables.find((t) => t.id === verdict.tableId)?.label ?? ''
				say(whyNot(label, verdict.why, verdict.at ?? verdict.until), {
					tone: 'danger',
				})
			}
			return
		}
		const current = placing
		setPlacing(null)
		setJoining(null)
		void seat(current, tables, false)
	}

	/** Picks a party up (or puts it down); on a phone the floor then comes to the front. */
	const pick = (next: Placing | null) => {
		setPlacing(next)
		if (next && !wide) setTab('floor')
		// The floor is where the party goes: the drawer gets out of its way.
		if (next) setRailOpen(false)
	}

	/** A new booking, from the header or from a table and a time on the timeline. */
	const startBooking = (
		table: DayTable | null,
		startMin?: number,
		/** Start for a guest: booking again, or a name or number a search found no one for. */
		who?: { first: string; last: string; phone: string; partySize?: number },
	) => {
		if (!feed || !ready) return
		const requestedDay = date ?? ready.today
		bookingKey.current = crypto.randomUUID()
		setBookingLocked(false)
		setReadBack(null)
		setBookingPrefill({
			// Never a day that has passed: a booking looks forward.
			date: requestedDay < ready.today ? ready.today : requestedDay,
			// Not wrapped at midnight: a stretch after it is still this business day's.
			...(startMin !== undefined ? { startMin } : {}),
			tableIds: table ? [table.id] : [],
			tableLabel: table?.label ?? '',
			maxCovers: table?.maxCovers ?? 0,
			...(who
				? {
						guest: { first: who.first, last: who.last, phone: who.phone },
						...(who.partySize ? { partySize: who.partySize } : {}),
					}
				: {}),
		})
		setBookingOpen(true)
	}

	/** The waitlist form, empty or with a name and number carried over from a search. */
	const openJoin = (prefill: WaitlistPrefill | null) => {
		joinKey.current = crypto.randomUUID()
		setJoinPrefill(prefill)
		setJoinOpen(true)
	}

	/** Whether the person being booked is already in the book that day, or on the waitlist. */
	const repeatOf = (
		who: { first: string; last: string; phone: string },
		date: string,
	): Repeat | null => {
		const latest = readyRef.current
		if (!latest) return null
		// A number typed without its country code is taken to be in the location's own.
		const countryCode = locationCountryCode({
			timeZone: latest.feed.settings?.timeZone,
			phones: [
				...latest.feed.reservations.map((r) => r.guest?.phone),
				...latest.waitlist.map((e) => e.phone),
			],
		})
		return findRepeat(
			who,
			date === latest.feed.businessDate ? latest.feed.reservations : [],
			date === latest.today ? latest.waitlist : [],
			{ countryCode },
		)
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

	/** Seats a booking at a table now (the table it holds, or one the host tapped): asked about first where it matters. */
	const seatBooking = (r: DayReservation, table: DayTable) =>
		proceed(reservationPlacing(r), table, stateOf(table))

	const onCommand = async (r: DayReservation, command: PartyCommand) => {
		if (command.kind === 'place') {
			setPartyId(null)
			pick(reservationPlacing(r))
			return
		}
		if (command.kind === 'seatAt') {
			const table = readyRef.current?.feed.tables.find(
				(t) => t.id === command.tableId,
			)
			setPartyId(null)
			// A table that is gone: back to choosing one.
			if (table) seatBooking(r, table)
			else pick(reservationPlacing(r))
			return
		}
		if (command.kind === 'move') {
			// The floor asks which table, the same way it does for a party to seat.
			setPartyId(null)
			pick({ kind: 'move', reservation: r })
			return
		}
		if (command.kind === 'seatPart') {
			// Only the ones who are here: the floor asks for their table. All of
			// them (the stepper at the party's size) is the whole party.
			setPartyId(null)
			pick(
				command.covers < r.partySize
					? { kind: 'reservation', reservation: r, covers: command.covers }
					: { kind: 'reservation', reservation: r },
			)
			return
		}
		if (command.kind === 'extend') {
			const who = shortName(r, _(msg`Guest`))
			// A quarter hour past the later of their end and now, never a time already gone.
			const plan = extendPlan(r, clock())
			if (!plan.ok) {
				say(_(msg`A longer stay is a manager’s to set in the app.`), {
					tone: 'danger',
				})
				return
			}
			const clears = formatTime(plan.clearAt)
			await act(
				() =>
					api.changeParty(r.id, { durationMin: plan.durationMin }, r.version),
				_(
					msg`${who}: ${EXTEND_STEP_MIN} more minutes, expected clear about ${clears}.`,
				),
				// No undo: a till can only keep a table longer. Shortening the stay is a
				// manager's (the server refuses it), so a button for it would never work.
				{ subject: r.id, context: 'stay' },
			)
			return
		}
		if (command.kind === 'again') {
			setPartyId(null)
			const guest = r.guest
			const canRead = readyRef.current?.grant.canReadGuest === true
			startBooking(null, undefined, {
				first: guest?.firstName?.trim() || guest?.name?.split(/\s+/)[0] || '',
				last:
					guest?.lastName?.trim() ||
					(guest?.firstName?.trim()
						? ''
						: (guest?.name?.split(/\s+/).slice(1).join(' ') ?? '')),
				// Without the guest grant the number is only its end: never carried over.
				phone: canRead && guest?.phone ? formatPhone(guest.phone) : '',
				partySize: r.partySize,
			})
			return
		}
		// What this tablet marks itself is not announced again as news (until the
		// day shows it, a while passes, or the change turns out not to have happened).
		const markedAt = clock()
		const marks =
			command.kind === 'status' && command.to === 'arrived'
				? selfArrived.current
				: command.kind === 'status' && command.to === 'cancelled'
					? selfChanged.current
					: null
		marks?.mark(r.id, markedAt)
		const unmark = () => marks?.unmark(r.id)
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
				if (wasNoShow) pick(reservationPlacing(r))
			}
			return
		}
		const arrivedCovers = command.arrivedCovers ?? r.partySize
		const size = r.partySize
		// Some of them, not all: the booking stays at the stand, short of its size.
		const partlyHere = command.to === 'arrived' && arrivedCovers < size
		const done = partlyHere
			? _(msg`${who}: ${arrivedCovers} of ${size} are here.`)
			: command.to === 'arrived'
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
					...(command.arrivedCovers !== undefined
						? { arrivedCovers: command.arrivedCovers }
						: {}),
				}),
			done,
			{
				...(reversible ? { undo: () => api.undo(r.id), subject: r.id } : {}),
				onRefused: unmark,
				...(partlyHere ? { context: 'partial' as const } : {}),
			},
		)
		if (ok) setPartyId(null)
	}

	/**
	 * A guest who walks in has a booking (late, missed, or marked a no-show a
	 * while ago): seat that booking instead of making a second one. A booking
	 * still open is simply picked up; a recent no-show is taken back with the
	 * undo; an older one is asked to be marked here, which the server may
	 * refuse for a till (said, with the walk-in form left open to carry on).
	 */
	const seatLate = async (guest: LateGuest) => {
		const r = guest.reservation
		const who = shortName(r, _(msg`Guest`))
		const done = () => {
			setWalkInOpen(false)
			setJoinOpen(false)
			pick(reservationPlacing(r))
		}
		if (guest.kind === 'seat') {
			done()
			return
		}
		const ok =
			guest.kind === 'undo'
				? await act(() => api.undo(r.id), _(msg`Undone for ${who}.`), {
						subject: r.id,
					})
				: await act(
						() =>
							api.transition(r.id, 'arrived', { expectedVersion: r.version }),
						_(msg`${who} is here.`),
						{ subject: r.id, context: 'reopen' },
					)
		if (ok) done()
	}

	// ---------------------------------------------------------------------
	// States before there is a floor to show
	// ---------------------------------------------------------------------

	if (state.status === 'blocked') {
		return (
			<>
				{renderHeader()}
				<Blocked
					error={state.error}
					online={online}
					onSignIn={onSignIn}
					onRetry={() => void refresh({ full: true })}
				/>
			</>
		)
	}
	if (!ready || !feed) {
		return (
			<>
				{renderHeader()}
				<div className="floor-room flex flex-1 items-center justify-center">
					<p className="t-shimmer text-base font-medium">
						<Trans>Opening today’s floor…</Trans>
					</p>
				</div>
			</>
		)
	}

	// The day asked for: the arrows move from it, not from the day still drawn.
	const requestedDate = date ?? ready.today
	// Today's late and missed parties a typed walk-in name may really be.
	const lateGuestsFor = (typed: string) =>
		isToday
			? findLateGuests(feed.reservations, typed, clock(), UNDO_WINDOW_MS)
			: []
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
		const pending = tooSmall ?? resetAsk
		setTooSmall(null)
		setResetAsk(null)
		if (pending) setPlacing(pending.placing)
	}
	const resetLabel = resetAsk?.table.label ?? ''
	const resetReady = resetAsk ? formatTime(resetAsk.readyAt) : ''
	/** An offer put away: never made again for this table and party. */
	const dismissOffer = (made: FreeTableOffer) =>
		setDismissedOffers((previous) => new Set(previous).add(made.key))
	/** One tap on an offer seats them, by the same rules as any seating. */
	const acceptOffer = (made: FreeTableOffer) => {
		dismissOffer(made)
		proceed(made.placing, made.table, stateOf(made.table))
	}
	const tooSmallLabel = tooSmall?.table.label ?? ''
	const tooSmallSeats = tooSmall?.table.maxCovers ?? 0
	const tooSmallParty = tooSmall ? placingSize(tooSmall.placing) : 0
	const placingName = placing
		? placing.kind === 'reservation' ||
			placing.kind === 'move' ||
			placing.kind === 'assign'
			? shortName(placing.reservation, _(msg`Guest`))
			: placing.kind === 'waitlist'
				? placing.entry.displayName
				: placing.guestName.trim() || _(msg`Walk-in`)
		: ''
	const partyInHand = placing ? partyToPlace(placing, now) : null
	// Seating them anyway at a table too small: the floor stops holding size against the tables.
	const picking = partyInHand
		? forceSmall
			? { ...partyInHand, partySize: 1 }
			: partyInHand
		: null
	const joinedTables = (joining ?? [])
		.map((id) => feed.tables.find((t) => t.id === id))
		.filter((t): t is DayTable => t !== undefined)
	// While joining tables the floor reads each table against the group, not alone.
	const joinOf =
		partyInHand && joining !== null
			? (table: DayTable, state: TableState) =>
					joinVerdict({
						table,
						state,
						selected: joinedTables,
						feed,
						party: partyInHand,
						now,
					})
			: null
	// Nothing seats the party alone: the calm offer (join tables, the waitlist, anyway).
	const noFit =
		partyInHand && joining === null && !forceSmall
			? noFitOf(feed, partyInHand, now)
			: null
	// How many tables in each room take the party, for the room tabs.
	const fitCounts =
		partyInHand && joining === null ? fitsByRoom(feed, partyInHand, now) : null
	/** A tap on the grid that started nothing: say why, so it never feels dead. */
	const onRefused = (why: TimelineRefusal) =>
		say(
			why === 'past'
				? _(msg`That time has already passed.`)
				: why === 'closed'
					? _(msg`The restaurant is closed this day.`)
					: _(msg`Past days are read only.`),
		)
	const onTable = (table: DayTable, state: TableState) => {
		if (busy || !isToday) return
		if (placing) void seatAt(table, state)
		else setTableTargetId(table.id)
	}
	// Another day has no floor to look at (it is how the room is now): the timeline stands in.
	// The list (the book side by side) needs a roomy screen; a narrower one shows the floor.
	const shownView: MainView = view === 'list' && !roomy ? 'floor' : view
	const mainView: MainView =
		isToday || shownView === 'list' ? shownView : 'timeline'
	const pane: PaneTab = wide
		? mainView
		: tab === 'floor' && !isToday
			? 'timeline'
			: tab
	const paneOrder: PaneTab[] =
		wide && !roomy ? ['floor', 'timeline'] : ['list', 'floor', 'timeline']
	const paneProps = (id: PaneTab) =>
		({
			'data-active': pane === id,
			'aria-hidden': pane === id ? undefined : true,
			inert: pane !== id,
			style: {
				'--bk-dir': paneOrder.indexOf(id) < paneOrder.indexOf(pane) ? -1 : 1,
			} as React.CSSProperties,
		}) as const
	// Nothing to draw: said with the location's name and how many tables came in.
	const noTablesMessage = noTablesText(_, locationName, feed.tables.length)
	const railWait = waitlistSummary(list.waitlist, now)
	const railWaitLongest = formatCount(railWait.longestMin, i18n.locale)
	const railWaitCount = railWait.count
	const railWaitMin = railWait.longestMin
	const panel = (single: boolean, onClose?: () => void, columns = false) => (
		<BookPanel
			columns={columns}
			list={list}
			query={query}
			onQuery={setQuery}
			placing={placing}
			now={now}
			formatTime={formatTime}
			isToday={isToday}
			waitlistOn={ready.grant.features.waitlist}
			single={single}
			fresh={freshIds}
			canReadGuest={ready.grant.canReadGuest}
			textedBy={textedBy}
			earlyOf={(r) => earlyArrival(r, feed, now)}
			onPick={
				columns
					? (next) => {
							pick(next)
							// Seating happens on the floor: picking a party up there takes the host to it.
							if (next) chooseView('floor')
						}
					: pick
			}
			onDetails={(r) => setPartyId(r.id)}
			onWaitlistDetails={(entry) => setWaitlistId(entry.id)}
			onAddWaitlist={() => openJoin(null)}
			quotes={quotes}
			onQuoteJoin={(partySize) =>
				openJoin({ displayName: '', phone: '', partySize })
			}
			onBookFor={(typed) => {
				const who = guestFromQuery(typed)
				startBooking(null, undefined, who)
			}}
			onWaitlistFor={(typed) => {
				const who = guestFromQuery(typed)
				openJoin({ displayName: displayNameOf(who), phone: who.phone })
			}}
			onClose={onClose}
			writesBlocked={offlineReason}
			tags={tags}
			pressure={pressure}
			onlyIds={onlyIds}
			onClearOnly={() => setOnlyIds(null)}
		/>
	)

	const viewSwitch = wide ? (
		<ViewTabs
			label={_(msg`View`)}
			value={mainView}
			onChange={chooseView}
			options={[
				...(roomy
					? [
							{
								value: 'list' as const,
								label: _(msg`List`),
								icon: <Icon name="list" className="size-4" />,
								compact: true,
							},
						]
					: []),
				{
					value: 'floor',
					label: _(msg`Floor`),
					icon: <Icon name="layout-grid" className="size-4" />,
					disabled: !isToday,
					compact: true,
				},
				{
					value: 'timeline',
					label: _(msg`Timeline`),
					icon: <Icon name="rows-3" className="size-4" />,
					compact: true,
				},
			]}
		/>
	) : null

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			{renderHeader(
				<StandHeader
					totals={totals}
					filtered={activeService !== null}
					date={requestedDate}
					isToday={isToday}
					today={ready.today}
					onDate={chooseDate}
					services={services}
					serviceId={activeService}
					onService={setServiceId}
					wide={wide}
					waitlistOn={ready.grant.features.waitlist}
					stale={ready.stale}
					onWalkIn={() => setWalkInOpen(true)}
					onWaitlist={() => openJoin(null)}
					onBooking={() => startBooking(null)}
					offlineReason={offlineReason}
					view={viewSwitch}
				/>,
			)}
			<OfflineStrip connection={connection} formatTime={formatTime} />
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
			{/* Changes at the stand (a party here, a booking made or cancelled): told at once, even when a toast with a button is up. */}
			<p key={news.seq} role="status" className="sr-only">
				{news.text}
			</p>
			<Reveal open={placing !== null}>
				<PickBar
					name={placingName}
					partySize={placing ? placingSize(placing) : 0}
					wholeParty={
						placing?.kind === 'reservation' ||
						placing?.kind === 'move' ||
						placing?.kind === 'assign'
							? placing.reservation.partySize
							: placing
								? placingSize(placing)
								: 0
					}
					covers={
						placing?.kind === 'reservation' &&
						placing.covers !== undefined &&
						placing.covers < placing.reservation.partySize
							? placing.covers
							: null
					}
					joined={joining === null ? null : joinedTables}
					canCombine={
						feed.tables.filter((t) => !t.archivedAt).length >= 2 &&
						// The "no table fits" offer says it already while it shows.
						!(noFit !== null && noFit.none)
					}
					forced={forceSmall}
					onCombine={() => startJoining([])}
					onSeatJoined={seatJoined}
					onRemoveTable={(id) =>
						setJoining((chosen) => (chosen ?? []).filter((x) => x !== id))
					}
					onBackToOne={() => setJoining(null)}
					onCancel={() => setPlacing(null)}
				/>
			</Reveal>
			<Reveal open={placing !== null && noFit !== null && noFit.none}>
				{placing && noFit ? (
					<NoFitBanner
						partySize={placingSize(placing)}
						biggest={noFit.biggest}
						tooBig={noFit.tooBig}
						group={noFit.group}
						quoteMin={noFitQuote}
						canWaitlist={
							placing.kind === 'walk_in' && ready.grant.features.waitlist
						}
						onCombine={() => startJoining(noFit.group?.tableIds ?? [])}
						onWaitlist={() => {
							// The party stays in hand's size and name: the waitlist form starts with them.
							const walkIn = placing
							setPlacing(null)
							if (walkIn.kind === 'walk_in')
								openJoin({
									displayName: walkIn.guestName.trim(),
									phone: '',
									partySize: walkIn.partySize,
								})
						}}
						onAnyway={() => setForceSmall(true)}
					/>
				) : null}
			</Reveal>

			{offer ? (
				<FreeTableBanner
					offer={offer}
					onSeat={() => acceptOffer(offer)}
					onDismiss={() => dismissOffer(offer)}
				/>
			) : null}

			{feed.dayState !== 'open' ? (
				<p className="notice-warning px-4 py-2 text-sm">
					{feed.closedLabel ?? (
						<Trans>Closed today. Walk-ins can still be seated.</Trans>
					)}
				</p>
			) : null}

			<div className="relative flex min-h-0 min-w-0 flex-1">
				{wide && !rail && mainView !== 'list' ? panel(false) : null}
				{rail ? (
					<>
						<nav
							className="border-border bg-card flex w-16 shrink-0 flex-col items-center border-e py-3"
							aria-label={_(msg`Parties to seat`)}
						>
							<button
								ref={railButton}
								type="button"
								className="bk-rail-button border-border relative inline-flex h-12 w-12 items-center justify-center rounded-(--station-control-radius) border"
								aria-expanded={railOpen}
								aria-label={_(
									msg`Open the list, ${list.toSeat.length + list.waitlist.length} waiting`,
								)}
								onClick={() => setRailOpen((open) => !open)}
							>
								<Icon name="list" aria-hidden className="size-6" />
								<span
									className="bg-primary text-primary-foreground tnum absolute -end-1.5 -top-1.5 flex h-5.5 min-w-5.5 items-center justify-center rounded-full px-1.25 text-sm font-semibold"
									aria-hidden
								>
									{list.toSeat.length + list.waitlist.length}
								</span>
							</button>
							{/* The line is pinned beside the list button: how many wait and the longest wait. */}
							{ready.grant.features.waitlist &&
							isToday &&
							railWait.count > 0 ? (
								<button
									type="button"
									className="bk-rail-wait bg-card tnum mt-2.5 flex w-13 flex-col items-center gap-0.5 px-0.5 py-1.5 font-semibold"
									data-over={railWait.longestOver}
									aria-label={_(
										msg`Waitlist: ${railWaitCount} waiting, longest wait ${railWaitMin} min. Open the list.`,
									)}
									onClick={() => setRailOpen(true)}
								>
									<Icon name="users" aria-hidden className="size-4" />
									<span aria-hidden>
										{formatCount(railWait.count, i18n.locale)}
									</span>
									<span aria-hidden dir="auto">
										{_(msg`${railWaitLongest}m`)}
									</span>
								</button>
							) : null}
						</nav>
						{railOpen ? (
							<>
								<div
									className="bk-scrim bg-foreground/28 absolute inset-0 z-29"
									aria-hidden
									onClick={() => setRailOpen(false)}
								/>
								<div
									className="bk-drawer absolute inset-y-0 start-0 z-30 flex shadow-(--elev-2)"
									tabIndex={-1}
									ref={drawerRef}
									onKeyDown={(event) => {
										if (event.key === 'Escape') setRailOpen(false)
									}}
								>
									{panel(false, () => setRailOpen(false))}
								</div>
							</>
						) : null}
					</>
				) : null}
				<div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
					{!wide || roomy ? (
						<div
							className="bk-page absolute inset-0 flex min-h-0 flex-col"
							{...paneProps('list')}
						>
							{wide
								? // Mounted only while it shows: the side panel is the list otherwise.
									mainView === 'list'
									? panel(false, undefined, true)
									: null
								: panel(true)}
						</div>
					) : null}
					<div
						className="bk-page absolute inset-0 flex min-h-0 flex-col"
						{...paneProps('floor')}
					>
						{room ? (
							<>
								<div className="border-border bg-card flex min-w-0 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2">
									{roomList.length > 1 ? (
										<div className="max-w-full min-w-0 overflow-x-auto">
											<Segmented
												label={_(msg`Room`)}
												value={room.id}
												onChange={chooseRoom}
												options={roomList.map((r) => {
													// While a party is in hand: how many of the room's tables take them.
													const count = fitCounts?.get(r.id)
													return {
														value: r.id,
														label:
															count === undefined
																? r.name
																: _(
																		plural(count, {
																			0: `${r.name}: none fit`,
																			one: `${r.name}: # fits`,
																			other: `${r.name}: # fit`,
																		}),
																	),
													}
												})}
												wrap={false}
											/>
										</div>
									) : (
										<h2 className="min-w-0 text-sm font-medium break-words">
											{room.name}
										</h2>
									)}
									<FreeCount free={free.free} total={free.total} />
									<TableLegend />
									{sections.length > 0 && isToday ? (
										<Button
											variant="ghost"
											aria-pressed={sectionsShown}
											title={_(msg`Show server sections on the floor`)}
											// A phone has no room for it beside the rooms: sections stay as set on the tablet.
											className={cn(
												'max-sm:hidden',
												sectionsShown && 'bg-secondary',
											)}
											onClick={toggleSections}
										>
											<Icon name="layout-grid" className="size-4" />
											<Trans>Sections</Trans>
										</Button>
									) : null}
								</div>
								{sectionsShown && sections.length > 0 && isToday ? (
									<SectionStrip
										loads={loads}
										upNextId={upNextId}
										offlineReason={offlineReason}
										onAssign={() => setAssigning(true)}
									/>
								) : null}
								<Floor
									area={room}
									feed={feed}
									now={now}
									picking={picking}
									join={joinOf}
									canReadGuest={ready.grant.canReadGuest}
									sections={sectionsShown && isToday ? tableSections : null}
									rank={upNextId ? rotation : undefined}
									formatTime={formatTime}
									formatShort={formatShort}
									onTable={onTable}
								/>
							</>
						) : (
							<div className="floor-room flex flex-1 items-center justify-center p-6 text-center">
								<p className="text-muted-foreground max-w-sm">
									{noTablesMessage}
								</p>
							</div>
						)}
					</div>
					<div
						className="bk-page absolute inset-0 flex min-h-0 flex-col"
						{...paneProps('timeline')}
					>
						<Timeline
							feed={feed}
							now={now}
							isToday={isToday}
							bookable={feed.businessDate >= ready.today}
							serviceId={activeService}
							matchIds={matchIds}
							// Joining tables: each table is read for one cover (the group is judged on seating).
							picking={
								picking && joining !== null
									? { ...picking, partySize: 1 }
									: picking
							}
							active={pane === 'timeline'}
							canReadGuest={ready.grant.canReadGuest}
							formatTime={formatTime}
							formatShort={formatShort}
							onBar={(r) => setPartyId(r.id)}
							onTable={onTable}
							onEmpty={(table, minute) => startBooking(table, minute)}
							onRefused={onRefused}
							// A booking with no table, tapped in its strip: straight to choosing one.
							onPlace={(r) => {
								if (offlineReason) {
									say(offlineReason, { tone: 'danger' })
									return
								}
								if (isToday) pick({ kind: 'assign', reservation: r })
								else setPartyId(r.id)
							}}
							noTables={noTablesMessage}
						/>
					</div>
				</div>
				{dayLoading ? (
					<div
						role="status"
						className="bg-background/70 absolute inset-0 z-20 flex items-center justify-center"
					>
						<div className="flex flex-col items-center gap-3 text-center">
							{dayFailed ? (
								<>
									<p className="text-base font-medium">
										<Trans>Could not open this day.</Trans>
									</p>
									<Button
										variant="outline"
										size="lg"
										onClick={() => chooseDate(date)}
									>
										<Icon name="refresh-cw" className="size-5" />
										<Trans>Try again</Trans>
									</Button>
								</>
							) : (
								<p className="t-shimmer text-base font-medium">
									<Trans>Opening the book…</Trans>
								</p>
							)}
						</div>
					</div>
				) : null}
			</div>

			<PartySheet
				offlineReason={offlineReason}
				reservation={party}
				viewOnly={!isToday}
				canReadGuest={ready.grant.canReadGuest}
				tableKindOf={(tableId) => {
					const t = feed.tables.find((x) => x.id === tableId)
					return t ? tableState(t, feed, now).kind : null
				}}
				busy={busy || offlineReason !== null}
				now={now}
				formatTime={formatTime}
				formatDay={formatDay}
				onCommand={(r, command) => void onCommand(r, command)}
				onClose={() => setPartyId(null)}
			/>
			<WaitlistSheet
				entry={waitlistEntry}
				offlineReason={offlineReason}
				canReadGuest={ready.grant.canReadGuest}
				busy={busy || offlineReason !== null}
				now={now}
				formatTime={formatTime}
				onClose={() => setWaitlistId(null)}
				onPlace={(entry: WaitlistEntry) => {
					setWaitlistId(null)
					pick({ kind: 'waitlist', entry })
				}}
				textQueued={waitlistEntry ? textedBy.get(waitlistEntry.id) : undefined}
				onNotify={(entry) => {
					const who = entry.firstName || entry.displayName
					void act(
						() => api.notifyWaitlist(entry.id, entry.version),
						// A text is claimed only as on its way, and only when the server says one was queued.
						(result) => {
							const holdsUntil = holdEndOf(result)
							return notifiedToast(
								_,
								who,
								textQueuedOf(result),
								holdsUntil !== null ? formatTime(holdsUntil) : null,
							)
						},
						{
							onSuccess: (result) => {
								const queued = textQueuedOf(result)
								if (queued !== undefined)
									setTextedBy((previous) =>
										new Map(previous).set(entry.id, queued),
									)
							},
						},
					)
				}}
				onRemove={(entry, version, target: LeaveTarget) =>
					void act(
						// The version the host saw when they armed it: a change since is refused.
						() => api.leaveWaitlist(entry.id, version, target),
						// A hold that ran out is said as that, not as a party that left.
						removedToast(_, entry.displayName, target),
					).then((ok) => ok && setWaitlistId(null))
				}
				onBack={(entry, version) =>
					void act(
						() => api.leaveWaitlist(entry.id, version, 'waiting'),
						removedToast(_, entry.displayName, 'waiting'),
						{
							onSuccess: () => {
								// Told no longer: what this tablet knew of their text is not true of the next time.
								setTextedBy((previous) => {
									const next = new Map(previous)
									next.delete(entry.id)
									return next
								})
							},
						},
					).then((ok) => ok && setWaitlistId(null))
				}
			/>
			<SectionsSheet
				open={assigning && sectionService !== null}
				serviceName={sectionService?.name ?? ''}
				sections={sections}
				tableLabel={(id) => feed.tables.find((t) => t.id === id)?.label ?? id}
				loadServers={() =>
					api.servers({
						from: zonedEpoch(
							feed.businessDate,
							sectionService?.firstSeatingMin ?? 0,
							zone,
						),
						to: zonedEpoch(
							feed.businessDate,
							sectionService?.endMin ?? 24 * 60,
							zone,
						),
					})
				}
				busy={busy}
				formatTime={formatTime}
				offlineReason={offlineReason}
				onClose={() => setAssigning(false)}
				onSave={(assignments) => {
					if (!sectionService) return
					const serviceName = sectionService.name
					void act(
						() =>
							api.assignSections({
								date: feed.businessDate,
								serviceId: sectionService.id,
								assignments,
							}),
						_(msg`Servers saved for ${serviceName}`),
						{ onSuccess: () => setAssigning(false) },
					)
				}}
			/>
			<TableSheet
				section={
					tableTarget ? (tableSections.get(tableTarget.table.id) ?? null) : null
				}
				target={tableTarget}
				offlineReason={offlineReason}
				recent={recentlyCleared}
				busy={busy || offlineReason !== null}
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
				onSeatHeld={(table, r) => {
					setTableTargetId(null)
					seatBooking(r, table)
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
					proceed(walkIn, table, stateOf(table))
				}}
			/>
			<ChangePartySheet
				reservation={changing}
				seated={changing?.status === 'seated'}
				maxSize={
					changing?.status === 'seated'
						? changing.tableIds.reduce(
								(sum, id) =>
									sum + (feed.tables.find((t) => t.id === id)?.maxCovers ?? 0),
								0,
							) || null
						: null
				}
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
					const marks = selfChanged.current
					marks.mark(r.id, clock())
					const size = change.partySize ?? r.partySize
					const time = change.timeLabel ?? formatTime(r.startAt)
					const atTable = r.status === 'seated'
					const done = atTable
						? _(msg`${who} is now ${size}.`)
						: _(msg`${who} is now ${size} at ${time}.`)
					void act(
						() =>
							api.changeParty(
								r.id,
								{
									...(change.partySize ? { partySize: change.partySize } : {}),
									...(change.time && change.localStartMin !== undefined
										? { time: change.time, localStartMin: change.localStartMin }
										: {}),
									// The server gives a new size a turn's stay of its own; one
									// already at the table keeps the stay it has (with any "+15").
									...(atTable && change.partySize
										? { durationMin: r.durationMin }
										: {}),
								},
								r.version,
							),
						done,
						{
							onSuccess: () => {
								setChangeId(null)
								setChangeUnsure(null)
							},
							onRefused: () => marks.unmark(r.id),
							onUnsure: () =>
								setChangeUnsure({
									id: r.id,
									partySize: size,
									localStartMin: change.localStartMin ?? null,
									say: done,
								}),
						},
					)
				}}
			/>
			<WalkInSheet
				open={walkInOpen}
				lateGuests={lateGuestsFor}
				formatTime={formatTime}
				onUseLate={(guest) => void seatLate(guest)}
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
				slotReason={(slot, partySize, day) =>
					reasonOfSlot({ slot, partySize, date: day, feed })
				}
				repeatOf={repeatOf}
				checkedDay={feed.businessDate}
				onOpenRepeat={(repeat) => {
					setBookingOpen(false)
					if (repeat.kind === 'booking') setPartyId(repeat.reservation.id)
					else setWaitlistId(repeat.entry.id)
				}}
				formatTime={formatTime}
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
						(result) => {
							// The table is said only when the answer names one.
							const table = bookingAnswerOf(result, feed.tables).table
							return day
								? table
									? _(
											msg`Booked ${first} for ${size} on ${day} at ${time}, table ${table}.`,
										)
									: _(msg`Booked ${first} for ${size} on ${day} at ${time}.`)
								: table
									? _(
											msg`Booked ${first} for ${size} at ${time}, table ${table}.`,
										)
									: _(msg`Booked ${first} for ${size} at ${time}.`)
						},
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
										table: null,
										asFirstSent: true,
									})
									return
								}
								const answer = bookingAnswerOf(result, feed.tables)
								setReadBack({
									name: [first, input.lastName].join(' ').trim(),
									partySize: size,
									when: day
										? _(msg`${day} at ${time}`)
										: _(msg`Today at ${time}`),
									code: answer.code,
									table: answer.table,
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
				prefill={joinPrefill}
				loadQuote={api.waitlistQuote}
				lateGuests={lateGuestsFor}
				formatTime={formatTime}
				onUseLate={(guest) => void seatLate(guest)}
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
					<div className="grid grid-cols-2 gap-3">
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
								if (pending) void seat(pending.placing, [pending.table], false)
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
			{/* A phone's three adds sit at the bottom, where a thumb is. */}
			{!wide ? (
				<StandDock
					dockRef={dockRef}
					isToday={isToday}
					waitlistOn={ready.grant.features.waitlist}
					onWalkIn={() => setWalkInOpen(true)}
					onWaitlist={() => openJoin(null)}
					onBooking={() => startBooking(null)}
					offlineReason={offlineReason}
				/>
			) : null}
			<Modal
				open={resetAsk !== null}
				onClose={backToPlacing}
				title={_(msg`Table ${resetLabel} is still resetting`)}
				footer={
					<div className="grid grid-cols-2 gap-3">
						<Button size="lg" onClick={backToPlacing}>
							<Trans>Choose another</Trans>
						</Button>
						<Button
							variant="primary"
							size="lg"
							disabled={busy}
							onClick={() => {
								const pending = resetAsk
								setResetAsk(null)
								if (pending)
									proceed(
										pending.placing,
										pending.table,
										stateOf(pending.table),
										true,
									)
							}}
						>
							<Trans>Seat anyway</Trans>
						</Button>
					</div>
				}
			>
				<p className="text-muted-foreground p-5">
					<Trans>
						Table {resetLabel} is ready about {resetReady}. Seat them there
						anyway?
					</Trans>
				</p>
			</Modal>
			<Toast message={toast} onDone={dismissToast} liftAbove={dockRef} />
		</div>
	)
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
				<Icon name="lock" className="size-5" />
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
				<Icon name="refresh-cw" className="size-5" />
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
				<Icon name="lock" className="size-5" />
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
				<Icon name="refresh-cw" className="size-5" />
				<Trans>Try again</Trans>
			</Button>
		)
	}
	return (
		<div className="floor-room flex flex-1 items-center justify-center p-6">
			<div className="flex max-w-md flex-col items-center gap-4 p-6 text-center">
				<h2 className="text-base font-semibold">{title}</h2>
				<p className={cn('text-muted-foreground')}>{body}</p>
				{action}
			</div>
		</div>
	)
}
