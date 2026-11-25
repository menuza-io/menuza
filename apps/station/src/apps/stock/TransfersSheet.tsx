import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type StationTransfer,
	type StationTransferItem,
	type UnitRef,
} from '@repo/inventory'
import { Icon } from '@repo/ui/icon'
import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BigStepper } from './BigStepper.tsx'
import {
	amountInUnit,
	filterItems,
	formatAmount,
	mayReceive,
	requestableItems,
	transferLinesBody,
	transferLists,
	transferSendable,
	transferStartAmount,
	unitChoices,
	unitLabel,
	unitStep,
	unitTakesFractions,
	type TransferLineEdit,
} from './model.ts'
import {
	newClientId,
	queueTransferRequest,
	queueTransferStep,
	StockQueueFullError,
	stockRows,
} from './queue.ts'
import { StockNotices } from './StockNotices.tsx'
import { type StockState } from './useStock.ts'
import { usePos } from '~/lib/store.ts'
import {
	Button,
	Chip,
	fieldClass,
	Input,
	Modal,
	Select,
} from '~/ui/primitives.tsx'

type View =
	| { kind: 'list' }
	| { kind: 'step'; id: string; step: 'send' | 'receive' }
	| { kind: 'request' }

/**
 * Transfers on the Stock app (#515): what this place must send, what is on its
 * way in, and what it asked for; send (tick lines, change amounts, confirm)
 * and receive (tick what arrived; what did not stays as missing in transit),
 * and a branch request (items and amounts only). Quantities only: no price or
 * value is shown anywhere. Each action is saved on the tablet at once and sent
 * when it can be, with the version this tablet read: if the App changed the
 * transfer meanwhile, the office refuses it and the sync screen says so.
 * Needs a till manager, like deliveries.
 */
export function TransfersSheet({
	stock,
	open,
	onClose,
	onToast,
}: {
	stock: StockState
	open: boolean
	onClose: () => void
	onToast: (text: string) => void
}) {
	const { _ } = useLingui()
	const { catalog, ctx, role } = stock
	const menu = usePos((state) => state.snapshot?.menu ?? null)
	const [view, setView] = useState<View>({ kind: 'list' })
	const rows = useLiveQuery(() => stockRows(stock.origin), [stock.origin], [])
	useEffect(() => {
		if (!open) setView({ kind: 'list' })
	}, [open])

	const placeName = (id: string) =>
		menu?.locations.find((place) => place.id === id)?.name ??
		_(t`Another place`)
	const lists = useMemo(
		() =>
			catalog && ctx
				? transferLists(catalog, ctx.locationId)
				: { toSend: [], toReceive: [], asked: [], recent: [] },
		[catalog, ctx],
	)
	// Steps already saved on this tablet and waiting to send.
	const waiting = useMemo(() => {
		const ids = new Map<string, 'send' | 'receive'>()
		for (const row of rows) {
			if (row.status === 'failed') continue
			if (row.kind === 'transfer_send') ids.set(row.payload.transferId, 'send')
			if (row.kind === 'transfer_receive')
				ids.set(row.payload.transferId, 'receive')
		}
		return ids
	}, [rows])
	const waitingRequests = rows.filter(
		(row) => row.kind === 'transfer_request' && row.status !== 'failed',
	).length
	const allowed = catalog ? mayReceive(catalog, role) : false
	const places = (menu?.locations ?? []).filter(
		(place) => place.id !== ctx?.locationId,
	)
	const canAsk = Boolean(
		catalog &&
		(catalog.transferItems?.length ?? 0) > 0 &&
		places.length > 0 &&
		allowed,
	)

	const current =
		view.kind === 'step'
			? ((catalog?.transfers ?? []).find((entry) => entry.id === view.id) ??
				null)
			: null

	const title =
		view.kind === 'request'
			? _(t`Ask for stock`)
			: view.kind === 'step'
				? view.step === 'send'
					? _(t`Send stock`)
					: _(t`Receive stock`)
				: _(t`Transfers`)

	const done = (text: string) => {
		onToast(text)
		setView({ kind: 'list' })
		void stock.sync()
	}

	return (
		<Modal
			open={open}
			onClose={view.kind === 'list' ? onClose : () => setView({ kind: 'list' })}
			title={title}
			size="full"
			footer={
				<div className="flex flex-col gap-2 pb-3 sm:flex-row-reverse">
					<Button size="lg" onClick={onClose}>
						<Trans>Close</Trans>
					</Button>
				</div>
			}
		>
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-5">
				<StockNotices stock={stock} compact />
				{!catalog || !ctx ? (
					<p className="text-muted-foreground">
						<Trans>
							The stock list has not loaded yet. Connect once so this tablet can
							get it.
						</Trans>
					</p>
				) : view.kind === 'request' ? (
					<RequestForm
						stock={stock}
						places={places}
						onCancel={() => setView({ kind: 'list' })}
						onDone={() =>
							done(_(t`Request saved. It goes when the tablet is connected.`))
						}
					/>
				) : view.kind === 'step' && current ? (
					<StepForm
						key={`${current.id}-${view.step}`}
						stock={stock}
						transfer={current}
						step={view.step}
						otherName={placeName(
							view.step === 'send'
								? current.toLocationId
								: current.fromLocationId,
						)}
						onCancel={() => setView({ kind: 'list' })}
						onDone={() =>
							done(
								view.step === 'send'
									? _(t`Send saved. It goes when the tablet is connected.`)
									: _(t`Receipt saved. It goes when the tablet is connected.`),
							)
						}
					/>
				) : (
					<>
						{!allowed ? (
							<p className="text-muted-foreground text-base font-medium">
								<Trans>A manager must sign in to send or receive stock.</Trans>
							</p>
						) : null}
						<Section
							title={_(t`To send`)}
							empty={_(t`Nothing to send.`)}
							transfers={lists.toSend}
							render={(transfer) => {
								const name = placeName(transfer.toLocationId)
								return (
									<TransferCard
										transfer={transfer}
										headline={
											transfer.kind === 'request'
												? _(t`${name} asked for`)
												: _(t`Going to ${name}`)
										}
										waiting={waiting.get(transfer.id) === 'send'}
										action={_(t`Send`)}
										disabled={!allowed}
										onAction={() =>
											setView({ kind: 'step', id: transfer.id, step: 'send' })
										}
									/>
								)
							}}
						/>
						<Section
							title={_(t`On the way in`)}
							empty={_(t`Nothing is on its way.`)}
							transfers={lists.toReceive}
							render={(transfer) => {
								const name = placeName(transfer.fromLocationId)
								return (
									<TransferCard
										transfer={transfer}
										headline={_(t`From ${name}`)}
										waiting={waiting.get(transfer.id) === 'receive'}
										action={_(t`Receive`)}
										disabled={!allowed}
										onAction={() =>
											setView({
												kind: 'step',
												id: transfer.id,
												step: 'receive',
											})
										}
									/>
								)
							}}
						/>
						<Section
							title={_(t`Asked for`)}
							empty={_(t`You have not asked for anything.`)}
							transfers={lists.asked}
							render={(transfer) => {
								const name = placeName(transfer.fromLocationId)
								return (
									<TransferCard
										transfer={transfer}
										headline={_(t`Asked ${name}`)}
									/>
								)
							}}
						/>
						{waitingRequests > 0 ? (
							<p className="text-muted-foreground text-sm">
								{_(
									plural(waitingRequests, {
										one: '# request is saved and waiting to send.',
										other: '# requests are saved and waiting to send.',
									}),
								)}
							</p>
						) : null}
						{lists.recent.length > 0 ? (
							<Section
								title={_(t`Finished`)}
								empty=""
								transfers={lists.recent}
								render={(transfer) => {
									const from = placeName(transfer.fromLocationId)
									const to = placeName(transfer.toLocationId)
									return (
										<TransferCard
											transfer={transfer}
											headline={_(t`${from} to ${to}`)}
										/>
									)
								}}
							/>
						) : null}
						{canAsk ? (
							<div>
								<Button
									size="lg"
									variant="primary"
									onClick={() => setView({ kind: 'request' })}
								>
									<Icon name="plus" className="size-5" />
									<Trans>Ask for stock</Trans>
								</Button>
							</div>
						) : null}
					</>
				)}
			</div>
		</Modal>
	)
}

function Section({
	title,
	empty,
	transfers,
	render,
}: {
	title: string
	empty: string
	transfers: StationTransfer[]
	render: (transfer: StationTransfer) => React.ReactNode
}) {
	return (
		<section aria-label={title} className="flex flex-col gap-2">
			<h3 className="text-xl font-semibold">{title}</h3>
			{transfers.length === 0 ? (
				empty ? (
					<p className="text-muted-foreground text-sm">{empty}</p>
				) : null
			) : (
				<ul className="flex flex-col gap-2">
					{transfers.map((transfer) => (
						<li key={transfer.id}>{render(transfer)}</li>
					))}
				</ul>
			)}
		</section>
	)
}

/** One transfer as a card: who with, what is on it, and what changed. */
function TransferCard({
	transfer,
	headline,
	action,
	onAction,
	disabled = false,
	waiting = false,
}: {
	transfer: StationTransfer
	headline: string
	action?: string
	onAction?: () => void
	disabled?: boolean
	waiting?: boolean
}) {
	const { i18n } = useLingui()
	const short = transfer.lines.filter((line) => (line.missingQuantity ?? 0) > 0)
	return (
		<div
			className="border-border bg-card flex flex-col gap-2 rounded-(--station-panel-radius) border p-4"
			data-testid={`transfer-${transfer.id}`}
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-base font-semibold break-words">
					<span className="text-muted-foreground">#{transfer.number}</span>{' '}
					{headline}
				</p>
				{transfer.changedBySender ? (
					<span className="text-warning text-sm font-medium">
						<Trans>Changed in the app</Trans>
					</span>
				) : null}
			</div>
			<ul className="text-muted-foreground flex flex-col gap-0.5 text-sm">
				{transfer.lines.map((line) => {
					const amount =
						transfer.status === 'received'
							? (line.receivedQuantity ?? 0)
							: (line.sentQuantity ?? line.requestedQuantity)
					const text = formatAmount(
						amountInUnit(amount, line.countUnit, line),
						i18n.locale,
					)
					const unit = unitLabel(line.countUnit, line.units, i18n.locale)
					return (
						<li key={line.itemId} className="break-words">
							<span className="text-foreground font-medium">
								{line.itemName}
							</span>
							{' · '}
							<bdi dir="ltr" className="tnum">
								{text} {unit}
							</bdi>
						</li>
					)
				})}
			</ul>
			{short.length > 0 ? (
				<div
					className="text-warning text-sm font-medium"
					data-testid={`transfer-missing-${transfer.id}`}
				>
					<Trans>Missing in transit:</Trans>{' '}
					{short
						.map((line) => {
							const text = formatAmount(
								amountInUnit(line.missingQuantity ?? 0, line.countUnit, line),
								i18n.locale,
							)
							return `${line.itemName} ${text} ${unitLabel(line.countUnit, line.units, i18n.locale)}`
						})
						.join(', ')}
				</div>
			) : null}
			{waiting ? (
				<p className="text-muted-foreground text-sm">
					<Trans>Saved on this tablet. Waiting to send.</Trans>
				</p>
			) : action && onAction ? (
				<div>
					<Button variant="primary" disabled={disabled} onClick={onAction}>
						{action}
					</Button>
				</div>
			) : null}
		</div>
	)
}

/** Send or receive one transfer: tick the lines, change an amount, confirm. */
function StepForm({
	stock,
	transfer,
	step,
	otherName,
	onCancel,
	onDone,
}: {
	stock: StockState
	transfer: StationTransfer
	step: 'send' | 'receive'
	otherName: string
	onCancel: () => void
	onDone: () => void
}) {
	const { _, i18n } = useLingui()
	const { ctx } = stock
	const [edits, setEdits] = useState<TransferLineEdit[]>(() =>
		transfer.lines.map((line) => ({
			itemId: line.itemId,
			included: step === 'send' || (line.sentQuantity ?? 0) > 0,
			amount: transferStartAmount(line, step),
			unit: line.countUnit,
		})),
	)
	const [problem, setProblem] = useState<string | null>(null)
	const draftId = useRef(newClientId())
	const [busy, setBusy] = useState(false)
	const setEdit = (itemId: string, next: Partial<TransferLineEdit>) =>
		setEdits((current) =>
			current.map((edit) =>
				edit.itemId === itemId ? { ...edit, ...next } : edit,
			),
		)
	const confirm = async () => {
		if (!ctx || busy) return
		const lines = transferLinesBody(transfer, step, edits)
		if (!transferSendable(lines, step)) {
			setProblem(_(t`Enter an amount above zero for at least one item.`))
			return
		}
		setBusy(true)
		try {
			await queueTransferStep(
				ctx,
				step,
				{
					transferId: transfer.id,
					expectedVersion: transfer.version,
					...(lines ? { lines } : {}),
				},
				draftId.current,
			)
			onDone()
		} catch (failure) {
			setProblem(
				failure instanceof StockQueueFullError
					? _(
							t`Too much is waiting to send from this tablet. Connect and let it send first.`,
						)
					: _(t`This could not be saved on the tablet.`),
			)
		} finally {
			setBusy(false)
		}
	}
	return (
		<div className="flex flex-col gap-4" data-testid={`transfer-step-${step}`}>
			<p className="text-xl font-semibold break-words">
				{step === 'send'
					? _(t`Send to ${otherName}`)
					: _(t`Receive from ${otherName}`)}
			</p>
			{transfer.changedBySender ? (
				<p className="text-warning text-sm font-medium">
					<Trans>The app changed what was asked for. Check the amounts.</Trans>
				</p>
			) : null}
			<ul className="flex flex-col gap-3">
				{transfer.lines.map((line) => {
					const edit = edits.find((entry) => entry.itemId === line.itemId)!
					const was =
						line.askedQuantity != null
							? formatAmount(
									amountInUnit(line.askedQuantity, line.countUnit, line),
									i18n.locale,
								)
							: null
					return (
						<li
							key={line.itemId}
							className="border-border bg-card flex flex-col gap-3 rounded-(--station-panel-radius) border p-4"
						>
							<div className="flex flex-wrap items-center justify-between gap-2">
								<p className="text-xl font-semibold break-words">
									{line.itemName}
								</p>
								<Chip
									size="lg"
									look="outlined"
									selected={edit.included}
									aria-pressed={edit.included}
									onClick={() =>
										setEdit(line.itemId, { included: !edit.included })
									}
								>
									{step === 'send' ? _(t`Sending`) : _(t`Arrived`)}
								</Chip>
							</div>
							{was ? (
								<p className="text-muted-foreground text-sm">
									{_(t`Asked for ${was}`)}
								</p>
							) : null}
							{edit.included ? (
								<div className="flex flex-wrap items-start gap-3">
									<BigStepper
										value={edit.amount}
										label={line.itemName}
										step={unitStep(edit.unit)}
										fractions={unitTakesFractions(edit.unit)}
										onChange={(amount) => setEdit(line.itemId, { amount })}
									/>
									<Select
										aria-label={_(t`Unit`)}
										containerClassName="w-44"
										value={edit.unit}
										onChange={(event) =>
											setEdit(line.itemId, {
												unit: event.target.value,
												amount: null,
											})
										}
									>
										{unitChoices(line).map((ref) => (
											<option key={ref} value={ref}>
												{unitLabel(ref, line.units, i18n.locale)}
											</option>
										))}
									</Select>
								</div>
							) : null}
						</li>
					)
				})}
			</ul>
			{problem ? (
				<p role="alert" className="text-destructive text-sm">
					{problem}
				</p>
			) : null}
			<div className="flex flex-col gap-2 sm:flex-row-reverse">
				<Button
					variant="primary"
					size="lg"
					disabled={busy}
					onClick={() => void confirm()}
				>
					{step === 'send' ? (
						<Trans>Confirm sent</Trans>
					) : (
						<Trans>Confirm received</Trans>
					)}
				</Button>
				<Button size="lg" onClick={onCancel}>
					<Trans>Back</Trans>
				</Button>
			</div>
		</div>
	)
}

type RequestLine = {
	item: StationTransferItem
	amount: number | null
	unit: UnitRef
}

/** A branch asks another place for stock: items and amounts only. */
function RequestForm({
	stock,
	places,
	onCancel,
	onDone,
}: {
	stock: StockState
	places: Array<{ id: string; name: string }>
	onCancel: () => void
	onDone: () => void
}) {
	const { _, i18n } = useLingui()
	const { catalog, ctx } = stock
	const [fromId, setFromId] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const [lines, setLines] = useState<RequestLine[]>([])
	const [note, setNote] = useState('')
	const [problem, setProblem] = useState<string | null>(null)
	const draftId = useRef(newClientId())
	const [busy, setBusy] = useState(false)
	const offered = useMemo(
		() => (catalog && fromId ? requestableItems(catalog, fromId) : []),
		[catalog, fromId],
	)
	const matches = useMemo(
		() =>
			filterItems(offered, query).filter(
				(item) => !lines.some((line) => line.item.id === item.id),
			),
		[offered, query, lines],
	)
	const ready =
		fromId !== null &&
		lines.length > 0 &&
		lines.every((line) => line.amount !== null && line.amount > 0)
	const send = async () => {
		if (!ctx || !fromId || !ready || busy) return
		setBusy(true)
		try {
			await queueTransferRequest(
				ctx,
				{
					fromLocationId: fromId,
					lines: lines.map((line) => ({
						itemId: line.item.id,
						amount: line.amount!,
						unit: line.unit,
					})),
					...(note.trim() ? { note: note.trim() } : {}),
				},
				draftId.current,
			)
			onDone()
		} catch (failure) {
			setProblem(
				failure instanceof StockQueueFullError
					? _(
							t`Too much is waiting to send from this tablet. Connect and let it send first.`,
						)
					: _(t`This could not be saved on the tablet.`),
			)
		} finally {
			setBusy(false)
		}
	}
	return (
		<div className="flex flex-col gap-4" data-testid="transfer-request">
			<fieldset className="flex flex-col gap-2">
				<legend className="mb-1 text-base font-semibold">
					<Trans>Ask which place?</Trans>
				</legend>
				<div className="flex flex-wrap gap-2">
					{places.map((place) => (
						<Chip
							key={place.id}
							size="lg"
							look="outlined"
							selected={fromId === place.id}
							aria-pressed={fromId === place.id}
							onClick={() => {
								setFromId(place.id)
								// Items this place does not give to branches are not offered.
								setLines([])
							}}
						>
							{place.name}
						</Chip>
					))}
				</div>
			</fieldset>
			{fromId ? (
				<>
					<ul className="flex flex-col gap-3">
						{lines.map((line) => (
							<li
								key={line.item.id}
								className="border-border bg-card flex flex-col gap-3 rounded-(--station-panel-radius) border p-4"
							>
								<div className="flex items-center justify-between gap-2">
									<p className="text-xl font-semibold break-words">
										{line.item.name}
									</p>
									<Button
										onClick={() =>
											setLines((current) =>
												current.filter(
													(entry) => entry.item.id !== line.item.id,
												),
											)
										}
									>
										<Trans>Remove</Trans>
									</Button>
								</div>
								<div className="flex flex-wrap items-start gap-3">
									<BigStepper
										value={line.amount}
										label={line.item.name}
										step={unitStep(line.unit)}
										fractions={unitTakesFractions(line.unit)}
										onChange={(amount) =>
											setLines((current) =>
												current.map((entry) =>
													entry.item.id === line.item.id
														? { ...entry, amount }
														: entry,
												),
											)
										}
									/>
									<Select
										aria-label={_(t`Unit`)}
										containerClassName="w-44"
										value={line.unit}
										onChange={(event) =>
											setLines((current) =>
												current.map((entry) =>
													entry.item.id === line.item.id
														? {
																...entry,
																unit: event.target.value,
																amount: null,
															}
														: entry,
												),
											)
										}
									>
										{unitChoices(line.item).map((ref) => (
											<option key={ref} value={ref}>
												{unitLabel(ref, line.item.units, i18n.locale)}
											</option>
										))}
									</Select>
								</div>
							</li>
						))}
					</ul>
					<label className="flex flex-col gap-2">
						<span className="text-base font-semibold">
							<Trans>Add an item</Trans>
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
					<ul className="flex flex-col gap-2">
						{matches.slice(0, 30).map((item) => (
							<li key={item.id}>
								<button
									type="button"
									className="border-border bg-card hover:bg-accent flex min-h-14 w-full items-center justify-between gap-3 rounded-(--station-control-radius) border px-4 py-2 text-start"
									onClick={() => {
										setLines((current) => [
											...current,
											{ item, amount: null, unit: item.countUnit },
										])
										setQuery('')
									}}
								>
									<span className="min-w-0 font-medium break-words">
										{item.name}
									</span>
								</button>
							</li>
						))}
					</ul>
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
				</>
			) : null}
			{problem ? (
				<p role="alert" className="text-destructive text-sm">
					{problem}
				</p>
			) : null}
			<div className="flex flex-col gap-2 sm:flex-row-reverse">
				<Button
					variant="primary"
					size="lg"
					disabled={!ready || busy}
					onClick={() => void send()}
				>
					<Trans>Send request</Trans>
				</Button>
				<Button size="lg" onClick={onCancel}>
					<Trans>Back</Trans>
				</Button>
			</div>
		</div>
	)
}
