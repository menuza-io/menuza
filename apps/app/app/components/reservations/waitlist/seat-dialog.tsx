import { Trans, useLingui } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { useEffect, useMemo, useState } from 'react'
import { type WaitlistActionResult } from '#app/components/reservations/waitlist/use-waitlist.ts'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import {
	type DayReservationView,
	type LiveTableState,
} from '#app/utils/reservations/book-api.ts'
import {
	enumLabel,
	LIVE_TABLE_STATUS_LABELS,
} from '#app/utils/reservations/labels.ts'
import {
	type SeatWaitlistInput,
	type WaitlistEntry,
	type WaitlistSeatConflict,
} from '#app/utils/reservations/waitlist-api.ts'
import { tableCandidates } from '#app/utils/reservations/waitlist-view.ts'

/** `SelectField` cannot hold an empty value, so auto-assign travels as this key. */
const AUTO_TABLE = 'auto'

type SeatResult = WaitlistActionResult<{
	entry: WaitlistEntry
	reservation: DayReservationView | null
}>

export function SeatDialog({
	entry,
	onClose,
	tableStates,
	tablesLoading = false,
	onOpened,
	initialTableId = null,
	onSeat,
}: {
	entry: WaitlistEntry | null
	onClose: () => void
	tableStates: readonly LiveTableState[]
	tablesLoading?: boolean
	/** Called when the dialog opens, so the caller can load fresh table states. */
	onOpened?: () => void
	initialTableId?: string | null
	onSeat: (
		entry: WaitlistEntry,
		input: Omit<SeatWaitlistInput, 'expectedVersion'>,
	) => Promise<SeatResult>
}) {
	const { t, i18n } = useLingui()
	const [tableId, setTableId] = useState('')
	const [overbook, setOverbook] = useState(false)
	const [reason, setReason] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [blocked, setBlocked] = useState(false)
	const [conflict, setConflict] = useState<WaitlistSeatConflict | null>(null)

	const entryId = entry?.id ?? null
	useEffect(() => {
		if (!entryId) return
		setTableId(initialTableId ?? '')
		setOverbook(false)
		setReason('')
		setError(null)
		setBlocked(false)
		setConflict(null)
		setSubmitting(false)
		onOpened?.()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [entryId, initialTableId])

	const partySize = entry?.partySize ?? 1
	const candidates = useMemo(
		() => tableCandidates(tableStates, partySize),
		[partySize, tableStates],
	)
	const tableOptions = [
		{ value: AUTO_TABLE, label: t`Auto-assign best open table` },
		...candidates.map(({ table, fits }) => {
			const status = enumLabel(
				(d) => i18n._(d),
				LIVE_TABLE_STATUS_LABELS,
				table.status,
			)
			const range = `${table.minCovers}-${table.maxCovers}`
			const mismatch = fits ? '' : ` - ${t`Size mismatch`}`
			return {
				value: table.tableId,
				label: `${table.label} (${range}) - ${status}${mismatch}`,
			}
		}),
	]
	const selected = candidates.find((c) => c.table.tableId === tableId)
	const needsOverbook = Boolean(selected && !selected.free)
	const showOverbook = needsOverbook || blocked

	const submit = async (resolution?: 'swap' | 'move') => {
		if (!entry || submitting) return
		if (!resolution && overbook && !reason.trim()) {
			setError(t`Add a reason to seat this party over a booking.`)
			return
		}
		setSubmitting(true)
		setError(null)
		const result = await onSeat(entry, {
			...(tableId ? { tableIds: [tableId] } : {}),
			...(resolution ? { resolution } : {}),
			...(!resolution && overbook
				? { overbook: true, overbookReason: reason.trim() }
				: {}),
		})
		setSubmitting(false)
		if (result.ok) {
			onClose()
			return
		}
		setError(result.message)
		setConflict(result.conflict ?? null)
		if (
			result.code === 'table_occupied' ||
			result.code === 'no_availability' ||
			result.code === 'missing_overbook_reason'
		) {
			setBlocked(true)
		}
	}

	const handleSubmit = (event: React.FormEvent) => {
		event.preventDefault()
		void submit()
	}

	const resolutions = conflict?.resolutions ?? []
	const guest = entry?.displayName ?? ''

	return (
		<Dialog
			open={entry !== null}
			onOpenChange={(next) => {
				if (!next) onClose()
			}}
		>
			<DialogContent className="sm:max-w-md" data-testid="waitlist-seat-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>
							Seat {guest} ({partySize})
						</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Pick a table, or let the system choose the best open one.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSubmit} className="flex flex-col gap-5">
					{error ? (
						<Alert variant="destructive" data-testid="waitlist-seat-error">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					<SelectField
						id="waitlist-seat-table"
						label={<Trans>Table</Trans>}
						options={tableOptions}
						value={tableId || AUTO_TABLE}
						onValueChange={(next) =>
							setTableId(next === AUTO_TABLE ? '' : next)
						}
						hint={tablesLoading ? <Trans>Loading tables...</Trans> : undefined}
					/>

					{showOverbook ? (
						<div
							className="border-warning/40 bg-warning/10 flex flex-col gap-3 rounded-lg border p-3 text-sm"
							data-testid="waitlist-seat-overbook"
						>
							{resolutions.includes('swap') || resolutions.includes('move') ? (
								<div className="flex flex-wrap gap-2">
									{resolutions.includes('swap') ? (
										<Button
											type="button"
											variant="outline"
											className="h-11 md:h-8"
											disabled={submitting}
											onClick={() => void submit('swap')}
											data-testid="waitlist-seat-swap"
										>
											<Trans>Swap: unseat the booking</Trans>
										</Button>
									) : null}
									{resolutions.includes('move') ? (
										<Button
											type="button"
											variant="outline"
											className="h-11 md:h-8"
											disabled={submitting}
											onClick={() => void submit('move')}
											data-testid="waitlist-seat-move"
										>
											<Trans>Move the booking to a free table</Trans>
										</Button>
									) : null}
								</div>
							) : null}
							<label className="flex min-h-11 items-start gap-2.5">
								<Checkbox
									checked={overbook}
									onCheckedChange={setOverbook}
									className="mt-0.5"
									data-testid="waitlist-seat-overbook-toggle"
								/>
								<span>
									<Trans>
										Seat this party even though the table is booked or in use.
									</Trans>
								</span>
							</label>
							{overbook ? (
								<TextField
									id="waitlist-seat-reason"
									label={<Trans>Reason</Trans>}
									value={reason}
									maxLength={500}
									onChange={(event) => setReason(event.target.value)}
									data-testid="waitlist-seat-reason"
								/>
							) : null}
						</div>
					) : null}

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							className="h-11 md:h-8"
							onClick={onClose}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							className="h-11 md:h-8"
							disabled={submitting}
							data-testid="waitlist-seat-submit"
						>
							<Icon name="check" className="size-4" />
							<span>
								{submitting ? (
									<Trans>Seating...</Trans>
								) : (
									<Trans>Seat now</Trans>
								)}
							</span>
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
