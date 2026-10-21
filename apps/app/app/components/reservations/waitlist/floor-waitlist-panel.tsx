import { Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { useState } from 'react'
import { StatusLabel } from '#app/components/reservations/status-style.tsx'
import {
	type FloorTableRef,
	type OverbookPrompt,
	type SeatChoice,
} from '#app/components/reservations/waitlist/use-floor-waitlist.ts'
import {
	useFormatMinutes,
	WaitlistCountdown,
} from '#app/components/reservations/waitlist/waitlist-clock.tsx'
import { type WaitlistEntry } from '#app/utils/reservations/waitlist-api.ts'

/** The drag payload type; floor tables read it on drop. */
export const WAITLIST_DRAG_TYPE = 'text/waitlist-id'

/** Collapsible live queue beside the floor plan. Cards drag onto tables; buttons do the same without a pointer. */
export function FloorWaitlistPanel({
	entries,
	loading,
	error,
	dragging,
	busyId,
	selectedTable,
	clockOffsetMs,
	announcement,
	onDragStart,
	onDragEnd,
	onSeatAtSelected,
	onChooseTable,
}: {
	entries: readonly WaitlistEntry[]
	loading: boolean
	error: string | null
	dragging: boolean
	busyId: string | null
	selectedTable: FloorTableRef | null
	clockOffsetMs: number
	announcement: string
	onDragStart: (entry: WaitlistEntry) => void
	onDragEnd: () => void
	onSeatAtSelected: (entry: WaitlistEntry, table: FloorTableRef) => void
	onChooseTable: (entry: WaitlistEntry) => void
}) {
	const { t } = useLingui()
	const formatMinutes = useFormatMinutes()
	const [open, setOpen] = useState(true)
	const count = entries.length
	const tableLabel = selectedTable?.label ?? ''

	return (
		<Card data-testid="floor-waitlist-panel">
			<CardHeader className="pb-2">
				<div className="flex items-center justify-between gap-2">
					<CardTitle className="text-sm font-semibold">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="-ms-2 h-11 gap-1.5 text-start md:h-7"
							aria-expanded={open}
							aria-controls="floor-waitlist-body"
							onClick={() => setOpen((value) => !value)}
							data-testid="floor-waitlist-toggle"
						>
							<Icon
								name={open ? 'chevron-down' : 'chevron-right'}
								className="size-4 rtl:rotate-180"
							/>
							<Trans>Waitlist</Trans>
							<Badge variant="secondary" data-testid="floor-waitlist-count">
								{count}
							</Badge>
						</Button>
					</CardTitle>
					<span className="text-muted-foreground text-2xs">
						<Trans>Drag onto a table to seat</Trans>
					</span>
				</div>
			</CardHeader>
			<div
				role="status"
				aria-live="polite"
				className="sr-only"
				data-testid="floor-waitlist-announcement"
			>
				{announcement}
			</div>
			{open ? (
				<CardContent
					id="floor-waitlist-body"
					className="flex max-h-[320px] flex-col gap-2 overflow-y-auto"
				>
					{error && count === 0 ? (
						<p
							className="text-destructive py-4 text-center text-xs"
							data-testid="floor-waitlist-error"
						>
							{error}
						</p>
					) : loading && count === 0 ? (
						<p className="text-muted-foreground py-4 text-center text-xs">
							<Trans>Loading the waitlist...</Trans>
						</p>
					) : count === 0 ? (
						<p
							className="text-muted-foreground py-4 text-center text-xs"
							data-testid="floor-waitlist-empty"
						>
							<Trans>Nobody is waiting right now.</Trans>
						</p>
					) : (
						entries.map((entry) => {
							const guest = entry.displayName
							const quoted =
								entry.quotedMin === null ? null : formatMinutes(entry.quotedMin)
							return (
								<div
									key={entry.id}
									draggable
									onDragStart={(event) => {
										event.dataTransfer.setData(WAITLIST_DRAG_TYPE, entry.id)
										event.dataTransfer.effectAllowed = 'move'
										onDragStart(entry)
									}}
									onDragEnd={onDragEnd}
									data-testid={`floor-waitlist-card-${entry.id}`}
									className={cn(
										'border-border bg-card hover:border-primary/50 flex cursor-grab flex-col gap-1.5 rounded-lg border p-2.5 transition-colors active:cursor-grabbing',
										dragging && 'opacity-90',
									)}
								>
									<div className="flex items-start justify-between gap-2">
										<span className="text-xs font-semibold wrap-anywhere">
											#{entry.position} {guest} ({entry.partySize})
										</span>
										<div className="flex flex-wrap items-center gap-1">
											<WaitlistCountdown
												entry={entry}
												offsetMs={clockOffsetMs}
											/>
											<StatusLabel kind="waitlist" status={entry.status} />
										</div>
									</div>
									<div className="flex flex-wrap items-center justify-between gap-1 text-xs">
										<span className="text-muted-foreground">
											{quoted ? (
												<Trans>Quoted {quoted}</Trans>
											) : (
												<Trans>No quote</Trans>
											)}
										</span>
										<span className="flex items-center gap-1">
											{selectedTable ? (
												<Button
													type="button"
													variant="secondary"
													className="h-11 md:h-8"
													disabled={busyId === entry.id}
													aria-label={t`Seat ${guest} at ${tableLabel}`}
													onClick={() => onSeatAtSelected(entry, selectedTable)}
													data-testid={`floor-waitlist-seat-selected-${entry.id}`}
												>
													{t`Seat at ${tableLabel}`}
												</Button>
											) : null}
											<Button
												type="button"
												variant="outline"
												className="h-11 md:h-8"
												disabled={busyId === entry.id}
												aria-label={t`Choose a table for ${guest}`}
												onClick={() => onChooseTable(entry)}
												data-testid={`floor-waitlist-choose-${entry.id}`}
											>
												<Trans>Seat at...</Trans>
											</Button>
										</span>
									</div>
								</div>
							)
						})
					)}
				</CardContent>
			) : null}
		</Card>
	)
}

/**
 * Shown when the server refuses a waitlist party's table because it is taken.
 * It offers only the resolutions the server named: swap places with a party
 * that has not arrived, move that party to a free table, or seat on top.
 */
export function WaitlistSeatPrompt({
	prompt,
	busy,
	onChoose,
	onCancel,
}: {
	prompt: OverbookPrompt
	busy: boolean
	onChoose: (choice: SeatChoice) => void
	onCancel: () => void
}) {
	const { t } = useLingui()
	const [reason, setReason] = useState('')
	const guest = prompt.entry.displayName
	const size = prompt.entry.partySize
	const tableLabel = prompt.table.label
	const resolutions = prompt.conflict?.resolutions ?? ['overbook']
	const occupants = prompt.conflict?.occupants ?? []
	return (
		<Card
			className="border-warning/50 bg-warning/10 p-4"
			role="alertdialog"
			aria-label={t`Table ${tableLabel} is not free`}
			data-testid="floor-waitlist-overbook-prompt"
		>
			<div className="flex flex-col gap-3">
				<div className="flex items-start justify-between gap-2">
					<div className="flex flex-col gap-1">
						<h3 className="text-sm font-semibold">
							<Trans>Table {tableLabel} is not free for this party</Trans>
						</h3>
						{occupants.map((occupant, index) => (
							<p
								key={occupant.reservationId ?? `${occupant.kind}-${index}`}
								className="text-muted-foreground text-xs"
								data-testid="floor-waitlist-occupant"
							>
								<OccupantLine occupant={occupant} />
							</p>
						))}
						<p className="text-muted-foreground text-xs">
							<Trans>
								Choose how to seat {guest} ({size}) at table {tableLabel}.
							</Trans>
						</p>
					</div>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={onCancel}
						data-testid="floor-waitlist-overbook-cancel"
					>
						<Trans>Cancel</Trans>
					</Button>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{resolutions.includes('swap') ? (
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() => onChoose({ resolution: 'swap' })}
							data-testid="floor-waitlist-resolve-swap"
						>
							<Icon name="refresh-cw" />
							<Trans>Swap: unseat the booking</Trans>
						</Button>
					) : null}
					{resolutions.includes('move') ? (
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() => onChoose({ resolution: 'move' })}
							data-testid="floor-waitlist-resolve-move"
						>
							<Icon name="move-up-right" />
							<Trans>Move the booking to a free table</Trans>
						</Button>
					) : null}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Input
						value={reason}
						onChange={(event) => setReason(event.target.value)}
						placeholder={t`Overbook reason (optional)`}
						aria-label={t`Overbook reason (optional)`}
						className="h-11 w-56 md:h-8"
						data-testid="floor-waitlist-overbook-reason"
					/>
					<Button
						type="button"
						size="sm"
						disabled={busy}
						onClick={() => onChoose({ resolution: 'overbook', reason })}
						data-testid="floor-waitlist-overbook-confirm"
					>
						<Icon name="alert-triangle" />
						<Trans>Overbook: seat anyway</Trans>
					</Button>
				</div>
			</div>
		</Card>
	)
}

function OccupantLine({
	occupant,
}: {
	occupant: NonNullable<OverbookPrompt['conflict']>['occupant']
}) {
	const name = occupant.guestName
	const size = occupant.partySize
	const codeSuffix = occupant.confirmationCode
		? ` · ${occupant.confirmationCode}`
		: ''
	if (occupant.kind === 'block') return <Trans>The table is blocked.</Trans>
	if (occupant.kind === 'hold') return <Trans>The table is on hold.</Trans>
	if (name && size) {
		return (
			<Trans>
				Booked by {name} ({size}){codeSuffix}.
			</Trans>
		)
	}
	if (size) {
		return (
			<Trans>
				Booked by a party of {size}
				{codeSuffix}.
			</Trans>
		)
	}
	return <Trans>The table is booked.</Trans>
}
