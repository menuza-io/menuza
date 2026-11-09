import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type StationCountSummary } from '@repo/inventory'
import { Icon, type IconName } from '@repo/ui/icon'
import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { CountScreen } from './CountScreen.tsx'
import { DeliverySheet } from './DeliverySheet.tsx'
import {
	dropFinishedCounts,
	isDone,
	isFinished,
	localCounts,
	type LocalCount,
} from './local.ts'
import { joinCount, startCount } from './queue.ts'
import { StockNotices } from './StockNotices.tsx'
import { SyncSheet } from './SyncSheet.tsx'
import { useStock } from './useStock.ts'
import { WasteSheet } from './WasteSheet.tsx'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'
import { Badge, Button, cn, Modal } from '~/ui/primitives.tsx'

type View = { kind: 'home' } | { kind: 'count'; localId: string }
type Sheet = 'count' | 'waste' | 'delivery' | 'sync' | null

/** An "In progress" card: a count this tablet is working on, or one another device started. */
type Card = {
	key: string
	record: LocalCount | null
	summary: StationCountSummary | null
	title: string | null
	/** Its start has not reached the office yet. */
	pending: boolean
	/** A manager is reviewing it (late entries are still welcome). */
	inReview: boolean
	/** This person said they are done; the count is still the manager's to finish. */
	done: boolean
}

/**
 * The Stock app: three big tiles (Count, Waste, Delivery), the counts in
 * progress, and what is waiting to send. Station is for doing, the App is for
 * deciding: nothing here shows money or stock on hand, edits an item, or
 * approves a count.
 */
export function Stock({
	settings,
	session,
	online,
	onSignIn,
}: {
	settings: PosSettings
	session: Session | null
	online: boolean
	onSignIn: () => void
}) {
	const { _, i18n } = useLingui()
	const stock = useStock(settings, session, online)
	const { catalog, ctx, stats, staffName } = stock
	const [view, setView] = useState<View>({ kind: 'home' })
	const [sheet, setSheet] = useState<Sheet>(null)
	const records = useLiveQuery(
		() => localCounts(stock.origin),
		[stock.origin],
		[],
	)
	const record =
		view.kind === 'count'
			? (records.find((entry) => entry.localId === view.localId) ?? null)
			: null
	// A count a manager approved or cancelled is forgotten here, except while its screen says "This count is finished".
	const openLocalId = view.kind === 'count' ? view.localId : null
	useEffect(() => {
		void dropFinishedCounts(stock.origin, openLocalId).catch(() => {})
	}, [records, openLocalId, stock.origin])

	if (!settings.locationId || !ctx) {
		return (
			<main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
				<Icon name="map-pin-off" className="text-muted-foreground size-10" />
				<h2 className="text-xl font-semibold">
					<Trans>This tablet needs a location</Trans>
				</h2>
				<p className="text-muted-foreground max-w-md">
					<Trans>
						Stock counts one location. Ask a manager to bind this terminal to a
						location in the Menuza app, under Settings, Terminals.
					</Trans>
				</p>
			</main>
		)
	}

	if (view.kind === 'count' && record && catalog) {
		return (
			<main className="flex min-h-0 flex-1 flex-col">
				<CountScreen
					stock={stock}
					record={record}
					onBack={() => setView({ kind: 'home' })}
					onOpenSync={() => setSheet('sync')}
				/>
				<SyncSheet
					stock={stock}
					open={sheet === 'sync'}
					onClose={() => setSheet(null)}
					onSignIn={onSignIn}
				/>
			</main>
		)
	}

	const cards: Card[] = []
	for (const entry of records) {
		if (isFinished(entry)) continue
		const serverId = 'id' in entry.ref ? entry.ref.id : null
		cards.push({
			key: entry.localId,
			record: entry,
			summary: catalog?.counts.find((count) => count.id === serverId) ?? null,
			title: entry.listName,
			pending: serverId === null,
			inReview: entry.serverStatus === 'in_review',
			done: isDone(entry),
		})
	}
	for (const count of catalog?.counts ?? []) {
		if (count.status !== 'counting') continue
		if (cards.some((card) => card.summary?.id === count.id)) continue
		if (records.some((entry) => 'id' in entry.ref && entry.ref.id === count.id))
			continue
		cards.push({
			key: count.id,
			record: null,
			summary: count,
			title: count.listName,
			pending: false,
			inReview: false,
			done: false,
		})
	}

	const open = async (card: Card) => {
		if (!ctx) return
		setSheet(null)
		const local =
			card.record ??
			(card.summary
				? await joinCount(ctx, {
						id: card.summary.id,
						listId: card.summary.listId,
						listName: card.summary.listName,
					})
				: null)
		if (local) setView({ kind: 'count', localId: local.localId })
	}
	const begin = async (list: { id: string | null; name: string | null }) => {
		if (!ctx) return
		const local = await startCount(ctx, list)
		setSheet(null)
		setView({ kind: 'count', localId: local.localId })
		void stock.sync()
	}

	const tiles: Array<{
		key: Exclude<Sheet, 'sync' | null>
		icon: IconName
		title: string
		hint: string
	}> = [
		{
			key: 'count',
			icon: 'list',
			title: _(t`Count`),
			hint: _(t`Count what is on the shelves`),
		},
		{
			key: 'waste',
			icon: 'trash-2',
			title: _(t`Waste`),
			hint: _(t`Log food thrown away`),
		},
		{
			key: 'delivery',
			icon: 'arrow-down-to-line',
			title: _(t`Delivery`),
			hint: _(t`Receive what the supplier brought`),
		},
	]

	return (
		<main aria-label={_(t`Stock`)} className="flex min-h-0 flex-1 flex-col">
			<h2 className="sr-only">
				<Trans>Stock</Trans>
			</h2>
			<StockNotices
				stock={stock}
				onSignIn={onSignIn}
				onOpenSync={() => setSheet('sync')}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
				<div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<p className="text-muted-foreground text-base">
							{staffName ? _(t`Signed in as ${staffName}`) : null}
						</p>
						{stats.waiting > 0 || stats.failed > 0 ? (
							<Button onClick={() => setSheet('sync')}>
								<Icon
									name={stats.failed > 0 ? 'alert-triangle' : 'hard-drive'}
									className="size-4"
								/>
								{stats.failed > 0
									? _(
											plural(stats.failed, {
												one: '# needs attention',
												other: '# need attention',
											}),
										)
									: _(
											plural(stats.waiting, {
												one: '# waiting to send',
												other: '# waiting to send',
											}),
										)}
							</Button>
						) : null}
					</div>
					<div className="grid gap-4 sm:grid-cols-3">
						{tiles.map((tile) => (
							<button
								key={tile.key}
								type="button"
								onClick={() => setSheet(tile.key)}
								className="border-border bg-card hover:bg-accent flex min-h-40 flex-col items-start justify-between gap-4 rounded-(--station-panel-radius) border p-5 text-start transition-colors"
							>
								<span className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-(--station-control-radius)">
									<Icon name={tile.icon} className="size-6" aria-hidden />
								</span>
								<span>
									<span className="block text-2xl font-semibold">
										{tile.title}
									</span>
									<span className="text-muted-foreground block text-sm">
										{tile.hint}
									</span>
								</span>
							</button>
						))}
					</div>
					{cards.length > 0 ? (
						<section
							aria-label={_(t`In progress`)}
							className="flex flex-col gap-3"
						>
							<h3 className="text-xl font-semibold">
								<Trans>In progress</Trans>
							</h3>
							<ul className="grid gap-3 sm:grid-cols-2">
								{cards.map((card) => (
									<li key={card.key}>
										<CountCard
											card={card}
											onOpen={() => void open(card)}
											locale={i18n.locale}
										/>
									</li>
								))}
							</ul>
						</section>
					) : null}
				</div>
			</div>
			<Modal
				open={sheet === 'count'}
				onClose={() => setSheet(null)}
				title={_(t`Count`)}
				size="lg"
			>
				<div className="flex flex-col gap-5 p-4 sm:p-5">
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
					) : (
						<>
							{cards.length > 0 ? (
								<section className="flex flex-col gap-2">
									<h3 className="text-base font-semibold">
										<Trans>Continue a count</Trans>
									</h3>
									<ul className="flex flex-col gap-2">
										{cards.map((card) => (
											<li key={card.key}>
												<CountCard
													card={card}
													onOpen={() => void open(card)}
													locale={i18n.locale}
												/>
											</li>
										))}
									</ul>
								</section>
							) : null}
							<section className="flex flex-col gap-2">
								<h3 className="text-base font-semibold">
									<Trans>Start a count</Trans>
								</h3>
								<ul className="flex flex-col gap-2">
									{catalog.countLists.map((list) => {
										const total = list.itemIds.length
										return (
											<li key={list.id}>
												<StartButton
													title={list.name}
													hint={_(
														plural(total, { one: '# item', other: '# items' }),
													)}
													onClick={() =>
														void begin({ id: list.id, name: list.name })
													}
												/>
											</li>
										)
									})}
									<li>
										<StartButton
											title={_(t`Everything`)}
											hint={_(
												plural(catalog.items.length, {
													one: '# item',
													other: '# items',
												}),
											)}
											onClick={() => void begin({ id: null, name: null })}
										/>
									</li>
								</ul>
							</section>
						</>
					)}
				</div>
			</Modal>
			<WasteSheet
				stock={stock}
				open={sheet === 'waste'}
				onClose={() => setSheet(null)}
			/>
			<DeliverySheet
				stock={stock}
				open={sheet === 'delivery'}
				onClose={() => setSheet(null)}
			/>
			<SyncSheet
				stock={stock}
				open={sheet === 'sync'}
				onClose={() => setSheet(null)}
				onSignIn={onSignIn}
			/>
		</main>
	)
}

function StartButton({
	title,
	hint,
	onClick,
}: {
	title: string
	hint: string
	onClick: () => void
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="border-border bg-card hover:bg-accent flex min-h-16 w-full items-center justify-between gap-3 rounded-(--station-panel-radius) border px-4 py-3 text-start"
		>
			<span className="min-w-0">
				<span className="block font-semibold break-words">{title}</span>
				<span className="text-muted-foreground block text-sm">{hint}</span>
			</span>
			<Icon
				name="chevron-right"
				className="size-5 shrink-0 rtl:rotate-180"
				aria-hidden
			/>
		</button>
	)
}

function CountCard({
	card,
	onOpen,
	locale,
}: {
	card: Card
	onOpen: () => void
	locale: string
}) {
	const { _ } = useLingui()
	const title = card.title ?? _(t`Everything`)
	const summary = card.summary
	const counted = summary ? summary.itemsCounted.toLocaleString(locale) : null
	const total = summary ? summary.itemTotal.toLocaleString(locale) : null
	return (
		<button
			type="button"
			onClick={onOpen}
			className={cn(
				'border-border bg-card hover:bg-accent flex min-h-20 w-full items-center justify-between gap-3 rounded-(--station-panel-radius) border px-4 py-3 text-start',
			)}
		>
			<span className="min-w-0">
				<span className="block text-base font-semibold break-words">
					{title}
				</span>
				<span className="text-muted-foreground block text-sm">
					{counted !== null && total !== null ? (
						<>
							<bdi dir="ltr" className="tnum">
								{counted}
							</bdi>{' '}
							<Trans>of</Trans>{' '}
							<bdi dir="ltr" className="tnum">
								{total}
							</bdi>{' '}
							<Trans>counted</Trans>
						</>
					) : card.inReview ? (
						<Trans>A manager is reviewing this count</Trans>
					) : (
						<Trans>Started on this tablet</Trans>
					)}
				</span>
			</span>
			<span className="flex shrink-0 items-center gap-2">
				{card.pending ? (
					<Badge tone="warning">
						<Trans>Not sent yet</Trans>
					</Badge>
				) : null}
				{card.inReview ? (
					<Badge tone="muted">
						<Trans>Being reviewed</Trans>
					</Badge>
				) : card.done ? (
					<Badge tone="success">
						<Trans>You are done</Trans>
					</Badge>
				) : null}
				<Icon
					name="chevron-right"
					className="size-5 rtl:rotate-180"
					aria-hidden
				/>
			</span>
		</button>
	)
}
