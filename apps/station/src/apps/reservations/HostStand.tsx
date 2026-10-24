import { type MessageDescriptor } from '@lingui/core'
import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type WaitlistEntry } from '@repo/reservations'
import {
	CalendarPlus,
	CloudOff,
	ListPlus,
	Lock,
	RefreshCw,
	UserPlus,
	X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HostApiError } from './api.ts'
import { Dock, placingSize, type Placing } from './Dock.tsx'
import {
	DEFAULT_TURN_MIN,
	arrivals,
	fits,
	missedArrivals,
	rooms,
	shortName,
	tableState,
	type DayReservation,
	type DayTable,
	type TableState,
} from './feed.ts'
import { Floor, FreeCount, freeTables } from './Floor.tsx'
import {
	BookingSheet,
	ChangePartySheet,
	JoinWaitlistSheet,
	PartySheet,
	TableSheet,
	WaitlistSheet,
	WalkInSheet,
	type BookingReadBackInfo,
	type PartyCommand,
} from './sheets.tsx'
import { useHostStand } from './useHostStand.ts'
import { holdLock } from '~/lib/activity.ts'
import { serverNow } from '~/lib/clock.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'
import { Toast, type ToastMessage } from '~/ui/motion.tsx'
import {
	Button,
	cn,
	Modal,
	NumberPop,
	Reveal,
	Segmented,
} from '~/ui/primitives.tsx'

const ROOM_KEY = 'station.hostStand.room'

function readRoom(): string | null {
	try {
		return localStorage.getItem(ROOM_KEY)
	} catch {
		return null
	}
}

/**
 * The host stand, floor first: the room fills the screen with every table's
 * state, and the parties still to seat wait in a dock along the bottom. Pick a
 * party up, tap a table that lifts, and they are seated; a toast says so and
 * offers to undo. Tap a table on its own to see who is there or due, or to seat
 * a walk-in on it.
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
	const { state, api, refresh, now, noteWrite } = useHostStand({
		settings,
		session,
		online,
	})
	const [roomId, setRoomId] = useState<string | null>(readRoom)
	const [placing, setPlacing] = useState<Placing | null>(null)
	const [partyId, setPartyId] = useState<string | null>(null)
	/** The booking whose size or time is being changed. */
	const [changeId, setChangeId] = useState<string | null>(null)
	/** The last change got no answer: it may have landed. */
	const [changeUnsure, setChangeUnsure] = useState(false)
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
	const dockRef = useRef<HTMLElement>(null)
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
	const due = useMemo(() => (feed ? arrivals(feed, now) : []), [feed, now])
	const missed = useMemo(
		() => (feed ? missedArrivals(feed, now) : []),
		[feed, now],
	)
	const party = feed?.reservations.find((r) => r.id === partyId) ?? null
	const waitlistEntry =
		ready?.waitlist.find((entry) => entry.id === waitlistId) ?? null

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
									label: _(t`Undo`),
									// A tap while the floor is still reloading waits for it, then undoes.
									run: () => {
										void settled.current.then(async () => {
											setBusy(true)
											noteWrite()
											try {
												await undo()
												say(_(t`Undone.`))
											} catch {
												say(_(t`Could not undo. Check the floor.`), {
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
							t`That already went through as first sent. Check the floor for what was recorded.`,
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
						table && fresh ? tableState(table, fresh, serverNow()).kind : null
					const label = anyway.table.label
					// Either way the party stays picked up, ready for a table.
					restore?.()
					if (kind !== 'open' && kind !== 'soon') {
						say(_(t`Table ${label} was just taken. Choose another table.`), {
							tone: 'danger',
						})
						return false
					}
					say(
						_(
							t`Someone is booked on that table before this party would be done.`,
						),
						{
							tone: 'danger',
							action: {
								label: _(t`Seat anyway`),
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
						? _(t`Someone changed this a moment ago. Here is the latest.`)
						: failure?.unsure
							? _(
									t`No answer in time. It may have gone through: check the floor before trying again.`,
								)
							: failure?.offline
								? _(t`No connection. Nothing was changed.`)
								: _(refusalMessage(failure)),
					{ tone: 'danger' },
				)
				return false
			} finally {
				if (!refreshed) await refresh({ full: true })
				finish()
			}
		},
		[refresh, say, noteWrite, _],
	)

	const seatAt = async (table: DayTable, tableState: TableState) => {
		if (!placing) return
		if (tableState.kind === 'seated' || tableState.kind === 'blocked') {
			say(_(t`Table ${table.label} is taken. Choose another table.`), {
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
			? { overbook: true, overbookReason: _(t`Seated at the host stand`) }
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
			const who = shortName(r, _(t`Guest`))
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
				_(t`Seated ${who} at ${table.label}.`),
				{ undo: () => api.undo(r.id), anyway: again, restore },
			)
		} else if (current.kind === 'waitlist') {
			const entry = current.entry
			const version =
				latest?.waitlist.find((x) => x.id === entry.id)?.version ??
				entry.version
			await act(
				() => api.seatWaitlist(entry.id, [table.id], version, overbook),
				_(t`Seated ${entry.displayName} at ${table.label}.`),
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
				_(t`Seated a walk-in of ${size} at ${table.label}.`),
				{ anyway: again, restore },
			)
		}
	}

	const onCommand = async (r: DayReservation, command: PartyCommand) => {
		if (command.kind === 'place') {
			setPartyId(null)
			setPlacing({ kind: 'reservation', reservation: r })
			return
		}
		const who = shortName(r, _(t`Guest`))
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
					? _(t`${who} is running ${minutes} min late.`)
					: _(t`${who} is on time.`),
			)
			return
		}
		if (command.kind === 'undo') {
			const ok = await act(() => api.undo(r.id), _(t`Undone for ${who}.`))
			if (ok) setPartyId(null)
			return
		}
		const done =
			command.to === 'arrived'
				? _(t`${who} is here.`)
				: command.to === 'finished'
					? _(t`${who} finished. Table cleared.`)
					: command.to === 'no_show'
						? _(t`${who} marked as a no-show.`)
						: command.to === 'cancelled'
							? _(t`Booking for ${who} cancelled.`)
							: _(t`Booking for ${who} confirmed.`)
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
	/** Not seating here after all: the party stays picked up for another table. */
	const backToPlacing = () => {
		const pending = tooSmall
		setTooSmall(null)
		if (pending) setPlacing(pending.placing)
	}
	const tooSmallLabel = tooSmall?.table.label ?? ''
	const tooSmallSeats = tooSmall?.table.maxCovers ?? 0
	const tooSmallParty = tooSmall ? placingSize(tooSmall.placing) : 0
	const covers = due.reduce((sum, r) => sum + r.partySize, 0)
	const placingName = placing
		? placing.kind === 'reservation'
			? shortName(placing.reservation, _(t`Guest`))
			: placing.kind === 'waitlist'
				? placing.entry.displayName
				: placing.guestName.trim() || _(t`Walk-in`)
		: ''

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			<div className="border-border bg-card flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
				{roomList.length > 1 && room ? (
					<Segmented
						label={_(t`Room`)}
						value={room.id}
						onChange={chooseRoom}
						options={roomList.map((r) => ({ value: r.id, label: r.name }))}
						wrap={false}
					/>
				) : room ? (
					<h2 className="text-lg font-semibold">{room.name}</h2>
				) : null}
				<FreeCount free={free.free} total={free.total} />
				<span className="text-muted-foreground hidden text-sm md:inline">
					·
				</span>
				<span className="text-muted-foreground hidden text-sm md:inline">
					<Trans>
						<NumberPop
							value={String(due.length)}
							className="tnum text-foreground font-semibold"
						/>{' '}
						to seat,{' '}
						<NumberPop
							value={String(covers)}
							className="tnum text-foreground font-semibold"
						/>{' '}
						covers
					</Trans>
				</span>
				{/* Always present, so going stale is announced. */}
				<span role="status" className="contents">
					{ready.stale ? (
						<span className="text-warning inline-flex items-center gap-1.5 text-sm font-medium">
							<CloudOff className="size-4" />
							<Trans>Not up to date</Trans>
						</span>
					) : null}
				</span>
				<div className="ms-auto flex flex-wrap items-center gap-2">
					<Button variant="outline" onClick={() => setWalkInOpen(true)}>
						<UserPlus className="size-4" />
						<Trans>Walk-in</Trans>
					</Button>
					{ready.grant.features.waitlist ? (
						<Button
							variant="outline"
							onClick={() => {
								joinKey.current = crypto.randomUUID()
								setJoinOpen(true)
							}}
							aria-label={_(t`Add to the waitlist`)}
						>
							<ListPlus className="size-4" />
							<span className="hidden sm:inline">
								<Trans>Waitlist</Trans>
							</span>
						</Button>
					) : null}
					<Button
						variant="primary"
						onClick={() => {
							bookingKey.current = crypto.randomUUID()
							setBookingLocked(false)
							setReadBack(null)
							setBookingOpen(true)
						}}
					>
						<CalendarPlus className="size-4" />
						<Trans>Booking</Trans>
					</Button>
				</div>
			</div>

			<p role="status" className="sr-only">
				{placing
					? _(t`Picked up ${placingName}. Tap a table to seat them.`)
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

			{room ? (
				<Floor
					area={room}
					feed={feed}
					now={now}
					picking={
						placing
							? {
									partySize: placingSize(placing),
									durationMin:
										placing.kind === 'reservation'
											? placing.reservation.durationMin
											: DEFAULT_TURN_MIN,
									reservationId:
										placing.kind === 'reservation'
											? placing.reservation.id
											: undefined,
								}
							: null
					}
					formatTime={formatTime}
					onTable={(table, tableState) => {
						if (busy) return
						if (placing) void seatAt(table, tableState)
						else setTableTargetId(table.id)
					}}
				/>
			) : (
				<div className="floor-room flex flex-1 items-center justify-center p-6 text-center">
					<p className="text-muted-foreground max-w-sm">
						<Trans>
							No tables yet. A manager adds the floor plan in the app, under
							Reservations, Setup.
						</Trans>
					</p>
				</div>
			)}

			<Dock
				ref={dockRef}
				arrivals={due}
				missed={missed}
				waitlist={ready.waitlist}
				waitlistOn={ready.grant.features.waitlist}
				placing={placing}
				now={now}
				formatTime={formatTime}
				onPick={setPlacing}
				onDetails={(r) => setPartyId(r.id)}
				onWaitlistDetails={(entry) => setWaitlistId(entry.id)}
			/>

			<PartySheet
				reservation={party}
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
					setPlacing({ kind: 'waitlist', entry })
				}}
				onNotify={(entry) =>
					void act(
						() => api.notifyWaitlist(entry.id, entry.version),
						_(t`${entry.displayName} has been texted.`),
					)
				}
				onRemove={(entry) =>
					void act(
						() => api.leaveWaitlist(entry.id, entry.version),
						_(t`${entry.displayName} left the waitlist.`),
					).then((ok) => ok && setWaitlistId(null))
				}
			/>
			<TableSheet
				target={tableTarget}
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
					setChangeUnsure(false)
				}}
				onSave={(change) => {
					const r = feed.reservations.find((x) => x.id === changeId)
					if (!r) return
					const who = shortName(r, _(t`Guest`))
					const size = change.partySize ?? r.partySize
					const time = change.timeLabel ?? formatTime(r.startAt)
					// The last try got no answer and the day now shows the change: it landed.
					if (
						changeUnsure &&
						r.partySize === size &&
						(!change.time || r.time === change.time)
					) {
						setChangeId(null)
						setChangeUnsure(false)
						say(_(t`${who} is now ${size} at ${time}.`))
						return
					}
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
						_(t`${who} is now ${size} at ${time}.`),
						{
							onSuccess: () => {
								setChangeId(null)
								setChangeUnsure(false)
							},
							onUnsure: () => setChangeUnsure(true),
						},
					)
				}}
			/>
			<WalkInSheet
				open={walkInOpen}
				onClose={() => setWalkInOpen(false)}
				onPlace={(partySize, guestName) => {
					setWalkInOpen(false)
					setPlacing({
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
				today={feed.businessDate}
				loadSlots={api.availability}
				onClose={() => setBookingOpen(false)}
				onBook={(input) => {
					const first = input.firstName
					const size = input.partySize
					const time = input.timeLabel
					// Another day is said out loud: it is what the caller will hear read back.
					const day =
						input.date === feed.businessDate
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
							? _(t`Booked ${first} for ${size} on ${day} at ${time}.`)
							: _(t`Booked ${first} for ${size} at ${time}.`),
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
									when: day ? _(t`${day} at ${time}`) : _(t`Today at ${time}`),
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
								? _(t`${name} is on the waitlist, about ${quoted} min.`)
								: _(t`${name} is on the waitlist.`)
						},
						{ onSuccess: () => setJoinOpen(false) },
					)
				}
			/>
			<Modal
				open={tooSmall !== null}
				onClose={backToPlacing}
				title={_(t`Table ${tooSmallLabel} is small for them`)}
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
			<Toast message={toast} onDone={dismissToast} liftAbove={dockRef} />
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
			return msg`That is done in the app, not at a till.`
		case 'not_a_host':
			return msg`You are not on this terminal’s host list.`
		case 'no_availability':
		case 'slot_unavailable':
			return msg`That time is no longer available. Choose another.`
		case 'invalid_status_transition':
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
