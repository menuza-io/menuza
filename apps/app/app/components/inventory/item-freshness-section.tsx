import { Trans, useLingui } from '@lingui/react/macro'
import { itemLotsSchema, type ItemDetail } from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useId, useState } from 'react'
import { formatUseBy } from '#app/components/inventory/freshness-panel.tsx'
import { useQuantityFormat } from '#app/components/inventory/inventory-prefs.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { thousandthsInUnit } from '#app/utils/inventory/format.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'

const HOURS_PER_DAY = 24

/** Shelf life in hours as a number and a unit: whole days when it divides. */
export function shelfLifeParts(hours: number | null | undefined): {
	amount: string
	unit: 'hours' | 'days'
} {
	if (hours == null) return { amount: '', unit: 'days' }
	return hours % HOURS_PER_DAY === 0
		? { amount: String(hours / HOURS_PER_DAY), unit: 'days' }
		: { amount: String(hours), unit: 'hours' }
}

export function shelfLifeToHours(
	amount: string,
	unit: 'hours' | 'days',
): number | null {
	const value = Number(amount.trim().replace(',', '.'))
	if (!Number.isFinite(value) || value <= 0) return null
	const hours = Math.round(unit === 'days' ? value * HOURS_PER_DAY : value)
	return hours >= 1 && hours <= 87_600 ? hours : null
}

/**
 * Use-by dates for one item (#479, #523): track it by date, its shelf life and
 * storage note and the Arabic name a label prints, and (for a tracked item)
 * the stock by use-by date with "Confirm the dates" for when someone has
 * checked the shelf. Receiving asks for the date of a tracked item, or works it
 * out from the shelf life. The name field is for labels only: inventory screens
 * keep one plain name per item.
 */
export function ItemFreshnessSection({
	item,
	locationId,
	canEdit,
	onChanged,
}: {
	item: ItemDetail
	locationId: string
	canEdit: boolean
	onChanged: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const trackId = useId()
	const lifeId = useId()
	const noteId = useId()
	const nameId = useId()
	const initial = shelfLifeParts(item.shelfLifeHours)
	const [life, setLife] = useState(initial.amount)
	const [unit, setUnit] = useState<'hours' | 'days'>(initial.unit)
	const [note, setNote] = useState(item.storageNote ?? '')
	const [nameAr, setNameAr] = useState(item.nameAr ?? '')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [confirming, setConfirming] = useState(false)
	const lots = useInventoryQuery(
		item.trackByDate
			? `/items/${encodeURIComponent(item.id)}/lots?${new URLSearchParams({ locationId })}`
			: null,
		itemLotsSchema,
	)

	const lotsData = lots.data

	async function patch(body: Record<string, unknown>) {
		setBusy(true)
		setError(null)
		try {
			await request(`/items/${encodeURIComponent(item.id)}`, {
				method: 'PATCH',
				body: JSON.stringify({ expectedVersion: item.version, ...body }),
			})
			onChanged()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setBusy(false)
		}
	}

	const hours = shelfLifeToHours(life, unit)
	const lifeProblem = life.trim() !== '' && hours === null

	return (
		<section
			className="flex flex-col gap-3"
			aria-labelledby="item-freshness"
			data-testid="item-freshness"
		>
			<h3 id="item-freshness" className="text-sm font-semibold">
				<Trans>Use-by dates</Trans>
			</h3>
			{error ? (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			<div className="flex items-start gap-2.5">
				<Checkbox
					id={trackId}
					checked={item.trackByDate === true}
					disabled={!canEdit || busy}
					onCheckedChange={(checked) =>
						void patch({ trackByDate: Boolean(checked) })
					}
					data-testid="item-track-by-date"
				/>
				<div className="flex flex-col gap-0.5">
					<Label htmlFor={trackId} className="font-normal">
						<Trans>Track by use-by date</Trans>
					</Label>
					<p className="text-muted-foreground text-xs">
						<Trans>
							Receiving asks for the date, Today lists what to use first and
							what has expired, and stock is used oldest date first.
						</Trans>
					</p>
				</div>
			</div>

			<div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={lifeId}>
						<Trans>Shelf life</Trans>
					</Label>
					<div className="flex gap-2">
						<Input
							id={lifeId}
							inputMode="decimal"
							value={life}
							disabled={!canEdit || busy}
							aria-invalid={lifeProblem}
							onChange={(event) => setLife(event.target.value)}
							data-testid="item-shelf-life"
						/>
						<select
							className="border-input bg-background h-9 rounded-md border px-2 text-sm"
							value={unit}
							disabled={!canEdit || busy}
							onChange={(event) =>
								setUnit(event.target.value === 'hours' ? 'hours' : 'days')
							}
							aria-label={t`Shelf life unit`}
							data-testid="item-shelf-life-unit"
						>
							<option value="days">{t`days`}</option>
							<option value="hours">{t`hours`}</option>
						</select>
					</div>
					<p className="text-muted-foreground text-xs">
						<Trans>
							From the day it is received or made. Leave empty for none.
						</Trans>
					</p>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={noteId}>
						<Trans>Storage note</Trans>
					</Label>
					<Input
						id={noteId}
						value={note}
						maxLength={120}
						disabled={!canEdit || busy}
						onChange={(event) => setNote(event.target.value)}
						data-testid="item-storage-note"
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={nameId}>
						<Trans>Arabic name for labels</Trans>
					</Label>
					<Input
						id={nameId}
						dir="rtl"
						lang="ar"
						value={nameAr}
						maxLength={80}
						disabled={!canEdit || busy}
						onChange={(event) => setNameAr(event.target.value)}
						data-testid="item-name-ar"
					/>
				</div>
			</div>
			{canEdit ? (
				<div>
					<Button
						variant="outline"
						size="sm"
						disabled={busy || lifeProblem}
						onClick={() =>
							void patch({
								shelfLifeHours: life.trim() === '' ? null : hours,
								storageNote: note.trim() === '' ? null : note.trim(),
								nameAr: nameAr.trim() === '' ? null : nameAr.trim(),
							})
						}
						data-testid="item-freshness-save"
					>
						<Trans>Save</Trans>
					</Button>
				</div>
			) : null}

			{item.trackByDate ? (
				<div className="flex flex-col gap-2" data-testid="item-lots">
					<h4 className="text-sm font-medium">
						<Trans>Stock by date</Trans>
					</h4>
					{lotsData ? (
						<>
							<ul className="flex flex-col divide-y rounded-xl border">
								{lotsData.undated > 0 ? (
									<li className="flex items-center justify-between gap-3 p-3 text-sm">
										<span>
											<Trans>No date (used first)</Trans>
										</span>
										<bdi dir="ltr" className="tabular-nums">
											{quantity.format(lotsData.undated, {
												baseUnit: lotsData.baseUnit,
												countUnit: lotsData.countUnit,
											})}
										</bdi>
									</li>
								) : null}
								{lotsData.lots.map((lot) => (
									<li
										key={lot.id}
										className="flex items-center justify-between gap-3 p-3 text-sm"
										data-testid={`item-lot-${lot.id}`}
									>
										<span className="flex items-center gap-2">
											<bdi dir="ltr">
												{formatUseBy(lot.useByDate, i18n.locale)}
											</bdi>
											{lot.status === 'expired' ? (
												<Badge variant="destructive">
													<Trans>Expired</Trans>
												</Badge>
											) : lot.status === 'today' || lot.status === 'soon' ? (
												<Badge variant="secondary">
													<Trans>Use first</Trans>
												</Badge>
											) : null}
										</span>
										<bdi dir="ltr" className="tabular-nums">
											{quantity.format(lot.remaining, {
												baseUnit: lotsData.baseUnit,
												countUnit: lotsData.countUnit,
											})}
										</bdi>
									</li>
								))}
								{lotsData.lots.length === 0 && lotsData.undated === 0 ? (
									<li className="text-muted-foreground p-3 text-sm">
										<Trans>No stock on hand.</Trans>
									</li>
								) : null}
							</ul>
							{canEdit && lotsData.onHand > 0 ? (
								<div>
									<Button
										variant="outline"
										size="sm"
										onClick={() => setConfirming(true)}
										data-testid="item-confirm-dates"
									>
										<Trans>Confirm the dates</Trans>
									</Button>
								</div>
							) : null}
							{confirming ? (
								<ConfirmDates
									item={item}
									locationId={locationId}
									onDone={() => {
										setConfirming(false)
										lots.reload()
										onChanged()
									}}
									onCancel={() => setConfirming(false)}
								/>
							) : null}
						</>
					) : (
						<p className="text-muted-foreground text-xs">
							<Trans>Loading.</Trans>
						</p>
					)}
				</div>
			) : null}
		</section>
	)
}

function ConfirmDates({
	item,
	locationId,
	onDone,
	onCancel,
}: {
	item: ItemDetail
	locationId: string
	onDone: () => void
	onCancel: () => void
}) {
	const { i18n } = useLingui()
	const { request } = useInventoryClient()
	const [rows, setRows] = useState([{ date: '', amount: '' }])
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const perUnit =
		thousandthsInUnit(
			item.countUnit ?? (item.baseUnit === 'piece' ? 'piece' : item.baseUnit),
			item.baseUnit,
			item.units,
		) ?? 1000
	const lots = rows.map((row) => ({
		useByDate: row.date,
		quantity: Math.round(Number(row.amount.replace(',', '.')) * perUnit),
	}))
	const valid =
		rows.length > 0 &&
		lots.every(
			(lot) =>
				/^\d{4}-\d{2}-\d{2}$/.test(lot.useByDate) &&
				Number.isFinite(lot.quantity) &&
				lot.quantity > 0,
		)

	async function save() {
		setBusy(true)
		setError(null)
		try {
			await request(`/items/${encodeURIComponent(item.id)}/lots/confirm`, {
				method: 'POST',
				body: JSON.stringify({
					clientId: newClientId('d'),
					locationId,
					lots,
				}),
			})
			onDone()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
			setBusy(false)
		}
	}

	return (
		<div
			className="flex flex-col gap-3 rounded-xl border p-3"
			data-testid="confirm-dates"
		>
			<p className="text-muted-foreground text-xs">
				<Trans>
					Enter what you see on the shelf, by date. Older dates stop counting;
					anything not listed stays without a date.
				</Trans>
			</p>
			{error ? (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			{rows.map((row, index) => (
				<div key={index} className="flex flex-wrap items-end gap-2">
					<div className="flex flex-col gap-1">
						<Label>
							<Trans>Use by</Trans>
						</Label>
						<Input
							type="date"
							value={row.date}
							onChange={(event) =>
								setRows((all) =>
									all.map((r, i) =>
										i === index ? { ...r, date: event.target.value } : r,
									),
								)
							}
							data-testid={`confirm-date-${index}`}
						/>
					</div>
					<div className="flex flex-col gap-1">
						<Label>
							<Trans>Amount</Trans>
						</Label>
						<Input
							inputMode="decimal"
							className="w-28"
							value={row.amount}
							onChange={(event) =>
								setRows((all) =>
									all.map((r, i) =>
										i === index ? { ...r, amount: event.target.value } : r,
									),
								)
							}
							data-testid={`confirm-amount-${index}`}
						/>
					</div>
				</div>
			))}
			<div className="flex flex-wrap gap-2">
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setRows((all) => [...all, { date: '', amount: '' }])}
				>
					<Trans>Add a date</Trans>
				</Button>
				<Button
					size="sm"
					disabled={busy || !valid}
					onClick={() => void save()}
					data-testid="confirm-dates-save"
				>
					<Trans>Save dates</Trans>
				</Button>
				<Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
					<Trans>Cancel</Trans>
				</Button>
			</div>
		</div>
	)
}
