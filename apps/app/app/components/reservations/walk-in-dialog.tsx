import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
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
import { useEffect, useRef, useState } from 'react'
import { CheckRow } from '#app/components/reservations/sheet-parts.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import {
	createWalkInReservation,
	type DayMoveNotice,
	type DayReservationView,
	type LiveTableState,
} from '#app/utils/reservations/book-api.ts'
import { hostErrorMessage } from '#app/utils/reservations/host-errors.ts'
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
	const [moreOpen, setMoreOpen] = useState(false)
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const keyRef = useRef(newSubmitKey('walkin'))
	const sizeGroupRef = useRef<HTMLDivElement | null>(null)

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

	// Land on the party-size row (the chip for the current size, else the typed
	// number) so a host can pick a size and press Enter.
	useEffect(() => {
		if (!open) return
		const id = window.setTimeout(() => {
			const group = sizeGroupRef.current
			const target =
				group?.querySelector<HTMLElement>('button[aria-pressed="true"]') ??
				group?.querySelector<HTMLElement>('input')
			target?.focus()
		}, 0)
		return () => window.clearTimeout(id)
	}, [open])

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
			setError(
				hostErrorMessage(err, (d) => i18n._(d), msg`Failed to seat walk-in.`),
			)
			afterFailedSubmit(keyRef, 'walkin', err)
		} finally {
			setSubmitting(false)
		}
	}

	const NO_TABLE = '__none'
	const tableOptions = [
		{ value: NO_TABLE, label: t`Auto-assign best open table` },
		...sortedTables.map((tbl) => {
			const status = enumLabel(
				(d) => i18n._(d),
				LIVE_TABLE_STATUS_LABELS,
				tbl.status,
			)
			const server = tbl.serverName ? ` [${tbl.serverName}]` : ''
			return {
				value: tbl.tableId,
				label: `${tbl.label} (${tbl.minCovers}-${tbl.maxCovers}) · ${status}${server}`,
			}
		}),
	]

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md" data-testid="walk-in-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Seat a walk-in</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Pick the party size. The best open table is assigned unless you
							choose one.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSubmit} className="flex flex-col gap-4">
					{error ? (
						<Alert variant="destructive" data-testid="walk-in-error">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					{/* Party size: big tap targets, 1 to 8, then a typed number */}
					<div className="flex flex-col gap-2">
						<span id="walk-in-party-label" className="text-sm font-medium">
							<Trans>Party Size</Trans>
						</span>
						<div
							ref={sizeGroupRef}
							role="group"
							aria-labelledby="walk-in-party-label"
							className="flex flex-wrap items-center gap-2"
						>
							{[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
								<Button
									key={n}
									type="button"
									variant={partySize === n ? 'default' : 'outline'}
									className="size-11 tabular-nums md:size-8"
									aria-pressed={partySize === n}
									onClick={() => setPartySize(n)}
									data-testid={`walk-in-size-${n}`}
								>
									{n}
								</Button>
							))}
							<Input
								id="walk-in-party-size"
								type="number"
								inputMode="numeric"
								min={1}
								max={30}
								value={partySize}
								aria-label={t`Party size`}
								onChange={(e) =>
									setPartySize(Math.max(1, Number(e.target.value) || 1))
								}
								className="h-11 w-20 tabular-nums md:h-8"
								data-testid="walk-in-party-size"
							/>
						</div>
					</div>

					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<TextField
							label={<Trans>Name</Trans>}
							optional
							id="walk-in-guest-name"
							value={guestName}
							onChange={(e) => setGuestName(e.target.value)}
							placeholder={t`Walk-In Guest`}
							data-testid="walk-in-guest-name"
						/>
						<TextField
							label={<Trans>Phone</Trans>}
							optional
							id="walk-in-guest-phone"
							type="tel"
							inputMode="tel"
							value={guestPhone}
							onChange={(e) => setGuestPhone(e.target.value)}
							placeholder="+1..."
							data-testid="walk-in-guest-phone"
						/>
					</div>

					<Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
						<div className="flex flex-col gap-4">
							<CollapsibleTrigger
								render={
									<Button
										type="button"
										variant="ghost"
										className="h-11 justify-between md:h-8"
										data-testid="walk-in-more-toggle"
									/>
								}
							>
								<span>
									<Trans>Choose a table or add details</Trans>
								</span>
								<Icon
									name="chevron-down"
									className={cn(
										'size-4 transition-transform',
										moreOpen && 'rotate-180',
									)}
								/>
							</CollapsibleTrigger>
							<CollapsibleContent>
								<div className="flex flex-col gap-4">
									<div className="flex flex-col gap-2">
										<SelectField
											label={<Trans>Assign Table</Trans>}
											id="walk-in-table-select"
											testId="walk-in-table-select"
											options={tableOptions}
											value={selectedTableId || NO_TABLE}
											onValueChange={(next) =>
												setSelectedTableId(next === NO_TABLE ? '' : next)
											}
										/>
										{sortedTables.some((tbl) => tbl.status === 'open') ? (
											<div className="flex flex-wrap gap-2">
												{sortedTables
													.filter((tbl) => tbl.status === 'open')
													.slice(0, 6)
													.map((tbl) => {
														const fits =
															tbl.minCovers <= partySize &&
															partySize <= tbl.maxCovers
														return (
															<Button
																key={tbl.tableId}
																type="button"
																variant={
																	selectedTableId === tbl.tableId
																		? 'default'
																		: fits
																			? 'secondary'
																			: 'outline'
																}
																className="h-11 md:h-8"
																aria-pressed={selectedTableId === tbl.tableId}
																onClick={() => setSelectedTableId(tbl.tableId)}
																data-testid={`walk-in-table-chip-${tbl.label}`}
															>
																{tbl.label} ({tbl.maxCovers})
															</Button>
														)
													})}
											</div>
										) : null}
									</div>

									<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
										<TextField
											label={<Trans>Server</Trans>}
											optional
											id="walk-in-server-label"
											value={serverLabel}
											onChange={(e) => setServerLabel(e.target.value)}
											placeholder={t`Server name`}
											data-testid="walk-in-server-label"
										/>
										<TextField
											label={<Trans>Host Notes</Trans>}
											optional
											id="walk-in-notes"
											value={notes}
											onChange={(e) => setNotes(e.target.value)}
											placeholder={t`Optional note`}
											data-testid="walk-in-notes"
										/>
									</div>

									<CheckRow
										label={<Trans>Allow overbooking</Trans>}
										description={
											<Trans>
												Staff override: seat on a blocked or tight table.
											</Trans>
										}
										checked={forceOverbook}
										onCheckedChange={setForceOverbook}
										testId="walk-in-force-overbook"
									/>
								</div>
							</CollapsibleContent>
						</div>
					</Collapsible>

					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							className="h-11 md:h-8"
							onClick={() => onOpenChange(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							className="h-11 md:h-8"
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
