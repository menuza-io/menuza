import { Trans, useLingui } from '@lingui/react/macro'
import {
	transferTermSchema,
	transferTermsResultSchema,
	transfersOwedSchema,
	type TransferTerm,
	type UnitRef,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Input } from '@repo/ui/input'
import { Skeleton } from '@repo/ui/skeleton'
import { Switch } from '@repo/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { type TransferPlace } from '#app/components/inventory/transfer-dialogs.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { transferErrorMessage } from '#app/utils/inventory/transfer-form.ts'
import { parseMoneyToMinor } from '#app/utils/money-input.ts'

/**
 * What branches can ask this place for, and what they pay (#526): per item
 * "Branches can request this", and with the cost grant a transfer price (fixed
 * per kilo, litre or piece, or the item's cost plus a percentage). The price in
 * force is fixed on a transfer when it is sent; changing it later never
 * touches a sent transfer. A second tab lists what each branch owes for what
 * this place sent in a period.
 */
export function TransferTermsDialog({
	locationId,
	places,
	canSeeCost,
	currency,
	open,
	onOpenChange,
}: {
	locationId: string
	places: readonly TransferPlace[]
	canSeeCost: boolean
	currency: string
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-h-dvh overflow-y-auto sm:max-w-2xl"
				data-testid="transfer-terms-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Branch prices and what they can ask for</Trans>
					</DialogTitle>
					<DialogDescription>
						{canSeeCost ? (
							<Trans>
								Choose which items branches can ask this place for, and what
								they are charged for them. The price is fixed when a transfer is
								sent.
							</Trans>
						) : (
							<Trans>
								Choose which items branches can ask this place for. The price is
								fixed when a transfer is sent.
							</Trans>
						)}
					</DialogDescription>
				</DialogHeader>
				<Tabs defaultValue="items">
					<TabsList>
						<TabsTrigger value="items">
							<Trans>Items</Trans>
						</TabsTrigger>
						{canSeeCost ? (
							<TabsTrigger value="owed" data-testid="terms-owed-tab">
								<Trans>What branches owe</Trans>
							</TabsTrigger>
						) : null}
					</TabsList>
					<TabsContent value="items" className="pt-3">
						<TermsList
							locationId={locationId}
							canSeeCost={canSeeCost}
							currency={currency}
						/>
					</TabsContent>
					{canSeeCost ? (
						<TabsContent value="owed" className="pt-3">
							<OwedReport
								locationId={locationId}
								places={places}
								currency={currency}
							/>
						</TabsContent>
					) : null}
				</Tabs>
			</DialogContent>
		</Dialog>
	)
}

const PRICE_UNITS: Record<string, UnitRef[]> = {
	g: ['kg', 'g'],
	ml: ['l', 'ml'],
	piece: ['piece'],
}

function TermsList({
	locationId,
	canSeeCost,
	currency,
}: {
	locationId: string
	canSeeCost: boolean
	currency: string
}) {
	const { t, i18n } = useLingui()
	const [search, setSearch] = useState('')
	const query = useInventoryQuery(
		`/transfer-terms?${new URLSearchParams({ locationId, ...(search.trim() ? { search: search.trim() } : {}) })}`,
		transferTermsResultSchema,
	)
	const { reload } = query
	const terms = query.data?.terms ?? []
	return (
		<div className="flex flex-col gap-3">
			<Input
				value={search}
				onChange={(event) => setSearch(event.target.value)}
				placeholder={t`Search items`}
				aria-label={t`Search items`}
				data-testid="terms-search"
			/>
			{query.error && !query.data ? (
				<Alert variant="destructive">
					<AlertDescription>
						{i18n._(transferErrorMessage(query.error))}
					</AlertDescription>
				</Alert>
			) : !query.data ? (
				<Skeleton className="h-16 w-full" />
			) : terms.length === 0 ? (
				<p className="text-muted-foreground text-sm" data-testid="terms-empty">
					<Trans>No items here yet.</Trans>
				</p>
			) : (
				<ul
					className="flex flex-col divide-y rounded-xl border"
					data-testid="terms-list"
				>
					{terms.map((term) => (
						<TermRow
							key={`${term.itemId}-${term.version}`}
							term={term}
							locationId={locationId}
							canSeeCost={canSeeCost}
							currency={currency}
							onSaved={reload}
						/>
					))}
				</ul>
			)}
		</div>
	)
}

function TermRow({
	term,
	locationId,
	canSeeCost,
	currency,
	onSaved,
}: {
	term: TransferTerm
	locationId: string
	canSeeCost: boolean
	currency: string
	onSaved: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const [busy, setBusy] = useState(false)
	const [editing, setEditing] = useState(false)
	const [mode, setMode] = useState(term.priceMode ?? 'none')
	const [unit, setUnit] = useState<UnitRef>(PRICE_UNITS[term.baseUnit]![0]!)
	const [priceText, setPriceText] = useState('')
	const [markupText, setMarkupText] = useState(
		term.markupBp != null ? String(term.markupBp / 100) : '',
	)
	const [error, setError] = useState<string | null>(null)
	const money = term.currency ?? currency
	const version = useMemo(() => term.version, [term.version])

	async function save(body: Record<string, unknown>) {
		setBusy(true)
		setError(null)
		try {
			transferTermSchema.parse(
				await request(`/transfer-terms/${encodeURIComponent(term.itemId)}`, {
					method: 'PUT',
					body: JSON.stringify({
						locationId,
						expectedVersion: version,
						...body,
					}),
				}),
			)
			toast.success(t`Saved.`)
			setEditing(false)
			onSaved()
		} catch (caught) {
			setError(i18n._(transferErrorMessage(caught)))
		} finally {
			setBusy(false)
		}
	}

	function savePrice() {
		if (mode === 'none') return void save({ priceMode: 'none' })
		if (mode === 'fixed') {
			const priceMinor = parseMoneyToMinor(priceText, { currency: money })
			if (priceMinor === null) {
				setError(t`Enter a price, like 4.50.`)
				return
			}
			return void save({
				priceMode: 'fixed',
				fixedPrice: { priceMinor, per: unit, currency: money },
			})
		}
		const percent = Number(markupText.replace(',', '.'))
		if (!Number.isFinite(percent) || percent < 0 || percent > 1000) {
			setError(t`Enter a percentage between 0 and 1000.`)
			return
		}
		void save({ priceMode: 'cost_plus', markupBp: Math.round(percent * 100) })
	}

	const percent = term.markupBp != null ? term.markupBp / 100 : 0
	const itemName = term.itemName
	const requestLabel = t`Branches can request ${itemName}`
	const priceSummary =
		term.priceMode === 'fixed' && term.fixedPriceMicro != null
			? t`Fixed price`
			: term.priceMode === 'cost_plus' && term.markupBp != null
				? t`Cost plus ${percent}%`
				: t`No price (they pay cost)`
	const per =
		term.baseUnit === 'piece'
			? t`per piece`
			: term.baseUnit === 'g'
				? t`per kg`
				: t`per litre`
	// Micro-minor per base unit to minor per kilo, litre or piece.
	const perUnitMinor = (micro: number) =>
		Math.round((micro * (term.baseUnit === 'piece' ? 1 : 1000)) / 1_000_000)

	return (
		<li className="flex flex-col gap-2 p-3" data-testid={`term-${term.itemId}`}>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex min-w-0 flex-col">
					<span className="font-medium wrap-anywhere">{term.itemName}</span>
					{canSeeCost ? (
						<span className="text-muted-foreground text-xs">
							{priceSummary}
							{term.effectivePriceMicro != null ? (
								<>
									{' · '}
									<bdi dir="ltr">
										{formatMoney(
											perUnitMinor(term.effectivePriceMicro),
											money,
											i18n.locale,
										)}
									</bdi>{' '}
									{per}
								</>
							) : null}
						</span>
					) : null}
				</div>
				<div className="flex items-center gap-3">
					<label className="flex items-center gap-2 text-sm">
						<Switch
							checked={term.branchRequestable}
							disabled={busy}
							onCheckedChange={(next) =>
								void save({ branchRequestable: next === true })
							}
							aria-label={requestLabel}
							data-testid={`term-requestable-${term.itemId}`}
						/>
						<Trans>Branches can request this</Trans>
					</label>
					{canSeeCost ? (
						<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() => setEditing((current) => !current)}
							data-testid={`term-price-${term.itemId}`}
						>
							<Trans>Price</Trans>
						</Button>
					) : null}
				</div>
			</div>
			{editing ? (
				<div className="flex flex-wrap items-end gap-2">
					<FilterSelect
						label={t`How the price is set`}
						options={[
							{ value: 'none', label: t`No price (cost)` },
							{ value: 'fixed', label: t`Fixed price` },
							{ value: 'cost_plus', label: t`Cost plus a percentage` },
						]}
						value={mode}
						onValueChange={(next) => setMode(next as typeof mode)}
						testId={`term-mode-${term.itemId}`}
					/>
					{mode === 'fixed' ? (
						<>
							<Input
								value={priceText}
								onChange={(event) => setPriceText(event.target.value)}
								inputMode="decimal"
								placeholder={t`Price`}
								aria-label={t`Price`}
								className="w-28"
								data-testid={`term-fixed-${term.itemId}`}
							/>
							<FilterSelect
								label={t`Per`}
								options={PRICE_UNITS[term.baseUnit]!.map((choice) => ({
									value: choice,
									label: t`per ${choice}`,
								}))}
								value={unit}
								onValueChange={(next) => setUnit(next as UnitRef)}
							/>
						</>
					) : null}
					{mode === 'cost_plus' ? (
						<Input
							value={markupText}
							onChange={(event) => setMarkupText(event.target.value)}
							inputMode="decimal"
							placeholder={t`Percent`}
							aria-label={t`Markup percentage`}
							className="w-24"
							data-testid={`term-markup-${term.itemId}`}
						/>
					) : null}
					<Button
						size="sm"
						disabled={busy}
						onClick={savePrice}
						data-testid={`term-save-${term.itemId}`}
					>
						<Trans>Save price</Trans>
					</Button>
				</div>
			) : null}
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
		</li>
	)
}

function isoDay(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function OwedReport({
	locationId,
	places,
	currency,
}: {
	locationId: string
	places: readonly TransferPlace[]
	currency: string
}) {
	const { t, i18n } = useLingui()
	const [range] = useState(() => {
		const to = new Date()
		const from = new Date(to.getTime() - 30 * 24 * 3600_000)
		return { from: isoDay(from), to: isoDay(to) }
	})
	const query = useInventoryQuery(
		`/transfers/owed?${new URLSearchParams({ locationId, ...range })}`,
		transfersOwedSchema,
	)
	const name = (id: string) =>
		places.find((place) => place.id === id)?.name ?? t`Another place`
	const money = (minor: number | undefined, code: string | undefined) =>
		minor === undefined
			? '—'
			: formatMoney(minor, code ?? currency, i18n.locale)
	return (
		<div className="flex flex-col gap-3" data-testid="terms-owed">
			<p className="text-muted-foreground text-sm">
				<Trans>
					What each branch owes for what this place sent in the last 30 days.
				</Trans>
			</p>
			{!query.data ? (
				<Skeleton className="h-16 w-full" />
			) : query.data.rows.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>Nothing was sent in this period.</Trans>
				</p>
			) : (
				<table className="w-full text-sm">
					<thead>
						<tr className="text-muted-foreground text-start">
							<th className="py-1 text-start font-medium">
								<Trans>Branch</Trans>
							</th>
							<th className="py-1 text-end font-medium">
								<Trans>Transfers</Trans>
							</th>
							<th className="py-1 text-end font-medium">
								<Trans>Owes</Trans>
							</th>
							<th className="py-1 text-end font-medium">
								<Trans>At cost</Trans>
							</th>
						</tr>
					</thead>
					<tbody>
						{query.data.rows.map((row) => (
							<tr
								key={row.toLocationId}
								data-testid={`owed-${row.toLocationId}`}
							>
								<td className="py-1 wrap-anywhere">{name(row.toLocationId)}</td>
								<td className="py-1 text-end tabular-nums">{row.transfers}</td>
								<td className="py-1 text-end tabular-nums">
									<bdi dir="ltr">{money(row.owedMinor, row.currency)}</bdi>
								</td>
								<td className="text-muted-foreground py-1 text-end tabular-nums">
									<bdi dir="ltr">{money(row.costMinor, row.currency)}</bdi>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	)
}
