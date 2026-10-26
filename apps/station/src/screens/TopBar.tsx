import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type PosDeviceApps } from '@repo/common/pos-orders'
import { Icon } from '@repo/ui/icon'
import { useLiveQuery } from 'dexie-react-hooks'
import { type ReactNode } from 'react'
import { AppLauncher } from './AppLauncher.tsx'
import { type StationApp } from '~/lib/config.ts'
import { db, type PosOrder } from '~/lib/db.ts'
import { readyDishes, useKitchenTickets } from '~/lib/kitchen-status.ts'
import { isSendable } from '~/lib/orders.ts'
import { usePos } from '~/lib/store.ts'
import { Badge, Button, IconButton, NumberPop, cn } from '~/ui/primitives.tsx'

export function TopBar({
	name,
	logoUrl,
	locationName,
	online,
	refreshing,
	onRefresh,
	onOrders,
	onSettings,
	staffName,
	onLock,
	onShift,
	shiftOpen,
	app = 'pos',
	apps,
	onApp,
	context,
}: {
	context?: ReactNode
	name: string
	logoUrl: string | null
	locationName: string | null
	online: boolean
	refreshing: boolean
	onRefresh: () => void
	onOrders: () => void
	onSettings: () => void
	/** Who is signed in, when the till requires sign-in. */
	staffName?: string | null
	onLock?: () => void
	/** Opens the cash drawer shift; `shiftOpen` marks the button while one is running. */
	onShift: () => void
	shiftOpen: boolean
	/** The Station app on screen, the ones this terminal offers, and the switch. */
	app?: StationApp
	apps?: PosDeviceApps
	onApp?: (app: StationApp) => void
}) {
	const { _ } = useLingui()
	const settings = usePos((s) => s.settings)
	// Orders held for another restaurant (or taken in demo mode) are not "sending".
	const waiting = useLiveQuery(
		() =>
			db.orders
				.where('sync')
				.anyOf('pending', 'syncing')
				.filter((o) => isSendable(o, settings))
				.count(),
		[settings.slug, settings.demo],
		0,
	)
	const openTabs = useLiveQuery(
		() =>
			db.orders
				.where('status')
				.equals('open')
				.filter((o) => !o.transferredTo)
				.count(),
		[],
		0,
	)
	// Food at the pass for an open tab: the register says so, so someone runs it.
	const openOrders = useLiveQuery(
		() =>
			db.orders
				.where('status')
				.equals('open')
				.filter((o) => !o.transferredTo)
				.toArray(),
		[],
		[] as PosOrder[],
	)
	const kitchen = useKitchenTickets(app === 'pos' && openOrders.length > 0)
	const readyFood = openOrders.reduce(
		(sum, order) => sum + readyDishes(order, kitchen?.get(order.id)),
		0,
	)
	const rejected = useLiveQuery(
		() => db.orders.where('sync').equals('rejected').count(),
		[],
		0,
	)
	const rejectedShifts = useLiveQuery(
		() => db.shifts.where('sync').equals('rejected').count(),
		[],
		0,
	)

	return (
		<header
			className="station-header header-safe border-border bg-card flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 pb-2 sm:px-4"
			data-app={app}
		>
			<h1 className="sr-only">{name}</h1>
			<AppLauncher
				compact={Boolean(context)}
				name={name}
				logoUrl={logoUrl}
				locationName={locationName}
				app={app}
				apps={apps}
				onApp={onApp}
			/>
			{context ? (
				<div className="station-context order-last min-w-0 basis-full 2xl:order-none 2xl:flex-1 2xl:basis-auto">
					{context}
				</div>
			) : null}
			<div className="station-header-actions flex shrink-0 items-center gap-1 sm:gap-2">
				{/* A live region: going offline, sending and refusals are announced. */}
				<div
					role="status"
					className="flex min-h-11 min-w-11 shrink-0 items-center justify-center"
				>
					<SyncStatus
						key={
							rejected > 0 || rejectedShifts > 0
								? 'rejected'
								: !online
									? 'offline'
									: waiting > 0
										? 'sending'
										: 'online'
						}
						online={online}
						waiting={waiting}
						rejected={rejected}
						rejectedShifts={rejectedShifts}
					/>
				</div>
				{app === 'pos' ? (
					<>
						<Button
							variant="ghost"
							aria-label={[
								openTabs > 0
									? _(
											plural(openTabs, {
												one: 'Orders, # open tab',
												other: 'Orders, # open tabs',
											}),
										)
									: _(t`Orders`),
								readyFood > 0
									? _(
											plural(readyFood, {
												one: '# dish ready at the pass',
												other: '# dishes ready at the pass',
											}),
										)
									: null,
							]
								.filter(Boolean)
								.join(', ')}
							onClick={onOrders}
							className="relative w-11 px-0 sm:w-auto sm:px-4"
						>
							<Icon name="receipt-text" className="size-5 shrink-0" />
							<span className="hidden sm:inline">
								<Trans>Orders</Trans>
							</span>
							{openTabs > 0 ? (
								// The count pops in when the first tab opens (notification badge).
								<span
									className="t-badge absolute end-0 top-0 sm:static"
									data-open="true"
									aria-hidden
								>
									<span className="t-badge-dot tnum bg-primary text-primary-foreground flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-semibold sm:h-6 sm:min-w-6 sm:px-1.5">
										<NumberPop value={String(openTabs)} />
									</span>
								</span>
							) : null}
							{readyFood > 0 ? (
								<span
									aria-hidden
									className="dish-status t-pop-in absolute -end-1 bottom-0 sm:static"
									data-status="ready"
								>
									<span className="dish-status-dot" />
									<span className="hidden sm:inline">
										{_(plural(readyFood, { one: '# ready', other: '# ready' }))}
									</span>
								</span>
							) : null}
						</Button>
					</>
				) : null}
				{app === 'pos' ? (
					<span
						aria-hidden
						className="bg-border mx-1 hidden h-5 w-px shrink-0 sm:block"
					/>
				) : null}
				<div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
					{app === 'pos' ? (
						<>
							<span className="hidden sm:inline-flex">
								<IconButton
									label={_(t`Refresh menu`)}
									onClick={onRefresh}
									disabled={!online || refreshing}
								>
									<Icon
										name="refresh-cw"
										className={cn('size-5', refreshing && 'animate-spin')}
										aria-hidden
									/>
								</IconButton>
							</span>
							<IconButton
								label={shiftOpen ? _(t`Shift (open)`) : _(t`Shift`)}
								onClick={onShift}
							>
								<Icon
									name="wallet"
									className={cn(
										'size-5 transition-colors',
										shiftOpen && 'text-success',
									)}
								/>
							</IconButton>
						</>
					) : null}
					<IconButton label={_(t`Settings`)} onClick={onSettings}>
						<Icon name="settings" className="size-5" />
					</IconButton>
					{onLock ? (
						<IconButton
							label={
								staffName
									? _(t`Lock the till, signed in as ${staffName}`)
									: _(t`Lock the till`)
							}
							onClick={onLock}
						>
							<Icon name="lock" className="size-5" aria-hidden />
						</IconButton>
					) : null}
				</div>
			</div>
		</header>
	)
}

function SyncStatus({
	online,
	waiting,
	rejected,
	rejectedShifts,
}: {
	online: boolean
	waiting: number
	rejected: number
	rejectedShifts: number
}) {
	const { _ } = useLingui()
	if (rejected > 0 || rejectedShifts > 0) {
		const total = rejected + rejectedShifts
		const label =
			rejectedShifts === 0
				? plural(rejected, {
						one: '# order needs attention',
						other: '# orders need attention',
					})
				: rejected === 0
					? plural(rejectedShifts, {
							one: '# shift needs attention',
							other: '# shifts need attention',
						})
					: plural(total, {
							one: '# upload needs attention',
							other: '# uploads need attention',
						})
		return (
			<Badge tone="danger" className="">
				<Icon name="alert-triangle" className="size-3.5 shrink-0" aria-hidden />
				{/* On a phone only the count shows; the words are still read out. */}
				<span className="sm:hidden" aria-hidden>
					{total}
				</span>
				<span className="sr-only sm:not-sr-only">{label}</span>
			</Badge>
		)
	}
	if (!online) {
		return (
			<Badge tone="warning" className="h-8 px-3 text-sm">
				<Icon name="cloud-off" className="size-4" />
				<span className="hidden sm:inline">
					{waiting > 0 ? (
						<Trans>Offline · {waiting} saved</Trans>
					) : (
						<Trans>Offline · selling normally</Trans>
					)}
				</span>
				<span
					className={cn('sm:hidden', waiting === 0 && 'max-[359px]:sr-only')}
				>
					{waiting > 0 ? waiting : <Trans>Offline</Trans>}
				</span>
			</Badge>
		)
	}
	if (waiting > 0) {
		return (
			<Badge tone="primary" className="h-8 px-3 text-sm">
				<Icon name="refresh-cw" className="size-3.5 animate-spin" />{' '}
				<span className="hidden sm:inline">
					<Trans>Sending</Trans>{' '}
				</span>
				<NumberPop value={String(waiting)} className="tnum" />
			</Badge>
		)
	}
	return (
		<span
			title={_(t`Online · all sent`)}
			className="flex size-8 items-center justify-center"
		>
			<span
				className="t-pop-in bg-success size-2 shrink-0 rounded-full"
				aria-hidden
			/>
			<span className="sr-only">
				<Trans>Online · all sent</Trans>
			</span>
		</span>
	)
}
