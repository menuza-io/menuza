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
import { useCallback, useMemo, useState } from 'react'
import { HostApiError } from './api.ts'
import { Dock, placingSize, type Placing } from './Dock.tsx'
import {
	DEFAULT_TURN_MIN,
	arrivals,
	rooms,
	shortName,
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
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'
import { Toast, type ToastMessage } from '~/ui/motion.tsx'
import { Button, cn, NumberPop, Reveal, Segmented } from '~/ui/primitives.tsx'

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
	const [tableTarget, setTableTarget] = useState<{
		table: DayTable
		state: TableState
	} | null>(null)
	const [walkInOpen, setWalkInOpen] = useState(false)
	const [bookingOpen, setBookingOpen] = useState(false)
	const [joinOpen, setJoinOpen] = useState(false)
	const [busy, setBusy] = useState(false)
	const [toast, setToast] = useState<ToastMessage | null>(null)
	const dismissToast = useCallback(() => setToast(null), [])
	const say = useCallback(
		(text: string, extra: Partial<ToastMessage> = {}) =>
			setToast({ id: Date.now(), text, ...extra }),
		[],
	)

	const ready = state.status === 'ready' ? state : null
	const feed = ready?.feed ?? null
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
	const due = useMemo(() => (feed ? arrivals(feed) : []), [feed])
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
			anyway?: () => void,
		) => {
			setBusy(true)
			try {
				await work()
				say(
					done,
					undo
						? {
								action: {
									label: _(t`Undo`),
									run: () => {
										void (async () => {
											try {
												await undo()
												await refresh({ full: true })
												say(_(t`Undone.`))
											} catch {
												say(_(t`Could not undo. Check the floor.`), {
													tone: 'danger',
												})
											}
										})()
									},
								},
							}
						: {},
				)
				return true
			} catch (error) {
				const failure = error instanceof HostApiError ? error : null
				if (failure?.occupied && anyway) {
					say(
						_(
							t`Someone is booked on that table before this party would be done.`,
						),
						{
							tone: 'danger',
							action: { label: _(t`Seat anyway`), run: anyway },
						},
					)
					return false
				}
				say(
					failure?.stale
						? _(t`Someone changed this a moment ago. Here is the latest.`)
						: failure?.offline
							? _(t`No connection. Nothing was changed.`)
							: failure?.serverMessage ||
								_(t`That did not go through. Try again.`),
					{ tone: 'danger' },
				)
				return false
			} finally {
				await refresh({ full: true })
				setBusy(false)
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
		await seat(current, table, false)
	}

	/** Seats a party; when the table is booked soon, the host may insist (overbook). */
	const seat = async (current: Placing, table: DayTable, insist: boolean) => {
		const overbook = insist
			? { overbook: true, overbookReason: _(t`Seated at the host stand`) }
			: {}
		const again = insist ? undefined : () => void seat(current, table, true)
		if (current.kind === 'reservation') {
			const r = current.reservation
			const who = shortName(r, _(t`Guest`))
			await act(
				() =>
					api.transition(r.id, 'seated', {
						tableIds: [table.id],
						// A retry follows a refusal: the version is still the one we saw.
						expectedVersion: r.version,
						...overbook,
					}),
				_(t`Seated ${who} at ${table.label}.`),
				() => api.undo(r.id),
				again,
			)
		} else if (current.kind === 'waitlist') {
			const entry = current.entry
			await act(
				() => api.seatWaitlist(entry.id, [table.id], entry.version, overbook),
				_(t`Seated ${entry.displayName} at ${table.label}.`),
				undefined,
				again,
			)
		} else {
			const size = current.partySize
			await act(
				() =>
					api.walkIn({
						partySize: size,
						tableIds: [table.id],
						guestName: current.guestName,
						...overbook,
					}),
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
				{ready.stale ? (
					<span className="text-warning inline-flex items-center gap-1.5 text-sm font-medium">
						<CloudOff className="size-4" />
						<Trans>Not up to date</Trans>
					</span>
				) : null}
				<div className="ms-auto flex flex-wrap items-center gap-2">
					<Button variant="outline" onClick={() => setWalkInOpen(true)}>
						<UserPlus className="size-4" />
						<Trans>Walk-in</Trans>
					</Button>
					{ready.grant.features.waitlist ? (
						<Button variant="outline" onClick={() => setJoinOpen(true)}>
							<ListPlus className="size-4" />
							<span className="hidden sm:inline">
								<Trans>Waitlist</Trans>
							</span>
						</Button>
					) : null}
					<Button variant="primary" onClick={() => setBookingOpen(true)}>
						<CalendarPlus className="size-4" />
						<Trans>Booking</Trans>
					</Button>
				</div>
			</div>

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
						else setTableTarget({ table, state: tableState })
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
				arrivals={due}
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
				onClose={() => setTableTarget(null)}
				onDetails={(r) => {
					setTableTarget(null)
					setPartyId(r.id)
				}}
				onFinish={(r) => {
					setTableTarget(null)
					void onCommand(r, { kind: 'status', to: 'finished' })
				}}
				onWalkIn={(table, size) => {
					setTableTarget(null)
					void seat(
						{ kind: 'walk_in', partySize: size, guestName: '' },
						table,
						false,
					)
				}}
			/>
			<WalkInSheet
				open={walkInOpen}
				onClose={() => setWalkInOpen(false)}
				onPlace={(partySize, guestName) => {
					setWalkInOpen(false)
					setPlacing({ kind: 'walk_in', partySize, guestName })
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
						() => api.book({ ...input, notes: null }),
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
						() => api.joinWaitlist(input),
						_(t`${input.displayName} is on the waitlist.`),
					).then((ok) => ok && setJoinOpen(false))
				}
			/>
			<Toast message={toast} onDone={dismissToast} />
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
	} else if (
		[
			'reservations_not_enabled',
			'reservations_disabled',
			'location_required',
			'sign_in_required',
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
