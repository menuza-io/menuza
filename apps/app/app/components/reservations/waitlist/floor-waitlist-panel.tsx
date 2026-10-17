import { Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { useState } from 'react'
import {
	type FloorTableRef,
	type OverbookPrompt,
} from '#app/components/reservations/waitlist/use-floor-waitlist.ts'
import {
	useFormatMinutes,
	WaitlistCountdown,
} from '#app/components/reservations/waitlist/waitlist-clock.tsx'
import { enumLabel } from '#app/utils/reservations/labels.ts'
import { type WaitlistEntry } from '#app/utils/reservations/waitlist-api.ts'
import {
	WAITLIST_STATUS_LABELS,
	waitlistStatusVariant,
} from '#app/utils/reservations/waitlist-view.ts'

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
	const { t, i18n } = useLingui()
	const formatMinutes = useFormatMinutes()
	const [open, setOpen] = useState(true)
	const count = entries.length
	const tableLabel = selectedTable?.label ?? ''

	return (
		<Card data-testid="floor-waitlist-panel">
			<CardHeader className="pb-2">
				<div className="flex items-center justify-between gap-2">
					<CardTitle className="text-sm font-semibold">
						<button
							type="button"
							className="flex items-center gap-1.5 text-start"
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
						</button>
					</CardTitle>
					<span className="text-muted-foreground text-[11px]">
						<Trans>Drag onto a table to seat</Trans>
					</span>
				</div>
			</CardHeader>
			<div role="status" aria-live="polite" className="sr-only">
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
											<Badge
												variant={waitlistStatusVariant(entry.status)}
												className="text-[10px]"
											>
												{enumLabel(
													(d) => i18n._(d),
													WAITLIST_STATUS_LABELS,
													entry.status,
												)}
											</Badge>
										</div>
									</div>
									<div className="flex flex-wrap items-center justify-between gap-1 text-[11px]">
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
													size="sm"
													variant="secondary"
													className="h-6 px-2 text-[11px]"
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
												size="sm"
												variant="outline"
												className="h-6 px-2 text-[11px]"
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

/** Shown when a waitlist party is dropped on a table that is taken or blocked: seat over it, or cancel. */
export function WaitlistOverbookPrompt({
	prompt,
	busy,
	onOverbook,
	onCancel,
}: {
	prompt: OverbookPrompt
	busy: boolean
	onOverbook: (reason: string) => void
	onCancel: () => void
}) {
	const { t } = useLingui()
	const [reason, setReason] = useState('')
	const guest = prompt.entry.displayName
	const size = prompt.entry.partySize
	const tableLabel = prompt.table.label
	return (
		<Card
			className="border-amber-500 bg-amber-500/10 p-4"
			role="alertdialog"
			aria-label={t`Table ${tableLabel} is not free`}
			data-testid="floor-waitlist-overbook-prompt"
		>
			<div className="flex flex-col gap-3">
				<div className="flex items-start justify-between gap-2">
					<div>
						<h3 className="text-sm font-semibold">
							<Trans>Table {tableLabel} is not free for this party</Trans>
						</h3>
						<p className="text-muted-foreground text-xs">
							<Trans>
								{guest} ({size}) can be seated there anyway, on top of the
								booking or block. A waitlist party cannot swap places with
								another party.
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
					<Input
						value={reason}
						onChange={(event) => setReason(event.target.value)}
						placeholder={t`Overbook reason (optional)`}
						aria-label={t`Overbook reason (optional)`}
						className="h-8 w-56 text-xs"
						data-testid="floor-waitlist-overbook-reason"
					/>
					<Button
						type="button"
						size="sm"
						disabled={busy}
						onClick={() => onOverbook(reason)}
						data-testid="floor-waitlist-overbook-confirm"
					>
						<Icon name="alert-triangle" className="me-1.5 size-3.5" />
						<Trans>Seat anyway</Trans>
					</Button>
				</div>
			</div>
		</Card>
	)
}
