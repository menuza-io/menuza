import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { seatSummary, type SeatGroup } from './combine.ts'
import { type DayTable } from './feed.ts'
import { Button, cn } from '~/ui/primitives.tsx'

/**
 * The bar over the floor while a party is in hand: which party, and what to do
 * with the tables. Tap a table to seat them; or "Combine tables" to join
 * several for a large party, with the chosen tables as chips (each can be
 * taken out again) and one "Seat" for the lot. Always the same bar, so a host
 * never loses where they are.
 */
export function PickBar({
	name,
	partySize,
	covers,
	wholeParty,
	joined,
	canCombine,
	forced,
	onCombine,
	onSeatJoined,
	onRemoveTable,
	onBackToOne,
	onCancel,
}: {
	name: string
	partySize: number
	/** Only this many of the party are being seated (the rest follow), or null for the whole party. */
	covers: number | null
	/** How many are in the whole party (for "3 of 5"). */
	wholeParty: number
	/** The tables joined so far (null: not joining, a tap seats at one table). */
	joined: DayTable[] | null
	/** Joining tables is on offer here (the "no table fits" offer says it already when it shows). */
	canCombine: boolean
	/** The host chose to seat them at a table too small: any open table can be tapped. */
	forced: boolean
	onCombine: () => void
	onSeatJoined: () => void
	onRemoveTable: (tableId: string) => void
	onBackToOne: () => void
	onCancel: () => void
}) {
	const { _ } = useLingui()
	const sum = joined ? seatSummary(joined, partySize) : null
	const labels = joined ? joined.map((t) => t.label).join(' + ') : ''
	const seats = sum?.seats ?? 0
	const short = sum?.short ?? 0
	const ghost =
		'text-primary-foreground hover:bg-primary-foreground/15 max-sm:px-3'
	// On a phone every line counts (the floor needs the room): the words of a
	// button give way to its icon, and the lines are title, then chips, then Seat.
	return (
		<div className="bg-primary text-primary-foreground flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 max-sm:gap-x-2 max-sm:py-2">
			{joined === null ? (
				<>
					<p className="min-w-0 flex-1 font-semibold max-sm:text-sm">
						{forced ? (
							<Trans>
								Tap any open table for {name}, party of {partySize}
							</Trans>
						) : covers !== null ? (
							<Trans>
								Tap a table for {name}: {covers} of {wholeParty}
							</Trans>
						) : (
							<Trans>
								Tap a table for {name}, party of {partySize}
							</Trans>
						)}
					</p>
					{canCombine ? (
						<Button
							variant="ghost"
							onClick={onCombine}
							aria-label={_(msg`Combine tables`)}
							className={ghost}
						>
							<Icon name="layers" aria-hidden className="size-4" />
							<span className="max-sm:sr-only">
								<Trans>Combine tables</Trans>
							</span>
						</Button>
					) : null}
				</>
			) : (
				<>
					<p className="min-w-0 font-semibold max-sm:order-1 max-sm:flex-1 max-sm:text-sm">
						{covers !== null ? (
							<Trans>
								Combine tables for {name}: {covers} of {wholeParty}
							</Trans>
						) : (
							<Trans>
								Combine tables for {name}, party of {partySize}
							</Trans>
						)}
					</p>
					{joined.length === 0 ? (
						<p className="text-primary-foreground/85 text-sm max-sm:order-4 max-sm:basis-full sm:flex-1">
							<Trans>Tap a free table, then one beside it.</Trans>
						</p>
					) : (
						<ul
							aria-label={_(msg`Chosen tables`)}
							className="flex flex-wrap items-center gap-1.5 max-sm:order-4 max-sm:basis-full sm:flex-1"
						>
							{joined.map((table) => (
								<li key={table.id}>
									<button
										type="button"
										onClick={() => onRemoveTable(table.id)}
										aria-label={_(msg`Take table ${table.label} out`)}
										className="bg-primary-foreground/15 hover:bg-primary-foreground/25 inline-flex min-h-9 items-center gap-1.5 rounded-full ps-3 pe-2 text-sm font-semibold"
									>
										<span className="mono">{table.label}</span>
										<Icon name="x" aria-hidden className="size-4" />
									</button>
								</li>
							))}
						</ul>
					)}
					{joined.length > 0 ? (
						<p
							className="bg-primary-foreground/15 tnum rounded-full px-3 py-1 text-sm font-semibold max-sm:order-5 max-sm:min-w-0 max-sm:flex-1"
							data-short={!sum?.ok}
						>
							{sum?.ok ? (
								<Trans>
									Seat {partySize} at {labels} ({seats} seats)
								</Trans>
							) : (
								_(
									plural(short, {
										one: `${labels}: seats ${seats}, needs # more seat`,
										other: `${labels}: seats ${seats}, needs # more seats`,
									}),
								)
							)}
						</p>
					) : null}
					<Button
						variant="outline"
						disabled={!sum?.ok}
						onClick={onSeatJoined}
						className="bg-primary-foreground text-primary hover:bg-primary-foreground/90 disabled:opacity-60 max-sm:order-6"
					>
						<Icon name="armchair" aria-hidden className="size-4" />
						<Trans>Seat</Trans>
					</Button>
					<Button
						variant="ghost"
						onClick={onBackToOne}
						className={cn(ghost, 'max-sm:order-2')}
					>
						<Trans>One table</Trans>
					</Button>
				</>
			)}
			<Button
				variant="ghost"
				onClick={onCancel}
				aria-label={_(msg`Cancel`)}
				className={cn(ghost, joined !== null && 'max-sm:order-3')}
			>
				<Icon name="x" className="size-4" />
				<span className="max-sm:sr-only">
					<Trans>Cancel</Trans>
				</span>
			</Button>
		</div>
	)
}

/**
 * Nothing seats the party alone: said calmly, with what can be done about it.
 * Join tables (starting from the best group), put them on the waitlist with the
 * wait they would be quoted, or seat them anyway at a table too small.
 */
export function NoFitBanner({
	partySize,
	biggest,
	tooBig,
	group,
	quoteMin,
	canWaitlist,
	onCombine,
	onWaitlist,
	onAnyway,
}: {
	partySize: number
	/** The most any single table seats. */
	biggest: number
	/** The party is bigger than any single table (else the tables are only busy). */
	tooBig: boolean
	/** The best free group to join, or null when none seats them. */
	group: SeatGroup | null
	/** The wait a party this size would be quoted now (null: not known or none). */
	quoteMin: number | null
	/** A party with no table may be put on the waitlist (a walk-in, not a booking). */
	canWaitlist: boolean
	onCombine: () => void
	onWaitlist: () => void
	onAnyway: () => void
}) {
	const { _ } = useLingui()
	return (
		<div className="bg-warning/10 text-foreground flex flex-col gap-2 px-4 py-3 max-sm:gap-1.5 max-sm:py-2">
			<p className="font-semibold max-sm:text-sm">
				{tooBig ? (
					<>
						<Trans>No single table seats {partySize}.</Trans>{' '}
						<span className="text-muted-foreground font-medium">
							<Trans>The biggest seats {biggest}.</Trans>
						</span>
					</>
				) : (
					<Trans>No table is free for {partySize} right now.</Trans>
				)}
			</p>
			<div className="flex flex-wrap items-center gap-2 max-sm:gap-1.5 max-sm:[&>button]:h-10 max-sm:[&>button]:px-3 max-sm:[&>button]:text-sm">
				<Button variant="primary" disabled={!group} onClick={onCombine}>
					<Icon name="layers" aria-hidden className="size-4" />
					{group ? (
						<Trans>Combine tables</Trans>
					) : (
						<Trans>No free tables to combine</Trans>
					)}
				</Button>
				{canWaitlist ? (
					<Button variant="outline" onClick={onWaitlist}>
						<Icon name="list-plus" aria-hidden className="size-4" />
						{quoteMin !== null ? (
							<>
								<span className="max-sm:hidden">
									{_(
										plural(quoteMin, {
											one: 'Put on the waitlist, quote about # min',
											other: 'Put on the waitlist, quote about # min',
										}),
									)}
								</span>
								{/* A phone has no room for the whole sentence. */}
								<span className="sm:hidden">
									{_(
										plural(quoteMin, {
											one: 'Waitlist, about # min',
											other: 'Waitlist, about # min',
										}),
									)}
								</span>
							</>
						) : (
							<Trans>Put on the waitlist</Trans>
						)}
					</Button>
				) : null}
				{tooBig ? (
					// Only a party bigger than every table is seated "anyway" at a small one: a busy
					// floor is not helped by it (a table booked soon is tapped, and asked about).
					<Button variant="outline" onClick={onAnyway}>
						<Trans>Seat anyway at…</Trans>
					</Button>
				) : null}
			</div>
		</div>
	)
}
