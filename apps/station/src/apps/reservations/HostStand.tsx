import { t, Trans } from '@lingui/macro'
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
import { useCallback, useMemo, useRef, useState } from 'react'
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
	JoinWaitlistSheet,
	PartySheet,
	TableSheet,
	WaitlistSheet,
	WalkInSheet,
	type PartyCommand,
} from './sheets.tsx'
import { useHostStand } from './useHostStand.ts'
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
	const { state, api, refresh, now } = useHostStand({
		settings,
		session,
		online,
	})
	const [roomId, setRoomId] = useState<string | null>(readRoom)
	const [placing, setPlacing] = useState<Placing | null>(null)
	const [partyId, setPartyId] = useState<string | null>(null)
	const [waitlistId, setWaitlistId] = useState<string | null>(null)
	/** The table whose sheet is open; its state is read from the live day. */
	const [tableTargetId, setTableTargetId] = useState<string | null>(null)
	const [walkInOpen, setWalkInOpen] = useState(false)
	const [bookingOpen, setBookingOpen] = useState(false)
	const [joinOpen, setJoinOpen] = useState(false)
	const [busy, setBusy] = useState(false)
	// A double tap on a toast's action must not run the change twice.
	const busyRef = useRef(false)
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
				if (!(error instanceof HostApiError && error.offline))
					ref.current = crypto.randomUUID()
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

	/** Runs a change, reloads the day, and says what happened (or what went wrong). */
	const act = useCallback(
		async (
			work: () => Promise<unknown>,
			done: string,
			undo?: () => Promise<unknown>,
			/** When the table is booked for part of the party's time: try again as an overbook. */
			anyway?: { table: DayTable; run: () => void; restore: () => void },
		) => {
			busyRef.current = true
			setBusy(true)
			let finish: () => void = () => {}
			settled.current = new Promise((resolve) => {
				finish = resolve
			})
			let refreshed = false
			try {
				await work()
				say(
					done,
					undo
						? {
								action: {
									label: _(t`Undo`),
									// A tap while the floor is still reloading waits for it, then undoes.
									run: () => {
										void settled.current.then(async () => {
											busyRef.current = true
											setBusy(true)
											try {
												await undo()
												await refresh({ full: true })
												say(_(t`Undone.`))
											} catch {
												say(_(t`Could not undo. Check the floor.`), {
													tone: 'danger',
												})
											} finally {
												busyRef.current = false
												setBusy(false)
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
				if (failure?.occupied && anyway) {
					// Look again first: only a table that is still free may be overbooked.
					const fresh = await refresh({ full: true })
					refreshed = true
					const table = fresh?.tables.find((t) => t.id === anyway.table.id)
					const kind =
						table && fresh ? tableState(table, fresh, serverNow()).kind : null
					const label = anyway.table.label
					if (kind !== 'open' && kind !== 'soon') {
						// The party stays picked up, ready for the next table.
						anyway.restore()
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
				say(
					failure?.stale
						? _(t`Someone changed this a moment ago. Here is the latest.`)
						: failure?.unsure
							? _(
									t`No answer in time. It may have gone through: check the floor before trying again.`,
								)
							: failure?.offline
								? _(t`No connection. Nothing was changed.`)
								: failure?.serverMessage ||
									_(t`That did not go through. Try again.`),
					{ tone: 'danger' },
				)
				return false
			} finally {
				if (!refreshed) await refresh({ full: true })
				busyRef.current = false
				setBusy(false)
				finish()
			}
		},
		[refresh, say, _],
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
					run: () => void seat(current, table, true),
					restore: () => setPlacing(current),
				}
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
				() => api.undo(r.id),
				again,
			)
		} else if (current.kind === 'waitlist') {
			const entry = current.entry
			const version =
				latest?.waitlist.find((x) => x.id === entry.id)?.version ??
				entry.version
			await act(
				() => api.seatWaitlist(entry.id, [table.id], version, overbook),
				_(t`Seated ${entry.displayName} at ${table.label}.`),
				undefined,
				again,
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
						// Insisting is a new request; the first try keeps the party's key.
						insist ? undefined : current.key,
					),
				_(t`Seated a walk-in of ${size} at ${table.label}.`),
				undefined,
				again,
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
					expectedVersion: r.version,
					...(command.reason ? { reason: command.reason } : {}),
				}),
			done,
			reversible ? () => api.undo(r.id) : undefined,
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
					}
					if (!fits(table, size)) setTooSmall({ placing: walkIn, table })
					else void seat(walkIn, table, false)
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
					})
				}}
			/>
			<BookingSheet
				open={bookingOpen}
				busy={busy}
				today={feed.businessDate}
				loadSlots={api.availability}
				onClose={() => setBookingOpen(false)}
				onBook={(input) =>
					void act(
						() => keyed(bookingKey, (key) => api.book(input, key)),
						_(
							t`Booked ${input.firstName} for ${input.partySize} at ${input.timeLabel}.`,
						),
					).then((ok) => ok && setBookingOpen(false))
				}
			/>
			<JoinWaitlistSheet
				open={joinOpen}
				busy={busy}
				onClose={() => setJoinOpen(false)}
				onJoin={(input) =>
					void act(
						() => keyed(joinKey, (key) => api.joinWaitlist(input, key)),
						_(t`${input.displayName} is on the waitlist.`),
					).then((ok) => ok && setJoinOpen(false))
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
