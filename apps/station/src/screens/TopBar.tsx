import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
	CloudOff,
	Lock,
	RefreshCw,
	ReceiptText,
	Settings,
	TriangleAlert,
	Wallet,
} from 'lucide-react'
import { db } from '~/lib/db.ts'
import { isSendable } from '~/lib/orders.ts'
import { usePos } from '~/lib/store.ts'
import { Badge, IconButton, cn } from '~/ui/primitives.tsx'

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
}: {
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
		<header className="border-border bg-card pt-safe flex h-16 shrink-0 items-center gap-2 border-b px-3 sm:gap-3 sm:px-4">
			<div className="flex min-w-0 flex-1 items-center gap-3 sm:flex-none">
				{logoUrl ? (
					<img
						src={logoUrl}
						alt=""
						className="size-10 rounded-xl object-cover"
					/>
				) : (
					<div className="bg-primary text-primary-foreground flex size-10 items-center justify-center rounded-xl text-lg font-bold">
						{name.slice(0, 1).toUpperCase()}
					</div>
				)}
				<div className="min-w-0 leading-tight">
					<h1 className="truncate text-lg font-bold">{name}</h1>
					{locationName ? (
						<p className="text-muted-foreground hidden truncate text-sm sm:block">
							{locationName}
						</p>
					) : null}
				</div>
			</div>

			<div className="ms-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
				{onLock ? (
					<button
						type="button"
						onClick={onLock}
						aria-label={
							staffName
								? _(t`Lock the till, signed in as ${staffName}`)
								: _(t`Lock the till`)
						}
						className="border-border bg-card hover:bg-accent inline-flex h-11 items-center gap-2 rounded-xl border px-3 text-sm font-semibold transition active:scale-95"
					>
						<Lock className="size-4" />
						<span className="hidden max-w-28 truncate md:inline">
							{staffName}
						</span>
					</button>
				) : null}
				{/* A live region: going offline, sending and refusals are announced. */}
				<div role="status" className="flex items-center">
					<SyncStatus
						online={online}
						waiting={waiting}
						rejected={rejected}
						rejectedShifts={rejectedShifts}
					/>
				</div>
				<span className="hidden sm:inline-flex">
					<IconButton
						label={_(t`Refresh menu`)}
						onClick={onRefresh}
						disabled={!online || refreshing}
					>
						<RefreshCw className={cn('size-5', refreshing && 'animate-spin')} />
					</IconButton>
				</span>
				<button
					type="button"
					aria-label={
						openTabs > 0
							? _(
									plural(openTabs, {
										one: 'Orders, # open tab',
										other: 'Orders, # open tabs',
									}),
								)
							: _(t`Orders`)
					}
					onClick={onOrders}
					className="border-border bg-card hover:bg-accent inline-flex h-11 items-center gap-2 rounded-xl border px-3 text-sm font-semibold transition active:scale-95 sm:px-4"
				>
					<ReceiptText className="size-5" />
					<span className="hidden sm:inline">
						<Trans>Orders</Trans>
					</span>
					{openTabs > 0 ? (
						<span
							className="tnum mono bg-primary text-primary-foreground flex min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-bold"
							aria-hidden
						>
							{openTabs}
						</span>
					) : null}
				</button>
				<IconButton
					label={shiftOpen ? _(t`Shift (open)`) : _(t`Shift`)}
					onClick={onShift}
				>
					<Wallet className={cn('size-5', shiftOpen && 'text-success')} />
				</IconButton>
				<IconButton label={_(t`Settings`)} onClick={onSettings}>
					<Settings className="size-5" />
				</IconButton>
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
			<Badge tone="danger">
				<TriangleAlert className="size-3.5 shrink-0" aria-hidden />
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
				<CloudOff className="size-4" />
				<span className="hidden sm:inline">
					{waiting > 0 ? (
						<Trans>Offline · {waiting} saved</Trans>
					) : (
						<Trans>Offline · selling normally</Trans>
					)}
				</span>
				<span className="sm:hidden">
					{waiting > 0 ? waiting : <Trans>Offline</Trans>}
				</span>
			</Badge>
		)
	}
	if (waiting > 0) {
		return (
			<Badge tone="primary" className="h-8 px-3 text-sm">
				<RefreshCw className="size-3.5 animate-spin" />{' '}
				<span className="hidden sm:inline">
					<Trans>Sending</Trans>{' '}
				</span>
				{waiting}
			</Badge>
		)
	}
	return (
		<>
			{/* On a phone, "all is well" is a dot: words are for when something needs a look. */}
			<span
				role="img"
				aria-label={_(t`Online`)}
				className="bg-success size-2.5 shrink-0 rounded-full sm:hidden"
			/>
			<span className="hidden sm:inline-flex">
				<Badge tone="success" className="h-8 px-3 text-sm">
					<span className="bg-success size-2 rounded-full" />{' '}
					<Trans>Online · all sent</Trans>
				</Badge>
			</span>
		</>
	)
}
