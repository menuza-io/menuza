import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { useEffect, useState } from 'react'
import {
	DEFAULT_TURN_MIN,
	shortName,
	type DayReservation,
	type DayTable,
	type TableState,
} from './feed.ts'
import {
	bigTableFor,
	freeForMin,
	heldFor,
	heldLead,
	runsIntoNext,
} from './held.ts'
import { OfflineNote } from './OfflineStrip.tsx'
import { type FloorSection } from './sections.ts'
import { SectionDot } from './SectionStrip.tsx'
import { PartySize } from './sheets.tsx'
import { Button, cn, Modal } from '~/ui/primitives.tsx'

/** A table free longer than this is simply free: the button does not say how long. */
const FREE_FOR_SAID_MIN = 180

/**
 * A table tapped outside of placing: who is there or due, and a walk-in for
 * it. A table held for a party due soon (or already late) leads with seating
 * that party there; a walk-in is the second choice, said with a caution.
 */
export function TableSheet({
	target,
	section = null,
	recent = [],
	busy,
	now,
	formatTime,
	onWalkIn,
	onSeatHeld,
	onFinish,
	onDetails,
	onClose,
	offlineReason = null,
}: {
	target: { table: DayTable; state: TableState } | null
	/** The table's server section this service, if the floor is split into sections. */
	section?: FloorSection | null
	/**
	 * Parties cleared from this table (finished or no-show) still inside the
	 * undo window: a mis-tap is put right from here once its toast is gone.
	 */
	recent?: DayReservation[]
	busy: boolean
	now: number
	formatTime: (epochMs: number) => string
	onWalkIn: (table: DayTable, partySize: number) => void
	/** Seat the party this table is held for, here (the booking's own seating flow). */
	onSeatHeld: (table: DayTable, reservation: DayReservation) => void
	onFinish: (reservation: DayReservation) => void
	onDetails: (reservation: DayReservation) => void
	onClose: () => void
	/** The connection is down: seating and clearing wait for it, and the sheet says so. */
	offlineReason?: string | null
}) {
	const { _ } = useLingui()
	const [size, setSize] = useState(2)
	/** A held table: the host chose to seat a walk-in anyway. */
	const [walkInAnyway, setWalkInAnyway] = useState(false)
	// A new table starts at two; the same table redrawn by a poll keeps the host's choice.
	const tableId = target?.table.id ?? null
	const maxCovers = target?.table.maxCovers ?? 2
	useEffect(() => {
		if (tableId) setSize(Math.min(maxCovers, 2))
		setWalkInAnyway(false)
		// eslint-disable-next-line react-hooks/exhaustive-deps -- reset per table only
	}, [tableId])
	const state = target?.state
	const next = state?.next ?? null
	const free = state ? state.kind === 'open' || state.kind === 'soon' : false
	// How long the table stays free: until its next booking (any time today), if there is one.
	const until = state && free && next ? next.startAt : null
	const nextWho = next ? shortName(next, _(msg`Guest`)) : ''
	const nextSize = next?.partySize ?? 0
	const untilText = until !== null ? formatTime(until) : ''
	const held = state ? heldFor(state, now) : null
	const heldWho = held ? shortName(held.reservation, _(msg`Guest`)) : ''
	const heldSize = held?.reservation.partySize ?? 0
	const heldDue = held ? formatTime(held.reservation.startAt) : ''
	const heldLate = held?.lateMin ?? 0
	const readyText = state?.kind === 'resetting' ? formatTime(state.readyAt) : ''
	const resetLeft =
		state?.kind === 'resetting'
			? Math.max(1, Math.ceil((state.readyAt - now) / 60_000))
			: 0
	// The held party leads only when they are here (or late): a party merely due
	// is not at the door, so the walk-in leads and seating them is second.
	const leadsWithParty = held !== null && heldLead(held) === 'party'
	const showWalkIn = !leadsWithParty || walkInAnyway
	// How long the table stays free, against the stay a walk-in is given: a walk-in that
	// would run into the next booking is a warning, and the booked party leads.
	const freeFor = target && state ? freeForMin(state, target.table, now) : null
	const tight = runsIntoNext(freeFor, DEFAULT_TURN_MIN)
	const partyFirst = held !== null && held.canSeat && !leadsWithParty && tight
	const seats = target?.table.maxCovers ?? 0
	const walkInWords =
		freeFor === null || freeFor > FREE_FOR_SAID_MIN
			? _(msg`Seat ${size} now`)
			: freeFor === 0
				? _(msg`Seat ${size} · due now`)
				: _(msg`Seat ${size} · free ${freeFor} min`)
	return (
		<Modal
			open={target !== null}
			onClose={onClose}
			title={target ? _(msg`Table ${target.table.label}`) : ''}
			// The walk-in's button (or the clear-table one) sits in the footer, so a
			// toast rising over the sheet never covers it.
			footer={
				target && state ? (
					state.kind === 'seated' ? (
						<div className="flex gap-3">
							<Button
								variant="primary"
								size="lg"
								className="min-w-0 flex-1"
								disabled={busy}
								onClick={() => onFinish(state.party)}
							>
								<Icon name="check-check" className="size-5" />
								<Trans>Finished, clear table</Trans>
							</Button>
							<Button size="lg" onClick={() => onDetails(state.party)}>
								<Trans>Details</Trans>
							</Button>
						</div>
					) : state.kind !== 'blocked' ? (
						leadsWithParty && held && !walkInAnyway ? (
							<div className="flex flex-col gap-3">
								<Button
									variant="primary"
									size="lg"
									className="w-full"
									disabled={busy}
									onClick={() => onSeatHeld(target.table, held.reservation)}
								>
									<Icon name="armchair" className="size-5 shrink-0" />
									<span className="truncate">
										<Trans>
											Seat <bdi>{heldWho}</bdi> here
										</Trans>
									</span>
								</Button>
								<Button
									variant="outline"
									size="lg"
									className="w-full"
									disabled={busy}
									onClick={() => setWalkInAnyway(true)}
								>
									<Trans>Seat a walk-in anyway</Trans>
								</Button>
							</div>
						) : (
							<div className="flex flex-col gap-3">
								{held ? (
									<p className="text-warning flex items-start gap-2 text-sm font-medium">
										<Icon
											name="alert-triangle"
											aria-hidden
											className="mt-0.5 size-4 shrink-0 self-start"
										/>
										<span>
											<Trans>
												<bdi>{heldWho}</bdi> is due at {heldDue}. A walk-in here
												may delay them.
											</Trans>
										</span>
									</p>
								) : null}
								{/* A booked party the table would be taken from leads, when a walk-in would run into them. */}
								{partyFirst && held ? (
									<Button
										variant="primary"
										size="lg"
										className="w-full"
										disabled={busy}
										onClick={() => onSeatHeld(target.table, held.reservation)}
									>
										<Icon name="armchair" className="size-5 shrink-0" />
										<span className="truncate">
											<Trans>
												Seat <bdi>{heldWho}</bdi> here
											</Trans>
										</span>
									</Button>
								) : null}
								<div className="flex gap-3">
									{leadsWithParty ? (
										<Button
											size="lg"
											className="shrink-0 px-4"
											onClick={() => setWalkInAnyway(false)}
										>
											<Trans>Back</Trans>
										</Button>
									) : null}
									<Button
										variant={tight ? 'outline' : 'primary'}
										size="lg"
										className={cn(
											'min-w-0 flex-1',
											tight &&
												'border-warning bg-warning/10 text-warning hover:bg-warning/20',
										)}
										disabled={busy}
										onClick={() => onWalkIn(target.table, size)}
									>
										<Icon
											name={tight ? 'alert-triangle' : 'armchair'}
											className="size-5 shrink-0"
										/>
										<span className="truncate">{walkInWords}</span>
									</Button>
								</div>
								{/* A party not here yet: seating them is the second choice. */}
								{held && !leadsWithParty && held.canSeat && !partyFirst ? (
									<Button
										variant="outline"
										size="lg"
										className="w-full"
										disabled={busy}
										onClick={() => onSeatHeld(target.table, held.reservation)}
									>
										<span className="truncate">
											<Trans>
												Seat <bdi>{heldWho}</bdi> here
											</Trans>
										</span>
									</Button>
								) : null}
							</div>
						)
					) : undefined
				) : undefined
			}
		>
			{target && state ? (
				<div className="flex flex-col gap-5 p-4 sm:p-5">
					<OfflineNote reason={offlineReason} />
					{section ? (
						<p className="flex items-center gap-2 text-sm">
							<SectionDot color={section.color} />
							<span className="font-medium">{section.name}</span>
							<span className="text-muted-foreground">·</span>
							{section.server ? (
								<span>{section.server.name}</span>
							) : (
								<span className="text-warning">
									<Trans>No server</Trans>
								</span>
							)}
						</p>
					) : null}
					{state.kind === 'seated' ? (
						<div className="flex flex-col gap-1 py-2">
							<p className="text-base font-semibold">
								{shortName(state.party, _(msg`Guest`))}
							</p>
							<p className="text-muted-foreground tnum">
								{state.party.seatedAt ? (
									<Trans>
										Party of {state.party.partySize}, seated{' '}
										{Math.max(
											0,
											Math.floor((now - state.party.seatedAt) / 60_000),
										)}{' '}
										min
									</Trans>
								) : (
									<Trans>Party of {state.party.partySize}</Trans>
								)}
							</p>
						</div>
					) : null}
					{state.kind === 'resetting' ? (
						<div className="flex items-start gap-3 py-2">
							<Icon
								name="refresh-cw"
								aria-hidden
								className="text-muted-foreground mt-1 size-5 shrink-0 self-start"
							/>
							<div className="flex min-w-0 flex-col gap-1">
								<p className="text-base font-semibold">
									<Trans>Resetting, ready {readyText}</Trans>
								</p>
								<p className="text-muted-foreground tnum">
									{_(
										plural(resetLeft, {
											one: '# min left. Seating someone now asks first.',
											other: '# min left. Seating someone now asks first.',
										}),
									)}
								</p>
							</div>
						</div>
					) : null}
					{state.kind === 'blocked' ? (
						<p className="text-muted-foreground">
							{state.reason ? (
								<Trans>Blocked: {state.reason}</Trans>
							) : (
								<Trans>This table is blocked right now.</Trans>
							)}
						</p>
					) : null}
					{recent.map((r) => {
						const who = shortName(r, _(msg`Guest`))
						return (
							<button
								key={r.id}
								type="button"
								onClick={() => onDetails(r)}
								className="hover:bg-accent flex min-h-14 items-center justify-between gap-3 rounded-(--station-control-radius) px-2 py-3 text-start transition-colors"
							>
								<span className="text-muted-foreground">
									{r.status === 'no_show'
										? _(msg`${who} marked as a no-show.`)
										: _(msg`${who} finished. Table cleared.`)}
								</span>
								<span className="flex shrink-0 items-center gap-2 font-semibold">
									<Icon name="undo-2" className="size-5" />
									<Trans>Undo</Trans>
								</span>
							</button>
						)
					})}
					{held ? (
						// Held for a party due soon, or already late: who, and how they stand.
						<button
							type="button"
							onClick={() => onDetails(held.reservation)}
							className="hover:bg-accent flex min-h-14 items-center justify-between gap-3 rounded-(--station-control-radius) px-2 py-3 text-start transition-colors"
						>
							<span className="min-w-0">
								<span className="block text-base font-semibold">
									<Trans>
										Held for{' '}
										<bdi>
											{heldWho} ({heldSize})
										</bdi>
									</Trans>
								</span>
								<span
									className={
										held.atStand || heldLate > 0
											? 'text-warning block font-medium'
											: 'text-muted-foreground block'
									}
								>
									{held.atStand ? (
										<Trans>At the stand</Trans>
									) : (
										<Trans>Due {heldDue}</Trans>
									)}
									{!held.atStand && heldLate > 0
										? ` · ${_(plural(heldLate, { one: '# min late', other: '# min late' }))}`
										: ''}
								</span>
							</span>
							<span className="text-muted-foreground shrink-0 text-sm font-semibold">
								<Trans>Details</Trans>
							</span>
						</button>
					) : free && next && until !== null ? (
						// What the table is good for: free until its next booking, and who that is.
						<button
							type="button"
							onClick={() => onDetails(next)}
							className="hover:bg-accent flex min-h-14 items-center justify-between gap-3 rounded-(--station-control-radius) px-2 py-3 text-start transition-colors"
						>
							<span className="min-w-0">
								<span className="block text-base font-semibold">
									{until > now ? (
										<Trans>Free until {untilText}</Trans>
									) : (
										<Trans>Due {untilText}</Trans>
									)}
								</span>
								<span className="text-muted-foreground block">
									<Trans>
										Then{' '}
										<bdi>
											{nextWho}, party of {nextSize}
										</bdi>
									</Trans>
								</span>
							</span>
							<span className="text-muted-foreground shrink-0 text-sm font-semibold">
								<Trans>Details</Trans>
							</span>
						</button>
					) : free ? (
						<p className="text-success text-base font-semibold">
							<Trans>Free for the rest of the day</Trans>
						</p>
					) : null}
					{!free && next ? (
						<button
							type="button"
							onClick={() => onDetails(next)}
							className="hover:bg-accent flex min-h-14 items-center justify-between gap-3 rounded-(--station-control-radius) px-2 py-3 text-start transition-colors"
						>
							<span>
								<span className="text-muted-foreground block text-sm">
									<Trans>Next booking</Trans>
								</span>
								<span className="font-semibold">
									<bdi>{nextWho}</bdi> ·{' '}
									<span className="tnum">{nextSize}</span>
								</span>
							</span>
							<span className="mono text-xl font-semibold">
								{formatTime(next.startAt)}
							</span>
						</button>
					) : null}
					{state.kind !== 'seated' && state.kind !== 'blocked' && showWalkIn ? (
						<div className="flex flex-col gap-3">
							<p className="font-semibold">
								<Trans>Seat a walk-in here</Trans>
							</p>
							<PartySize value={size} onChange={setSize} />
							{bigTableFor(size, target.table.maxCovers) ? (
								<p className="text-muted-foreground text-sm font-medium">
									<Trans>
										This table seats {seats}: a party of {size} leaves it mostly
										empty.
									</Trans>
								</p>
							) : null}
							{size > target.table.maxCovers ? (
								<p className="text-warning text-sm font-medium">
									<Trans>This table seats {target.table.maxCovers}.</Trans>
								</p>
							) : null}
						</div>
					) : null}
				</div>
			) : null}
		</Modal>
	)
}
