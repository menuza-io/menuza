import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	Armchair,
	CheckCheck,
	RefreshCw,
	TriangleAlert,
	Undo2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import {
	shortName,
	type DayReservation,
	type DayTable,
	type TableState,
} from './feed.ts'
import { heldFor, heldLead } from './held.ts'
import { PartySize } from './sheets.tsx'
import { Button, Modal } from '~/ui/primitives.tsx'

/**
 * A table tapped outside of placing: who is there or due, and a walk-in for
 * it. A table held for a party due soon (or already late) leads with seating
 * that party there; a walk-in is the second choice, said with a caution.
 */
export function TableSheet({
	target,
	recent = [],
	busy,
	now,
	formatTime,
	onWalkIn,
	onSeatHeld,
	onFinish,
	onDetails,
	onClose,
}: {
	target: { table: DayTable; state: TableState } | null
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
						<div className="mb-safe flex gap-3">
							<Button
								variant="primary"
								size="lg"
								className="min-w-0 flex-1"
								disabled={busy}
								onClick={() => onFinish(state.party)}
							>
								<CheckCheck className="size-5" />
								<Trans>Finished, clear table</Trans>
							</Button>
							<Button size="lg" onClick={() => onDetails(state.party)}>
								<Trans>Details</Trans>
							</Button>
						</div>
					) : state.kind !== 'blocked' ? (
						leadsWithParty && held && !walkInAnyway ? (
							<div className="mb-safe flex flex-col gap-3">
								<Button
									variant="primary"
									size="lg"
									className="w-full"
									disabled={busy}
									onClick={() => onSeatHeld(target.table, held.reservation)}
								>
									<Armchair className="size-5 shrink-0" />
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
							<div className="mb-safe flex flex-col gap-3">
								{held ? (
									<p className="text-warning flex items-start gap-2 text-sm font-medium">
										<TriangleAlert
											aria-hidden
											className="mt-0.5 size-4 shrink-0"
										/>
										<span>
											<Trans>
												<bdi>{heldWho}</bdi> is due at {heldDue}. A walk-in here
												may delay them.
											</Trans>
										</span>
									</p>
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
										variant="primary"
										size="lg"
										className="min-w-0 flex-1"
										disabled={busy}
										onClick={() => onWalkIn(target.table, size)}
									>
										<Armchair className="size-5 shrink-0" />
										<Trans>Seat {size} now</Trans>
									</Button>
								</div>
								{/* A party not here yet: seating them is the second choice. */}
								{held && !leadsWithParty && held.canSeat ? (
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
					{state.kind === 'seated' ? (
						<div className="border-border flex flex-col gap-1 rounded-2xl border p-4">
							<p className="text-lg font-semibold">
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
						<div className="border-border flex items-start gap-3 rounded-2xl border p-4">
							<RefreshCw
								aria-hidden
								className="text-muted-foreground mt-1 size-5 shrink-0"
							/>
							<div className="flex min-w-0 flex-col gap-1">
								<p className="text-lg font-semibold">
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
								className="border-border hover:bg-accent flex items-center justify-between gap-3 rounded-2xl border p-4 text-start transition-colors"
							>
								<span className="text-muted-foreground">
									{r.status === 'no_show'
										? _(msg`${who} marked as a no-show.`)
										: _(msg`${who} finished. Table cleared.`)}
								</span>
								<span className="flex shrink-0 items-center gap-2 font-semibold">
									<Undo2 className="size-5" />
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
							className="border-border hover:bg-accent flex items-center justify-between gap-3 rounded-2xl border p-4 text-start transition-colors"
						>
							<span className="min-w-0">
								<span className="block text-lg font-semibold">
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
							className="border-border hover:bg-accent flex items-center justify-between gap-3 rounded-2xl border p-4 text-start transition-colors"
						>
							<span className="min-w-0">
								<span className="block text-lg font-semibold">
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
						<p className="text-success text-lg font-semibold">
							<Trans>Free for the rest of the day</Trans>
						</p>
					) : null}
					{!free && next ? (
						<button
							type="button"
							onClick={() => onDetails(next)}
							className="border-border hover:bg-accent flex items-center justify-between gap-3 rounded-2xl border p-4 text-start transition-colors"
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
