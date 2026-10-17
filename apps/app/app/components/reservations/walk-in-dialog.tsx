import { Trans, useLingui } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useEffect, useRef, useState } from 'react'
import {
	createWalkInReservation,
	type DayMoveNotice,
	type DayReservationView,
	type LiveTableState,
} from '#app/utils/reservations/book-api.ts'
import {
	enumLabel,
	LIVE_TABLE_STATUS_LABELS,
} from '#app/utils/reservations/labels.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import {
	afterFailedSubmit,
	keyForSubmit,
	newSubmitKey,
} from '#app/utils/reservations/submit-key.ts'

export function WalkInDialog({
	open,
	onOpenChange,
	client,
	locationId,
	businessDate,
	localStartMin,
	tableStates,
	initialTableId = null,
	initialPartySize = 2,
	onCreated,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	client: ReservationsScopedClient
	locationId: string
	businessDate: string
	localStartMin?: number
	tableStates: LiveTableState[]
	initialTableId?: string | null
	initialPartySize?: number
	onCreated: (
		reservation: DayReservationView,
		moveNotices: DayMoveNotice[],
	) => void
}) {
	const { t, i18n } = useLingui()
	const [partySize, setPartySize] = useState(initialPartySize)
	const [selectedTableId, setSelectedTableId] = useState<string>(
		initialTableId ?? '',
	)
	const [guestName, setGuestName] = useState('')
	const [guestPhone, setGuestPhone] = useState('')
	const [serverLabel, setServerLabel] = useState('')
	const [notes, setNotes] = useState('')
	const [forceOverbook, setForceOverbook] = useState(false)
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const keyRef = useRef(newSubmitKey('walkin'))

	useEffect(() => {
		if (!open) return
		setPartySize(initialPartySize || 2)
		setSelectedTableId(initialTableId ?? '')
		setGuestName('')
		setGuestPhone('')
		setServerLabel('')
		setNotes('')
		setForceOverbook(false)
		setError(null)
		keyRef.current = newSubmitKey('walkin')
	}, [initialPartySize, initialTableId, open])

	// Sort candidate tables: open tables that fit partySize first, then other open tables, then occupied
	const sortedTables = [...tableStates].sort((a, b) => {
		const aOpen = a.status === 'open' || a.status === 'reserved_soon' ? 0 : 1
		const bOpen = b.status === 'open' || b.status === 'reserved_soon' ? 0 : 1
		if (aOpen !== bOpen) return aOpen - bOpen
		const aFits = a.minCovers <= partySize && partySize <= a.maxCovers ? 0 : 1
		const bFits = b.minCovers <= partySize && partySize <= b.maxCovers ? 0 : 1
		if (aFits !== bFits) return aFits - bFits
		return a.maxCovers - b.maxCovers
	})

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		setSubmitting(true)
		setError(null)
		try {
			const input = {
				locationId,
				partySize,
				date: businessDate,
				...(localStartMin !== undefined ? { localStartMin } : {}),
				...(selectedTableId ? { tableIds: [selectedTableId] } : {}),
				...(guestName.trim() ? { guestName: guestName.trim() } : {}),
				...(guestPhone.trim() ? { guestPhone: guestPhone.trim() } : {}),
				...(serverLabel.trim() ? { serverLabel: serverLabel.trim() } : {}),
				...(notes.trim() ? { internalNotes: notes.trim() } : {}),
				forceOverbook,
			}
			// Same form, same key: a retry after a lost response replays.
			const res = await createWalkInReservation(
				client,
				input,
				keyForSubmit(keyRef, 'walkin', input),
			)
			onCreated(res.reservation, res.moveNotices ?? [])
			onOpenChange(false)
		} catch (err) {
			setError(err instanceof Error ? err.message : t`Failed to seat walk-in.`)
			afterFailedSubmit(keyRef, 'walkin', err)
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md" data-testid="walk-in-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Seat Walk-In Party</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Immediately seat a walk-in party at an available table or
							auto-assign the best open table.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSubmit} className="flex flex-col gap-3">
					{error ? (
						<Alert variant="destructive" data-testid="walk-in-error">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					{/* Party Size Quick Picker */}
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="walk-in-party-size">
							<Trans>Party Size</Trans>
						</Label>
						<div className="flex flex-wrap items-center gap-1.5">
							{[1, 2, 3, 4, 5, 6, 8].map((n) => (
								<Button
									key={n}
									type="button"
									size="sm"
									variant={partySize === n ? 'default' : 'outline'}
									onClick={() => setPartySize(n)}
									data-testid={`walk-in-size-${n}`}
								>
									{n}
								</Button>
							))}
							<Input
								id="walk-in-party-size"
								type="number"
								min={1}
								max={30}
								value={partySize}
								onChange={(e) =>
									setPartySize(Math.max(1, Number(e.target.value) || 1))
								}
								className="h-8 w-20"
								data-testid="walk-in-party-size"
							/>
						</div>
					</div>

					{/* Table Selector */}
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="walk-in-table-select">
							<Trans>Assign Table</Trans>
						</Label>
						<select
							id="walk-in-table-select"
							value={selectedTableId}
							onChange={(e) => setSelectedTableId(e.target.value)}
							className="border-input bg-background h-9 rounded-md border px-2.5 text-sm"
							data-testid="walk-in-table-select"
						>
							<option value="">{t`Auto-assign best open table`}</option>
							{sortedTables.map((tbl) => (
								<option key={tbl.tableId} value={tbl.tableId}>
									{tbl.label} ({tbl.minCovers}-{tbl.maxCovers}) —{' '}
									{enumLabel(
										(d) => i18n._(d),
										LIVE_TABLE_STATUS_LABELS,
										tbl.status,
									)}
									{tbl.serverName ? ` [${tbl.serverName}]` : ''}
								</option>
							))}
						</select>
						{sortedTables.length > 0 ? (
							<div className="flex flex-wrap gap-1 pt-0.5">
								{sortedTables
									.filter((tbl) => tbl.status === 'open')
									.slice(0, 6)
									.map((tbl) => {
										const fits =
											tbl.minCovers <= partySize && partySize <= tbl.maxCovers
										return (
											<Badge
												key={tbl.tableId}
												variant={
													selectedTableId === tbl.tableId
														? 'default'
														: fits
															? 'secondary'
															: 'outline'
												}
												className="cursor-pointer"
												onClick={() => setSelectedTableId(tbl.tableId)}
												data-testid={`walk-in-table-chip-${tbl.label}`}
											>
												{tbl.label} ({tbl.maxCovers})
											</Badge>
										)
									})}
							</div>
						) : null}
					</div>

					{/* Optional Guest Name & Phone */}
					<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
						<div className="flex flex-col gap-1">
							<Label htmlFor="walk-in-guest-name">
								<Trans>Guest Name (Optional)</Trans>
							</Label>
							<Input
								id="walk-in-guest-name"
								value={guestName}
								onChange={(e) => setGuestName(e.target.value)}
								placeholder={t`Walk-In Guest`}
								data-testid="walk-in-guest-name"
							/>
						</div>

						<div className="flex flex-col gap-1">
							<Label htmlFor="walk-in-guest-phone">
								<Trans>Phone (Optional)</Trans>
							</Label>
							<Input
								id="walk-in-guest-phone"
								value={guestPhone}
								onChange={(e) => setGuestPhone(e.target.value)}
								placeholder="+1..."
								data-testid="walk-in-guest-phone"
							/>
						</div>
					</div>

					<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
						<div className="flex flex-col gap-1">
							<Label htmlFor="walk-in-server-label">
								<Trans>Server (Optional)</Trans>
							</Label>
							<Input
								id="walk-in-server-label"
								value={serverLabel}
								onChange={(e) => setServerLabel(e.target.value)}
								placeholder={t`Server name`}
								data-testid="walk-in-server-label"
							/>
						</div>

						<div className="flex flex-col gap-1">
							<Label htmlFor="walk-in-notes">
								<Trans>Host Notes</Trans>
							</Label>
							<Input
								id="walk-in-notes"
								value={notes}
								onChange={(e) => setNotes(e.target.value)}
								placeholder={t`Optional note`}
								data-testid="walk-in-notes"
							/>
						</div>
					</div>

					<label className="flex items-center gap-2 text-xs">
						<input
							type="checkbox"
							checked={forceOverbook}
							onChange={(e) => setForceOverbook(e.target.checked)}
							data-testid="walk-in-force-overbook"
						/>
						<span>
							<Trans>
								Allow overbooking / seating on blocked or tight table
							</Trans>
						</span>
					</label>

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							disabled={submitting}
							data-testid="walk-in-submit-btn"
						>
							<Icon name="user-plus" className="size-4" />
							<span>
								{submitting ? (
									<Trans>Seating...</Trans>
								) : (
									<Trans>Seat Walk-In Now</Trans>
								)}
							</span>
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
