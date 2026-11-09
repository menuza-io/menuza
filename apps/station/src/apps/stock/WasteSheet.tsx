import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	PICKABLE_WASTE_REASONS,
	STATION_WASTE_UNDO_UI_MS,
	type StationItem,
	type UnitRef,
	type WasteReason,
} from '@repo/inventory'
import { Icon } from '@repo/ui/icon'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BigStepper } from './BigStepper.tsx'
import { recentWaste } from './local.ts'
import { categoryText, WASTE_REASON_LABELS } from './messages.ts'
import {
	filterItems,
	formatAmount,
	recentWasteIds,
	undoRemainingMs,
	unitChoices,
	unitLabel,
	unitStep,
	unitTakesFractions,
} from './model.ts'
import {
	logWaste,
	newClientId,
	StockQueueFullError,
	undoWaste,
} from './queue.ts'
import { StockNotices } from './StockNotices.tsx'
import { type StockState } from './useStock.ts'
import { useNow } from '~/ui/hooks.ts'
import {
	Button,
	Chip,
	cn,
	fieldClass,
	Input,
	Modal,
	Select,
} from '~/ui/primitives.tsx'

/** A waste entry logged in this sheet, kept a minute so it can be undone. */
type Logged = {
	clientId: string
	name: string
	amount: number
	unit: UnitRef
	units: StationItem['units']
	reason: WasteReason
	at: number
	state: 'logged' | 'undone' | 'too_late'
}

/** Waste is sent a few seconds after it is logged, so a slip undone at once never leaves the tablet. */
const SEND_AFTER_MS = 3_000
/** More matches than this ask for a few more letters. */
const MAX_SHOWN = 60

/**
 * Log waste, as a full-screen sheet (Stock's tile and Kitchen's button open
 * the same one). Pick an item (this terminal's recent ones first, or search),
 * type how much and in what unit, pick a reason; it is saved on the tablet at
 * once and sent when it can be. The person is whoever is signed in; no cost is
 * shown anywhere. An entry can be undone for a minute.
 */
export function WasteSheet({
	stock,
	open,
	onClose,
}: {
	stock: StockState
	open: boolean
	onClose: () => void
}) {
	const { _, i18n } = useLingui()
	const { catalog, ctx } = stock
	const [query, setQuery] = useState('')
	const [itemId, setItemId] = useState<string | null>(null)
	const [amount, setAmount] = useState<number | null>(null)
	const [unit, setUnit] = useState<UnitRef | null>(null)
	const [reason, setReason] = useState<WasteReason | null>(null)
	const [note, setNote] = useState('')
	const [problem, setProblem] = useState<string | null>(null)
	const [logged, setLogged] = useState<Logged[]>([])
	const [local, setLocal] = useState<string[]>([])
	const now = useNow(logged.length > 0 ? 1_000 : 60_000)
	const sendTimer = useRef<number | undefined>(undefined)
	useEffect(() => () => window.clearTimeout(sendTimer.current), [])
	// The entry's id is made before the tap and kept until the form is empty again: a double tap queues one entry.
	const draftId = useRef(newClientId())
	const saving = useRef(false)
	const [busy, setBusy] = useState(false)
	useEffect(() => {
		if (itemId === null) draftId.current = newClientId()
	}, [itemId])

	useEffect(() => {
		if (!open) return
		let alive = true
		void recentWaste(stock.origin).then((ids) => {
			if (alive) setLocal(ids)
		})
		return () => {
			alive = false
		}
	}, [open, stock.origin])
	// A fresh sheet each time it opens.
	useEffect(() => {
		if (open) return
		setQuery('')
		setItemId(null)
		setAmount(null)
		setUnit(null)
		setReason(null)
		setNote('')
		setProblem(null)
		setLogged([])
	}, [open])

	const items = useMemo(
		() => new Map(catalog?.items.map((item) => [item.id, item]) ?? []),
		[catalog],
	)
	const item = itemId ? (items.get(itemId) ?? null) : null
	const reasons = useMemo(
		() =>
			(catalog?.wasteReasons ?? []).filter((entry) =>
				(PICKABLE_WASTE_REASONS as readonly string[]).includes(entry),
			),
		[catalog],
	)
	const matches = useMemo(
		() => (catalog ? filterItems(catalog.items, query) : []),
		[catalog, query],
	)
	const recent = useMemo(
		() =>
			catalog && query.trim() === ''
				? recentWasteIds(catalog, local)
						.map((id) => items.get(id))
						.filter((entry): entry is StationItem => Boolean(entry))
				: [],
		[catalog, local, query, items],
	)

	const choose = (next: StationItem) => {
		setItemId(next.id)
		setUnit(next.countUnit)
		setAmount(null)
		setProblem(null)
	}
	const scheduleSend = () => {
		window.clearTimeout(sendTimer.current)
		sendTimer.current = window.setTimeout(
			() => void stock.sync(),
			SEND_AFTER_MS,
		)
	}
	const ready = Boolean(
		item && unit && amount !== null && amount > 0 && reason && ctx,
	)
	const submit = async () => {
		if (!item || !unit || amount === null || amount <= 0 || !reason || !ctx)
			return
		if (saving.current) return
		saving.current = true
		setBusy(true)
		try {
			const clientId = await logWaste(
				ctx,
				{
					itemId: item.id,
					amount,
					unit,
					reason,
					...(note.trim() ? { note: note.trim() } : {}),
				},
				draftId.current,
			)
			setLogged((before) =>
				before.some((entry) => entry.clientId === clientId)
					? before
					: [
							{
								clientId,
								name: item.name,
								amount,
								unit,
								units: item.units,
								reason,
								at: Date.now(),
								state: 'logged',
							},
							...before,
						],
			)
			setLocal((before) => [item.id, ...before.filter((id) => id !== item.id)])
			setItemId(null)
			setAmount(null)
			setUnit(null)
			setReason(null)
			setNote('')
			setProblem(null)
			scheduleSend()
		} catch (failure) {
			setProblem(
				failure instanceof StockQueueFullError
					? _(
							t`Too much is waiting to send from this tablet. Connect and let it send first.`,
						)
					: _(t`This could not be saved on the tablet.`),
			)
		} finally {
			saving.current = false
			setBusy(false)
		}
	}
	const undo = async (entry: Logged) => {
		if (!ctx) return
		const outcome = await undoWaste(ctx, entry.clientId).catch(
			() => 'unknown' as const,
		)
		setLogged((before) =>
			before.map((row) =>
				row.clientId === entry.clientId
					? { ...row, state: outcome === 'unknown' ? 'too_late' : 'undone' }
					: row,
			),
		)
		if (outcome === 'queued') void stock.sync()
	}

	const staffName = stock.staffName
	const undoSeconds = STATION_WASTE_UNDO_UI_MS / 1000
	const footer = (
		<div className="flex flex-col gap-2 pb-3">
			{staffName ? (
				<p className="text-muted-foreground text-sm">
					{_(t`Logging as ${staffName}`)}
				</p>
			) : null}
			<div className="flex flex-col gap-2 sm:flex-row-reverse">
				<Button
					variant="primary"
					size="lg"
					disabled={!ready || busy}
					onClick={() => void submit()}
					className="sm:min-w-56"
				>
					<Icon name="trash-2" className="size-5" />
					<Trans>Log waste</Trans>
				</Button>
				<Button size="lg" onClick={onClose}>
					{logged.length > 0 ? <Trans>Done</Trans> : <Trans>Close</Trans>}
				</Button>
			</div>
		</div>
	)

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={_(t`Log waste`)}
			size="full"
			footer={footer}
		>
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-5">
				<StockNotices stock={stock} compact />
				{logged.length > 0 ? (
					<ul
						aria-label={_(t`Just logged`)}
						className="border-border bg-muted/40 flex flex-col gap-2 rounded-(--station-panel-radius) border p-3"
					>
						{logged.map((entry) => {
							const left = undoRemainingMs(entry.at, now)
							const unitText = unitLabel(
								entry.unit,
								entry.units,
								i18n.locale,
								entry.amount,
							)
							const amountText = formatAmount(entry.amount, i18n.locale)
							const reasonText = _(WASTE_REASON_LABELS[entry.reason])
							return (
								<li
									key={entry.clientId}
									className="flex flex-wrap items-center gap-2 text-base"
								>
									<Icon
										name={entry.state === 'logged' ? 'check-circle' : 'undo-2'}
										className={cn(
											'size-5 shrink-0',
											entry.state === 'logged'
												? 'text-success'
												: 'text-muted-foreground',
										)}
										aria-hidden
									/>
									<span className="min-w-0 flex-1 break-words">
										<span className="font-medium">{entry.name}</span>
										{' · '}
										<bdi dir="ltr" className="tnum">
											{amountText} {unitText}
										</bdi>
										{' · '}
										{reasonText}
										{entry.state === 'undone' ? (
											<span className="text-muted-foreground">
												{' · '}
												<Trans>Undone</Trans>
											</span>
										) : null}
										{entry.state === 'too_late' ? (
											<span className="text-warning">
												{' · '}
												<Trans>Too late to undo here</Trans>
											</span>
										) : null}
									</span>
									{entry.state === 'logged' && left > 0 ? (
										<Button onClick={() => void undo(entry)}>
											<Icon name="undo-2" className="size-4" />
											<Trans>Undo</Trans>
											<bdi dir="ltr" className="tnum text-muted-foreground">
												{Math.ceil(left / 1000)}
											</bdi>
										</Button>
									) : null}
								</li>
							)
						})}
					</ul>
				) : null}
				{!catalog ? (
					<p className="text-muted-foreground">
						{stock.loading ? (
							<Trans>Loading the stock list…</Trans>
						) : (
							<Trans>
								The stock list has not loaded yet. Connect once so this tablet
								can get it.
							</Trans>
						)}
					</p>
				) : item && unit ? (
					<div className="flex flex-col gap-5">
						<div className="border-border bg-card flex items-start justify-between gap-3 rounded-(--station-panel-radius) border p-4">
							<div className="min-w-0">
								<p className="text-xl font-semibold break-words">{item.name}</p>
								<p className="text-muted-foreground text-sm">
									{categoryText(item.category, i18n)}
								</p>
							</div>
							<Button onClick={() => setItemId(null)}>
								<Trans>Change item</Trans>
							</Button>
						</div>
						<fieldset className="flex flex-col gap-2">
							<legend className="mb-1 text-base font-semibold">
								<Trans>How much</Trans>
							</legend>
							<div className="flex flex-wrap items-start gap-3">
								<BigStepper
									value={amount}
									label={item.name}
									step={unitStep(unit)}
									fractions={unitTakesFractions(unit)}
									onChange={setAmount}
								/>
								<Select
									aria-label={_(t`Unit`)}
									containerClassName="w-44"
									value={unit}
									onChange={(event) => {
										setUnit(event.target.value)
										setAmount(null)
									}}
								>
									{unitChoices(item).map((ref) => (
										<option key={ref} value={ref}>
											{unitLabel(ref, item.units, i18n.locale)}
										</option>
									))}
								</Select>
							</div>
						</fieldset>
						<fieldset className="flex flex-col gap-2">
							<legend className="mb-1 text-base font-semibold">
								<Trans>Why</Trans>
							</legend>
							<div className="flex flex-wrap gap-2">
								{reasons.map((entry) => (
									<Chip
										key={entry}
										size="lg"
										look="outlined"
										selected={reason === entry}
										aria-pressed={reason === entry}
										onClick={() => setReason(entry)}
									>
										{_(WASTE_REASON_LABELS[entry])}
									</Chip>
								))}
							</div>
						</fieldset>
						<label className="flex flex-col gap-2">
							<span className="text-base font-semibold">
								<Trans>Note (optional)</Trans>
							</span>
							<Input
								value={note}
								maxLength={500}
								onChange={(event) => setNote(event.target.value)}
							/>
						</label>
						{problem ? (
							<p role="alert" className="text-destructive text-sm">
								{problem}
							</p>
						) : null}
					</div>
				) : (
					<div className="flex flex-col gap-4">
						<label className="flex flex-col gap-2">
							<span className="text-base font-semibold">
								<Trans>What was wasted?</Trans>
							</span>
							<input
								type="search"
								className={fieldClass}
								value={query}
								placeholder={_(t`Search items`)}
								autoComplete="off"
								onChange={(event) => setQuery(event.target.value)}
							/>
						</label>
						{recent.length > 0 ? (
							<div className="flex flex-col gap-2">
								<p className="text-muted-foreground text-sm">
									<Trans>Recent</Trans>
								</p>
								<div className="flex flex-wrap gap-2">
									{recent.map((entry) => (
										<Chip
											key={entry.id}
											size="lg"
											look="outlined"
											selected={false}
											onClick={() => choose(entry)}
										>
											{entry.name}
										</Chip>
									))}
								</div>
							</div>
						) : null}
						{matches.length === 0 ? (
							<p className="text-muted-foreground">
								<Trans>No item matches that.</Trans>
							</p>
						) : (
							<ul className="flex flex-col gap-2">
								{matches.slice(0, MAX_SHOWN).map((entry) => (
									<li key={entry.id}>
										<button
											type="button"
											onClick={() => choose(entry)}
											className="border-border bg-card hover:bg-accent flex min-h-14 w-full items-center justify-between gap-3 rounded-(--station-control-radius) border px-4 py-2 text-start"
										>
											<span className="min-w-0 font-medium break-words">
												{entry.name}
											</span>
											<span className="text-muted-foreground shrink-0 text-sm">
												{categoryText(entry.category, i18n)}
											</span>
										</button>
									</li>
								))}
							</ul>
						)}
						{matches.length > MAX_SHOWN ? (
							<p className="text-muted-foreground text-sm">
								<Trans>Keep typing to narrow the list.</Trans>
							</p>
						) : null}
					</div>
				)}
				<p className="text-muted-foreground text-sm">
					<Trans>
						Undo is possible for {undoSeconds} seconds after you log something.
					</Trans>
				</p>
			</div>
		</Modal>
	)
}
