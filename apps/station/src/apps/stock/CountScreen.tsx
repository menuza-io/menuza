import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	stationCountSheetSchema,
	type StationItem,
	type UnitRef,
} from '@repo/inventory'
import { Icon } from '@repo/ui/icon'
import { useLiveQuery } from 'dexie-react-hooks'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BigStepper } from './BigStepper.tsx'
import {
	loadCachedSheet,
	localValues,
	saveCachedSheet,
	type LocalCount,
} from './local.ts'
import { categoryText, failureText } from './messages.ts'
import {
	convertAmount,
	countProgress,
	countTabs,
	rowKey,
	tabProgress,
	unitChoices,
	unitLabel,
	unitStep,
	unitTakesFractions,
	type CountValue,
	type CountValues,
} from './model.ts'
import {
	CountClosedError,
	saveCountEntry,
	sendCount,
	StockQueueFullError,
} from './queue.ts'
import { type StockState } from './useStock.ts'
import { db } from '~/lib/db.ts'
import { Badge, Button, Chip, cn, Modal, Select } from '~/ui/primitives.tsx'

/** Taps within this window are one entry (the outbox replaces a waiting one), and one send. */
const SEND_DELAY_MS = 1_500

type RowState = 'saved' | 'waiting' | 'failed'

/**
 * Counting, sized for a tablet: area tabs in shelf order, big steppers with ¼ ½
 * ¾, a unit switch per row and "32 of 48". No expected figure and no last
 * count is anywhere on it, so nobody copies a number. Everything typed is
 * saved on the tablet and queued at once (`saveCountEntry`); the little mark
 * on each row says whether it is waiting, sent or refused.
 */
export function CountScreen({
	stock,
	record,
	onBack,
	onOpenSync,
}: {
	stock: StockState
	record: LocalCount
	onBack: () => void
	onOpenSync: () => void
}) {
	const { _, i18n } = useLingui()
	const { catalog, ctx, api, origin, reachable } = stock
	const [values, setValues] = useState<CountValues>({})
	const [loaded, setLoaded] = useState(false)
	const [elsewhere, setElsewhere] = useState<ReadonlySet<string>>(new Set())
	const [activeTab, setActiveTab] = useState<string | null>(null)
	const [confirming, setConfirming] = useState(false)
	const [problem, setProblem] = useState<string | null>(null)
	const serverId = 'id' in record.ref ? record.ref.id : null

	// What was typed here before (this tablet's copy), then what the server says
	// this person typed (a count joined from another device), without overwriting.
	useEffect(() => {
		let alive = true
		void (async () => {
			const mine = await localValues(origin, record.localId)
			if (alive) {
				setValues(mine)
				setLoaded(true)
			}
			if (!serverId) return
			const fromSheet = async () => {
				const cachedSheet = await loadCachedSheet(origin, serverId)
				if (reachable && stock.hasSession) {
					try {
						const sheet = await api.countSheet(serverId)
						await saveCachedSheet(origin, serverId, sheet)
						return sheet
					} catch {
						/* the copy on the tablet will do */
					}
				}
				const parsed = stationCountSheetSchema.safeParse(cachedSheet)
				return parsed.success ? parsed.data : null
			}
			const sheet = await fromSheet()
			if (!alive || !sheet) return
			const counted = new Set<string>()
			const typed: CountValues = {}
			for (const area of sheet.areas)
				for (const item of area.items) {
					if (item.quantity !== null) counted.add(item.itemId)
					if (item.mine)
						typed[rowKey(item.itemId, area.areaId)] = {
							amount: item.mine.amount,
							unit: item.mine.unit,
						}
				}
			setElsewhere(counted)
			setValues((current) => ({ ...typed, ...current }))
		})()
		return () => {
			alive = false
		}
	}, [origin, record.localId, serverId, api, reachable, stock.hasSession])

	const scope = useMemo(() => {
		if (!catalog || !record.listId) return null
		const list = catalog.countLists.find((entry) => entry.id === record.listId)
		return list ? new Set(list.itemIds) : null
	}, [catalog, record.listId])
	const tabs = useMemo(
		() => (catalog ? countTabs(catalog, scope) : []),
		[catalog, scope],
	)
	const items = useMemo(
		() => new Map(catalog?.items.map((item) => [item.id, item]) ?? []),
		[catalog],
	)
	const tab = tabs.find((entry) => entry.key === activeTab) ?? tabs[0] ?? null
	const progress = countProgress(tabs, values, elsewhere)

	// Which rows are still on their way, and which were refused.
	const marks = useLiveQuery(
		async () => {
			const found = new Map<string, RowState>()
			await db.stockQueue
				.filter((row) => row.origin === origin && row.kind === 'count_entry')
				.each((row) => {
					if (row.kind !== 'count_entry') return
					const ref = row.payload.count
					const mine =
						('id' in ref && serverId !== null && ref.id === serverId) ||
						('clientId' in ref && ref.clientId === record.localId)
					if (!mine) return
					const key = rowKey(row.payload.entry.itemId, row.payload.entry.areaId)
					if (row.status === 'failed') found.set(key, 'failed')
					else if (found.get(key) !== 'failed') found.set(key, 'waiting')
				})
			return found
		},
		[origin, serverId, record.localId],
		new Map<string, RowState>(),
	)

	const timer = useRef<number | undefined>(undefined)
	const chain = useRef<Promise<void>>(Promise.resolve())
	useEffect(() => () => window.clearTimeout(timer.current), [])
	const commit = useCallback(
		(itemId: string, areaId: string | null, next: CountValue) => {
			if (!ctx) return
			setProblem(null)
			setValues((current) => ({ ...current, [rowKey(itemId, areaId)]: next }))
			chain.current = chain.current
				.then(() =>
					saveCountEntry(ctx, record.localId, {
						itemId,
						areaId,
						amount: next.amount,
						unit: next.unit,
					}),
				)
				.then(() => {
					window.clearTimeout(timer.current)
					timer.current = window.setTimeout(
						() => void stock.sync(),
						SEND_DELAY_MS,
					)
				})
				.catch((failure: unknown) => {
					setProblem(
						failure instanceof CountClosedError
							? _(t`This count was already sent for review.`)
							: failure instanceof StockQueueFullError
								? _(
										t`Too much is waiting to send from this tablet. Connect and let it send first.`,
									)
								: _(t`This could not be saved on the tablet.`),
					)
				})
		},
		[ctx, record.localId, stock, _],
	)

	async function sendNow() {
		if (!ctx) return
		window.clearTimeout(timer.current)
		// After every entry still being saved.
		await chain.current
		try {
			await sendCount(ctx, record.localId)
			void stock.sync()
		} catch {
			setProblem(_(t`This could not be saved on the tablet.`))
		}
	}

	if (!catalog || !ctx) return null
	const waitingCount = marks.size
	const failedCount = [...marks.values()].filter((m) => m === 'failed').length

	if (record.startFailed) {
		return (
			<section className="mx-auto flex w-full max-w-xl flex-col gap-4 p-5">
				<h2 className="text-xl font-semibold">
					<Trans>This count could not be started</Trans>
				</h2>
				<p className="text-muted-foreground">
					{failureText(record.startFailed, i18n)}
				</p>
				<div className="flex gap-2">
					<Button onClick={onBack}>
						<Trans>Back</Trans>
					</Button>
					<Button variant="primary" onClick={onOpenSync}>
						<Trans>See what is waiting</Trans>
					</Button>
				</div>
			</section>
		)
	}

	if (record.status === 'sent') {
		return (
			<section className="mx-auto flex w-full max-w-xl flex-col gap-4 p-5">
				<div className="flex items-center gap-3">
					<Icon name="check-circle" className="text-success size-8" />
					<h2 className="text-xl font-semibold">
						<Trans>Sent for review</Trans>
					</h2>
				</div>
				<p className="text-muted-foreground">
					<Trans>
						Your part of the count is done. A manager reviews and approves it in
						the Menuza app. Nothing more can be added from this tablet.
					</Trans>
				</p>
				{waitingCount > 0 ? (
					<p role="status" className="text-warning text-sm">
						<Trans>
							The last entries are still on their way to the office.
						</Trans>
					</p>
				) : null}
				<div>
					<Button variant="primary" onClick={onBack}>
						<Trans>Back to Stock</Trans>
					</Button>
				</div>
			</section>
		)
	}

	const title = record.listName ?? _(t`Everything`)
	return (
		<section
			className="flex min-h-0 flex-1 flex-col"
			aria-label={_(t`Counting ${title}`)}
		>
			<div className="border-border bg-card flex flex-wrap items-center gap-3 border-b px-4 py-3">
				<Button
					variant="ghost"
					onClick={onBack}
					aria-label={_(t`Back to Stock`)}
				>
					<Icon name="arrow-left" className="size-5 rtl:rotate-180" />
				</Button>
				<div className="min-w-0 flex-1">
					<h2 className="truncate text-xl font-semibold">{title}</h2>
					<p className="text-muted-foreground text-sm" role="status">
						<bdi dir="ltr" className="tnum">
							{i18n.number(progress.counted)}
						</bdi>{' '}
						<Trans>of</Trans>{' '}
						<bdi dir="ltr" className="tnum">
							{i18n.number(progress.total)}
						</bdi>{' '}
						<Trans>counted</Trans>
						{waitingCount - failedCount > 0 ? (
							<>
								{' · '}
								{_(reachable ? t`Sending` : t`Saved on this tablet`)}
							</>
						) : null}
					</p>
				</div>
				<Button
					variant="primary"
					size="lg"
					onClick={() => setConfirming(true)}
					disabled={!loaded}
				>
					<Icon name="send" className="size-5" />
					<Trans>Send for review</Trans>
				</Button>
			</div>
			{failedCount > 0 ? (
				<div
					role="alert"
					className="notice-warning flex flex-wrap items-center gap-3 px-4 py-2 text-sm"
				>
					<Icon name="alert-triangle" className="size-4 shrink-0" />
					<p className="min-w-0 flex-1">
						{_(
							plural(failedCount, {
								one: '# entry was not sent.',
								other: '# entries were not sent.',
							}),
						)}
					</p>
					<Button onClick={onOpenSync}>
						<Trans>See why</Trans>
					</Button>
				</div>
			) : null}
			{problem ? (
				<p role="alert" className="notice-warning px-4 py-2 text-sm">
					{problem}
				</p>
			) : null}
			{tabs.length === 0 ? (
				<p className="text-muted-foreground p-6">
					<Trans>There is nothing on this count yet.</Trans>
				</p>
			) : (
				<>
					<nav
						aria-label={_(t`Areas`)}
						className="border-border bg-card flex gap-2 overflow-x-auto border-b px-4 py-2"
					>
						{tabs.map((entry) => {
							const done = tabProgress(entry, values, elsewhere)
							const name = entry.name ?? _(t`Not in an area`)
							const counted = i18n.number(done.counted)
							const total = i18n.number(done.total)
							return (
								<Chip
									key={entry.key}
									size="lg"
									look="outlined"
									selected={entry.key === tab?.key}
									aria-current={entry.key === tab?.key ? 'page' : undefined}
									onClick={() => setActiveTab(entry.key)}
									className="shrink-0"
								>
									<span>{name}</span>
									<Badge
										tone={done.counted === done.total ? 'success' : 'muted'}
									>
										<bdi dir="ltr" className="tnum">
											{counted}/{total}
										</bdi>
									</Badge>
								</Chip>
							)
						})}
					</nav>
					<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
						<ul className="mx-auto grid max-w-5xl gap-3 lg:grid-cols-2">
							{tab?.itemIds.map((itemId) => {
								const item = items.get(itemId)
								if (!item) return null
								const key = rowKey(itemId, tab.areaId)
								return (
									<CountRow
										key={key}
										item={item}
										areaId={tab.areaId}
										value={values[key] ?? null}
										state={marks.get(key) ?? 'saved'}
										countedElsewhere={elsewhere.has(itemId)}
										locale={i18n.locale}
										onCommit={commit}
									/>
								)
							})}
						</ul>
					</div>
				</>
			)}
			<Modal
				open={confirming}
				onClose={() => setConfirming(false)}
				title={_(t`Send for review?`)}
				footer={
					<div className="flex flex-col gap-2 pb-3 sm:flex-row-reverse">
						<Button
							variant="primary"
							size="lg"
							onClick={() => {
								setConfirming(false)
								void sendNow()
							}}
						>
							<Trans>Send for review</Trans>
						</Button>
						<Button size="lg" onClick={() => setConfirming(false)}>
							<Trans>Keep counting</Trans>
						</Button>
					</div>
				}
			>
				<div className="flex flex-col gap-3 p-5">
					<p>
						{_(
							plural(progress.total, {
								one: '# item is on this count.',
								other: '# items are on this count.',
							}),
						)}{' '}
						<bdi dir="ltr" className="tnum font-semibold">
							{i18n.number(progress.counted)}
						</bdi>{' '}
						<Trans>counted.</Trans>
					</p>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Items you did not count stay as they were. After this, nothing
							more can be added from this tablet. A manager approves the count
							in the Menuza app.
						</Trans>
					</p>
				</div>
			</Modal>
		</section>
	)
}

const CountRow = memo(function CountRow({
	item,
	areaId,
	value,
	state,
	countedElsewhere,
	locale,
	onCommit,
}: {
	item: StationItem
	areaId: string | null
	value: CountValue | null
	state: RowState
	countedElsewhere: boolean
	locale: string
	onCommit: (itemId: string, areaId: string | null, next: CountValue) => void
}) {
	const { _, i18n } = useLingui()
	const unit: UnitRef = value?.unit ?? item.countUnit
	const choices = unitChoices(item)
	const amount = value?.amount ?? null
	const name = item.name
	const category = categoryText(item.category, i18n)
	const counted = amount !== null
	return (
		<li
			className={cn(
				'border-border bg-card flex flex-col gap-3 rounded-(--station-panel-radius) border p-4',
				counted && 'border-success/40',
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-base font-semibold break-words">{item.name}</p>
					<p className="text-muted-foreground text-sm break-words">
						{category}
						{countedElsewhere && !counted ? (
							<>
								{' · '}
								<Trans>Someone already counted this</Trans>
							</>
						) : null}
					</p>
				</div>
				<SaveMark state={state} counted={counted} />
			</div>
			<div className="flex flex-wrap items-start gap-3">
				<BigStepper
					value={amount}
					label={name}
					step={unitStep(unit)}
					fractions={unitTakesFractions(unit)}
					allowClear
					onChange={(next) => onCommit(item.id, areaId, { amount: next, unit })}
				/>
				{choices.length > 1 ? (
					<Select
						aria-label={_(t`Unit for ${name}`)}
						containerClassName="w-40"
						value={unit}
						onChange={(event) => {
							const to = event.target.value
							const converted =
								amount === null ? null : convertAmount(amount, unit, to, item)
							onCommit(item.id, areaId, { amount: converted, unit: to })
						}}
					>
						{choices.map((ref) => (
							<option key={ref} value={ref}>
								{unitLabel(ref, item.units, locale)}
							</option>
						))}
					</Select>
				) : (
					<span className="text-muted-foreground self-center text-base">
						<bdi dir="ltr">{unitLabel(unit, item.units, locale)}</bdi>
					</span>
				)}
			</div>
		</li>
	)
})

/** Waiting on the tablet, sent, or refused: a mark and, for assistive technology, the words. */
function SaveMark({ state, counted }: { state: RowState; counted: boolean }) {
	const { _ } = useLingui()
	if (!counted && state === 'saved') return null
	const label =
		state === 'failed'
			? _(t`Not sent`)
			: state === 'waiting'
				? _(t`Saved on this tablet`)
				: _(t`Sent`)
	return (
		<span
			className={cn(
				'flex shrink-0 items-center gap-1 text-sm',
				state === 'failed'
					? 'text-destructive'
					: state === 'waiting'
						? 'text-warning'
						: 'text-success',
			)}
		>
			<Icon
				name={
					state === 'failed'
						? 'alert-triangle'
						: state === 'waiting'
							? 'hard-drive'
							: 'check'
				}
				className="size-4"
				aria-hidden
			/>
			<span className="max-sm:sr-only">{label}</span>
		</span>
	)
}
