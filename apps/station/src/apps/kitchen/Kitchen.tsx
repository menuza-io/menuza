import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	kdsTicketStage,
	type KdsCommand,
	type KdsStage,
	type KdsTicket,
} from '@repo/common/kds'
import {
	Empty,
	EmptyHeader,
	EmptyTitle,
	EmptyDescription,
} from '@repo/ui/empty'
import { Icon } from '@repo/ui/icon'
import { Item, ItemMedia, ItemContent, ItemActions } from '@repo/ui/item'
import { useEffect, useMemo, useState } from 'react'
import { chime, chimeReady, unlockChime } from './chime.ts'
import { KitchenSettings } from './KitchenSettings.tsx'
import {
	allDayCounts,
	averageTicketMinutes,
	nextKitchenStage,
	stationStage,
	visibleTickets,
	workFiredAt,
	type KitchenView,
} from './model.ts'
import { useKitchen } from './useKitchen.ts'
import { categoryItems } from '~/lib/catalog.ts'
import { type PosSettings } from '~/lib/config.ts'
import { menuText } from '~/lib/menu-text.ts'
import { type Session } from '~/lib/signin.ts'
import { type MenuCategory, type MenuItem } from '~/lib/types.ts'
import { SoftText } from '~/ui/motion.tsx'
import {
	Badge,
	Button,
	cn,
	IconButton,
	NumberPop,
	Reveal,
	Segmented,
	Select,
} from '~/ui/primitives.tsx'

/** How long new work stays ringed on the board. */
const FRESH_MS = 15_000

/**
 * The dishes the board last showed, kept in memory past the screen itself: on a
 * tablet that switches between the register and the kitchen, work that came in
 * meanwhile still rings when the kitchen opens again.
 */
let lastBoard: { scope: string; marks: Set<string> } | null = null

type Preference = {
	stationId: string | null
	channel: string
	view: KitchenView
	/** The "all day" strip: how many of each dish are still to make. */
	allDay: boolean
	/** A chime when a ticket comes in or a table adds dishes. */
	sound: boolean
}
const preferenceKey = (settings: PosSettings) =>
	`station.kitchen.view:${settings.tenantApiUrl}:${settings.slug}:${settings.locationId ?? ''}`
function readPreference(key: string): Preference {
	try {
		const raw = JSON.parse(
			localStorage.getItem(key) ?? 'null',
		) as Partial<Preference> | null
		return {
			stationId: typeof raw?.stationId === 'string' ? raw.stationId : null,
			channel: ['counter', 'phone', 'online'].includes(raw?.channel ?? '')
				? raw!.channel!
				: 'all',
			view:
				raw?.view === 'done' || raw?.view === 'scheduled' ? raw.view : 'active',
			allDay: raw?.allDay === true,
			sound: raw?.sound === true,
		}
	} catch {
		return {
			stationId: null,
			channel: 'all',
			view: 'active',
			allDay: false,
			sound: false,
		}
	}
}

export function Kitchen({
	settings,
	session,
	online,
	categories,
	timeZone,
	onSignIn,
	renderHeader = (controls) => controls,
}: {
	renderHeader?: (controls?: React.ReactNode) => React.ReactNode
	settings: PosSettings
	session: Session | null
	online: boolean
	categories: MenuCategory[]
	timeZone?: string
	onSignIn: () => void
}) {
	const { _, i18n } = useLingui()
	// Demo mode's kitchen lives on this tablet and works with no network.
	const reachable = online || settings.demo
	const kitchen = useKitchen(settings, session, reachable)
	const { feed, error, stale, busy, now } = kitchen
	const [preference, setPreference] = useState(() =>
		readPreference(preferenceKey(settings)),
	)
	const [configuring, setConfiguring] = useState(false)
	const [fullscreen, setFullscreen] = useState(
		() =>
			typeof document !== 'undefined' && Boolean(document.fullscreenElement),
	)
	// Leaving full screen with Esc (or the system) changes the button too.
	useEffect(() => {
		const changed = () => setFullscreen(Boolean(document.fullscreenElement))
		document.addEventListener('fullscreenchange', changed)
		return () => document.removeEventListener('fullscreenchange', changed)
	}, [])
	const items = useMemo(
		() =>
			new Map(categories.flatMap(categoryItems).map((item) => [item.id, item])),
		[categories],
	)
	const select = (patch: Partial<Preference>) => {
		const next = { ...preference, ...patch }
		setPreference(next)
		try {
			localStorage.setItem(preferenceKey(settings), JSON.stringify(next))
		} catch {
			/* device-local preference only */
		}
	}
	const stationId = feed?.config.stations.some(
		(station) => station.id === preference.stationId,
	)
		? preference.stationId
		: null
	const tickets = useMemo(
		() =>
			feed
				? visibleTickets(
						feed.tickets,
						feed.config,
						{ ...preference, stationId },
						now,
					)
				: [],
		[feed, preference, stationId, now],
	)
	// How long the line is taking: the last two hours, firing to cleared.
	const average = useMemo(
		() =>
			feed
				? averageTicketMinutes(
						// What this screen makes: its station and source.
						visibleTickets(
							feed.tickets,
							feed.config,
							{ stationId, channel: preference.channel, view: 'done' },
							now,
						),
						feed.config,
						now,
					)
				: null,
		[feed, now, stationId, preference.channel],
	)
	const allDay = useMemo(
		() =>
			preference.allDay && preference.view === 'active'
				? allDayCounts(tickets, stationId)
				: [],
		[preference.allDay, preference.view, tickets, stationId],
	)
	// Work that came in since the screen last looked: a new ticket, or dishes a table added.
	// Rings for a while (and chimes, if on) so a cook who looked away still sees it.
	const [fresh, setFresh] = useState<ReadonlyMap<string, number>>(
		() => new Map(),
	)
	const soundOn = preference.sound
	const channel = preference.channel
	// The board this screen shows: a new station or source is not news, only a new look.
	const scope = `${preferenceKey(settings)}|${stationId ?? ''}|${channel}`
	useEffect(() => {
		if (!feed) return
		// What Live holds for this screen: its station and source, fired already (a
		// scheduled ticket counts as new when its preparation window begins).
		const live = visibleTickets(
			feed.tickets,
			feed.config,
			{ stationId, channel, view: 'active' },
			now,
		).filter((ticket) => !ticket.cancelled)
		const marks = live.flatMap((ticket) =>
			ticket.lines
				.filter((line) => !stationId || line.stationId === stationId)
				.map((line) => `${ticket.source}:${ticket.id}|${line.id}`),
		)
		if (lastBoard?.scope !== scope) {
			lastBoard = { scope, marks: new Set(marks) }
			return
		}
		const known = lastBoard.marks
		const arrived = new Set<string>()
		for (const mark of marks)
			if (!known.has(mark)) arrived.add(mark.slice(0, mark.lastIndexOf('|')))
		// Only what the board holds now is remembered: a screen left on for days
		// stays small, and a ticket brought back (recalled, a new round) rings again.
		lastBoard.marks = new Set(marks)
		if (arrived.size === 0) return
		if (soundOn) chime()
		const until = now + FRESH_MS
		setFresh((previous) => {
			const next = new Map(
				[...previous].filter(([, ringUntil]) => ringUntil > now),
			)
			for (const key of arrived) next.set(key, until)
			return next
		})
	}, [feed, soundOn, stationId, channel, scope, now])
	// iPad Safari only plays sound a finished tap (or a key) has allowed: with the
	// chime on (also after a reload), each tap tries until the audio runs.
	useEffect(() => {
		if (!soundOn) return
		const events = ['pointerup', 'touchend', 'click', 'keydown'] as const
		const stop = () =>
			events.forEach((name) => document.removeEventListener(name, wake))
		function wake() {
			unlockChime()
			if (chimeReady()) stop()
		}
		events.forEach((name) => document.addEventListener(name, wake))
		return stop
	}, [soundOn])

	const time = useMemo(
		() =>
			new Intl.DateTimeFormat(i18n.locale, {
				hour: 'numeric',
				minute: '2-digit',
				...(timeZone ? { timeZone } : {}),
			}),
		[i18n.locale, timeZone],
	)
	const labels: Record<KdsStage, string> = {
		new: _(t`New`),
		preparing: _(t`Preparing`),
		ready: _(t`Ready`),
	}
	const stages: KdsStage[] = feed?.config.showPreparing
		? ['new', 'preparing', 'ready']
		: ['new', 'ready']
	const canConfigure = !settings.signInRequired || session?.role === 'manager'
	const offline = !reachable || stale
	const needsSignIn =
		error?.code === 'staff_session_required' ||
		error?.code === 'staff_session_invalid'
	const errorMessage =
		error?.status === 409
			? _(
					t`This ticket or setup changed on another screen. Review the latest version, then try again.`,
				)
			: needsSignIn
				? _(t`Sign in online to use the kitchen display.`)
				: error?.code === 'kitchen_needs_location'
					? _(
							t`Bind this terminal to a location in Settings → Terminals in the App.`,
						)
					: error?.code === 'manager_required'
						? _(t`A manager must sign in to change the kitchen setup.`)
						: _(
								t`The kitchen is not connected. Check the connection and refresh. Changes are paused.`,
							)
	const command = (ticket: KdsTicket, extra: Partial<KdsCommand>) => {
		if (stale || busy) return
		void kitchen.command({
			source: ticket.source,
			orderId: ticket.id,
			expectedVersion: ticket.version,
			action: 'stage',
			stationId,
			lineId: null,
			...extra,
		})
	}
	const toggleFullscreen = async () => {
		try {
			if (document.fullscreenElement) await document.exitFullscreen()
			else await document.documentElement.requestFullscreen()
			setFullscreen(Boolean(document.fullscreenElement))
		} catch {
			/* iPad Safari uses the installed PWA's full-screen mode instead. */
		}
	}

	return (
		<main
			aria-label={_(t`Kitchen display`)}
			className="flex min-h-0 flex-1 flex-col"
		>
			{renderHeader(
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<h2 className="sr-only">
						<Trans>Kitchen</Trans>
					</h2>
					<Segmented
						label={_(t`Kitchen view`)}
						wrap={false}
						value={preference.view}
						onChange={(view) => select({ view })}
						options={[
							{ value: 'active', label: _(t`Live`) },
							{ value: 'scheduled', label: _(t`Scheduled`) },
							{ value: 'done', label: _(t`Done`) },
						]}
					/>
					{feed ? (
						<>
							<Select
								aria-label={_(t`Prep station`)}
								className="h-11"
								containerClassName="w-44"
								value={stationId ?? ''}
								onChange={(event) =>
									select({ stationId: event.target.value || null })
								}
							>
								<option value="">{_(t`All stations`)}</option>
								{feed.config.stations.map((station) => (
									<option key={station.id} value={station.id}>
										{station.name}
									</option>
								))}
							</Select>
							<Select
								aria-label={_(t`Source`)}
								className="h-11"
								containerClassName="w-40"
								value={preference.channel}
								onChange={(event) => select({ channel: event.target.value })}
							>
								<option value="all">{_(t`All orders`)}</option>
								<option value="counter">{_(t`Counter`)}</option>
								<option value="phone">{_(t`Phone`)}</option>
								<option value="online">{_(t`Online orders`)}</option>
							</Select>
							<div
								role="status"
								className={cn(
									'me-auto flex items-center gap-2 text-sm',
									offline ? 'text-warning' : 'text-muted-foreground',
								)}
							>
								<span
									className={cn(
										'size-2 shrink-0 rounded-full',
										offline ? 'bg-warning' : 'bg-success',
									)}
									aria-hidden
								/>
								<span className="max-2xl:sr-only">
									{offline
										? _(t`Updates paused`)
										: settings.demo
											? _(t`Demo mode · nothing leaves this tablet`)
											: _(t`Live · refreshes every 5 seconds`)}
								</span>
							</div>
							{average !== null ? (
								<span
									className="text-muted-foreground tnum text-sm whitespace-nowrap"
									title={_(
										t`Average time from firing to cleared, last two hours`,
									)}
								>
									<Trans>Avg {average} min</Trans>
								</span>
							) : null}
						</>
					) : (
						<span className="me-auto" />
					)}
					<IconButton
						label={_(t`Chime for new tickets`)}
						aria-pressed={preference.sound}
						className={cn(
							preference.sound && 'bg-secondary text-secondary-foreground',
						)}
						onClick={() => {
							const sound = !preference.sound
							select({ sound })
							// Switching it on is the tap that lets the page play sound: play it once as a preview.
							if (sound) chime()
						}}
					>
						<Icon
							name={preference.sound ? 'bell-ring' : 'bell'}
							className="size-5"
						/>
					</IconButton>
					<Button
						variant="ghost"
						aria-pressed={preference.allDay}
						className={cn(
							preference.allDay && 'bg-secondary text-secondary-foreground',
						)}
						onClick={() => select({ allDay: !preference.allDay })}
					>
						<Icon name="list" className="size-4" />
						<span className="max-sm:sr-only">
							<Trans context="Kitchen: how many of each dish are still to make on the board">
								All day
							</Trans>
						</span>
					</Button>
					<IconButton
						label={_(t`Refresh kitchen`)}
						onClick={() => void kitchen.refresh()}
						disabled={!reachable || busy}
					>
						<Icon name="refresh-cw" className="size-5" />
					</IconButton>
					{document.fullscreenEnabled ? (
						<IconButton
							label={fullscreen ? _(t`Exit full screen`) : _(t`Full screen`)}
							// A phone has no room (or need) for full screen.
							className="max-sm:hidden"
							onClick={() => void toggleFullscreen()}
						>
							{fullscreen ? (
								<Icon name="minimize" className="size-5" />
							) : (
								<Icon name="maximize" className="size-5" />
							)}
						</IconButton>
					) : null}
					{canConfigure && feed ? (
						<Button
							variant="ghost"
							onClick={() => setConfiguring(true)}
							disabled={busy || stale}
						>
							<Icon name="sliders-horizontal" className="size-4" />
							<span className="max-sm:sr-only">
								<Trans>Kitchen setup</Trans>
							</span>
						</Button>
					) : null}
				</div>,
			)}
			<Reveal open={allDay.length > 0}>
				<section
					aria-label={_(
						msg({
							context:
								'Kitchen: how many of each dish are still to make on the board',
							message: 'All day',
						}),
					)}
					className="kitchen-allday"
				>
					<h2 className="kitchen-allday-title">
						<Trans context="Kitchen: how many of each dish are still to make on the board">
							All day
						</Trans>
					</h2>
					<ul className="kitchen-allday-list">
						{allDay.map((count) => (
							<li key={count.key} className="kitchen-allday-item">
								<span className="tnum font-semibold">{count.quantity}×</span>
								<span className="min-w-0 break-words">
									{menuText(count.name)}
									{count.variant ? (
										<span className="text-muted-foreground">
											{' · '}
											{menuText(count.variant)}
										</span>
									) : null}
								</span>
							</li>
						))}
					</ul>
				</section>
			</Reveal>
			<Reveal open={Boolean(error) || Boolean(feed && offline)}>
				<div
					role="alert"
					className="notice-warning flex flex-wrap items-center gap-3 px-5 py-3 text-sm"
				>
					<p className="min-w-0 flex-1">
						{error
							? errorMessage
							: _(
									t`Connection lost. These are the last received tickets, not a live queue. Reconnect before changing preparation.`,
								)}
					</p>
					{needsSignIn ? (
						<Button onClick={onSignIn}>
							<Trans>Sign in again</Trans>
						</Button>
					) : (
						<Button
							onClick={() => void kitchen.refresh()}
							disabled={!reachable || busy}
						>
							<Trans>Try again</Trans>
						</Button>
					)}
				</div>
			</Reveal>
			{feed?.truncated ? (
				<p role="alert" className="notice-danger px-5 py-3">
					<Trans>
						The kitchen queue is too large to show every ticket. Clear older
						tickets before relying on this display.
					</Trans>
				</p>
			) : null}
			{!feed ? (
				settings.demo ? (
					// The demo tickets are read from this tablet in a moment.
					<div className="flex-1" />
				) : (
					<Empty>
						<EmptyHeader>
							<EmptyTitle>
								{error
									? _(t`Kitchen unavailable`)
									: _(t`Connecting to the kitchen…`)}
							</EmptyTitle>
							<EmptyDescription>
								{_(
									t`Tickets come directly from your regional server. Only saved and uploaded orders appear here.`,
								)}
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				)
			) : tickets.length === 0 ? (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>
							<h3>
								{preference.view === 'done'
									? _(t`No completed tickets`)
									: preference.view === 'scheduled'
										? _(t`Nothing scheduled`)
										: _(t`The kitchen is clear`)}
							</h3>
						</EmptyTitle>
						<EmptyDescription>
							{preference.view === 'active'
								? _(
										t`New Station and online orders will appear here. Unsent offline orders arrive after the register reconnects.`,
									)
								: preference.view === 'done'
									? _(
											t`Completed kitchen tickets stay available for recall for four hours.`,
										)
									: _(
											t`Scheduled tickets move to Live when their preparation window begins.`,
										)}
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<div className="kitchen-board min-h-0 flex-1 overflow-auto overscroll-contain px-1 pb-3 sm:px-2">
					<div
						className={cn(
							'grid items-start gap-4',
							preference.view === 'active'
								? feed.config.showPreparing
									? 'md:grid-cols-3'
									: 'md:grid-cols-2'
								: 'sm:grid-cols-2 xl:grid-cols-3',
						)}
					>
						{(preference.view === 'active' ? stages : [null]).map((stage) => {
							const column = stage
								? tickets.filter((ticket) => {
										const status = stationStage(ticket, stationId)
										return (
											status === stage ||
											(!feed.config.showPreparing &&
												stage === 'new' &&
												status === 'preparing')
										)
									})
								: tickets
							return (
								<section
									key={stage ?? 'tickets'}
									className={stage ? 'kitchen-lane' : 'contents'}
									aria-label={stage ? labels[stage] : _(t`Tickets`)}
								>
									{stage ? (
										<h3 className="kitchen-lane-head">
											<span className="flex items-center gap-2">
												<span
													className={cn(
														'size-2.5 rounded-full',
														stage === 'ready'
															? 'bg-success'
															: stage === 'preparing'
																? 'bg-warning'
																: 'bg-foreground',
													)}
													aria-hidden
												/>
												{labels[stage]}
											</span>
											<NumberPop
												value={String(column.length)}
												className="tnum text-muted-foreground text-sm"
											/>
										</h3>
									) : null}
									<div
										className={cn(
											'grid items-start gap-3',
											!stage && 'contents',
										)}
									>
										{column.map((ticket) => (
											<Ticket
												key={`${ticket.source}:${ticket.id}`}
												ticket={ticket}
												stationId={stationId}
												feed={feed}
												now={now}
												time={time}
												items={items}
												disabled={
													busy ||
													stale ||
													preference.view === 'scheduled' ||
													ticket.cancelled
												}
												labels={labels}
												fresh={
													(fresh.get(`${ticket.source}:${ticket.id}`) ?? 0) >
													now
												}
												onCommand={(extra) => command(ticket, extra)}
											/>
										))}
									</div>
									{stage && !column.length ? (
										<p className="text-muted-foreground px-4 py-8 text-center text-sm">
											<Trans>No tickets</Trans>
										</p>
									) : null}
								</section>
							)
						})}
					</div>
				</div>
			)}
			{configuring && feed ? (
				<KitchenSettings
					config={feed.config}
					version={feed.configVersion}
					categories={categories}
					busy={busy}
					error={error ? errorMessage : null}
					onClose={() => setConfiguring(false)}
					onSave={async (config) => {
						if (await kitchen.configure(feed.configVersion, config))
							setConfiguring(false)
					}}
				/>
			) : null}
		</main>
	)
}

function Ticket({
	ticket,
	stationId,
	feed,
	now,
	time,
	items,
	disabled,
	labels,
	fresh,
	onCommand,
}: {
	ticket: KdsTicket
	stationId: string | null
	feed: NonNullable<ReturnType<typeof useKitchen>['feed']>
	now: number
	time: Intl.DateTimeFormat
	items: Map<string, MenuItem>
	disabled: boolean
	labels: Record<KdsStage, string>
	/** Came in (or had dishes added) a moment ago: ringed so it is seen. */
	fresh: boolean
	onCommand: (extra: Partial<KdsCommand>) => void
}) {
	const { _ } = useLingui()
	const lines = ticket.lines.filter(
		(line) => !stationId || line.stationId === stationId,
	)
	const stage = stationStage(ticket, stationId)
	const allReady = kdsTicketStage(ticket.lines) === 'ready'
	const elapsed = Math.max(
		0,
		Math.floor(
			((ticket.completedAt ?? now) -
				workFiredAt(ticket, feed.config, stationId)) /
				60_000,
		),
	)
	const age =
		elapsed >= feed.config.lateMinutes
			? 'late'
			: elapsed >= feed.config.warningMinutes
				? 'warning'
				: 'normal'
	const next = nextKitchenStage(stage, feed.config)
	const actionLabel =
		stage === 'new' && feed.config.showPreparing
			? _(t`Start preparing`)
			: stage === 'ready'
				? _(t`Prepare again`)
				: _(t`Mark ready`)
	const source =
		ticket.channel === 'online'
			? _(t`Online orders`)
			: ticket.channel === 'phone'
				? _(t`Phone`)
				: _(t`Counter`)
	const fulfillment =
		ticket.fulfillment === 'dine_in'
			? _(t`Dine in`)
			: ticket.fulfillment === 'delivery'
				? _(t`Delivery`)
				: _(t`Takeaway`)
	const number = ticket.number
	// Dishes from a later round (a tab added to): marked so the line does not start them late.
	// One save sends a round at one time, so any later time is a later round.
	const firstFire = Math.min(
		...lines.map((line) => line.firedAt ?? ticket.createdAt),
	)
	const addedAt = (line: (typeof lines)[number]) =>
		line.firedAt != null && line.firedAt > firstFire ? line.firedAt : null
	return (
		<article
			aria-label={_(t`Ticket ${number}`)}
			className="border-border bg-card min-w-0 overflow-hidden border-b"
			data-kitchen-ticket
			data-age={age}
			data-fresh={fresh || undefined}
		>
			<header
				className={cn(
					'kitchen-ticket-head flex flex-wrap items-start justify-between gap-3 px-3 pt-3 pb-2',
					ticket.completedAt && 'bg-muted',
				)}
			>
				<div className="min-w-0 flex-1 basis-28">
					<h4 className="tnum text-xl font-semibold break-words">
						<bdi>#{ticket.number}</bdi>
					</h4>
					<p className="text-muted-foreground mt-1 text-sm font-medium">
						{source} · {fulfillment}
					</p>
					{ticket.tableLabel ? (
						<p className="mt-1 text-base font-semibold break-words">
							<Trans>Table {ticket.tableLabel}</Trans>
						</p>
					) : null}
				</div>
				<div className="shrink-0 text-end">
					<Badge
						className="min-h-7 rounded-(--station-inset-radius) px-2 text-sm tabular-nums"
						tone={
							age === 'late'
								? 'danger'
								: age === 'warning'
									? 'warning'
									: 'muted'
						}
					>
						<Icon name="clock-3" className="size-3.5" aria-hidden />
						<SoftText value={_(t`${elapsed} min`)} />
					</Badge>
					{ticket.completedAt === null && age !== 'normal' ? (
						<p
							className={cn(
								'mt-1 text-xs font-semibold',
								age === 'late' ? 'text-destructive' : 'text-warning',
							)}
						>
							{age === 'late' ? _(t`Late`) : _(t`Waiting`)}
						</p>
					) : null}
					{ticket.dueAt ? (
						<p className="mt-2 text-sm font-semibold">
							<Trans>Due {time.format(ticket.dueAt)}</Trans>
						</p>
					) : null}
				</div>
			</header>
			{ticket.cancelled ? (
				<p role="alert" className="notice-danger px-4 py-3">
					<Trans>Cancelled · stop preparing</Trans>
				</p>
			) : null}
			<ul className="divide-border divide-y">
				{lines.map((line) => {
					const item = items.get(line.itemId)
					const added = addedAt(line)
					const addedTime = added ? time.format(added) : ''
					// On a ticket still being worked: what already went out to the table.
					const served =
						ticket.completedAt === null && line.servedAt ? line.servedAt : null
					const servedTime = served ? time.format(served) : ''
					const variant = item?.variations.variants.find(
						(entry) => entry.id === line.variantId,
					)
					const variantLabel =
						line.variant ??
						(variant
							? item?.variations.groups
									.flatMap((group) => group.values)
									.filter((value) => variant.valueIds.includes(value.id))
									.map((value) => menuText(value.name))
									.join(' · ')
							: null)
					return (
						<li
							key={line.id}
							className="py-1"
							data-served={served ? true : undefined}
						>
							<Item size="xs">
								<ItemMedia className="self-start">
									<span className="tnum shrink-0 text-base leading-snug font-semibold">
										{line.quantity}×
									</span>
								</ItemMedia>
								<ItemContent className="min-w-0">
									<p className="text-base leading-snug font-medium [overflow-wrap:anywhere]">
										{menuText(line.name)}
									</p>
									{served ? (
										<p className="kitchen-served">
											<Icon name="check" aria-hidden className="size-3.5" />
											<Trans>Served {servedTime}</Trans>
										</p>
									) : added ? (
										<p className="kitchen-added">
											<Icon name="plus" aria-hidden className="size-3.5" />
											<Trans>Added {addedTime}</Trans>
										</p>
									) : null}
									{variantLabel ? (
										<p className="text-muted-foreground mt-1 text-sm">
											{menuText(variantLabel)}
										</p>
									) : line.variantId ? (
										<p className="text-warning mt-1 text-sm font-semibold">
											<Trans>Variant unavailable · check the order</Trans>
										</p>
									) : null}
									{line.options.map((option, index) => (
										<p
											key={index}
											className="mt-1 text-sm [overflow-wrap:anywhere]"
										>
											{option.quantity > 1 ? `${option.quantity} × ` : ''}
											{menuText(option.name)}
											{option.half === 'left'
												? ` · ${_(t`Left half`)}`
												: option.half === 'right'
													? ` · ${_(t`Right half`)}`
													: ''}
										</p>
									))}
									{line.instructions ? (
										<p className="notice-warning mt-2 rounded-(--station-inset-radius) px-2.5 py-2 text-sm [overflow-wrap:anywhere]">
											{line.instructions}
										</p>
									) : null}
									{!stationId && feed.config.stations.length > 1 ? (
										<p className="text-muted-foreground mt-2 text-xs">
											{
												feed.config.stations.find(
													(station) => station.id === line.stationId,
												)?.name
											}
										</p>
									) : null}
								</ItemContent>
								<ItemActions>
									{line.stage === 'ready' ? (
										<Icon
											name="check"
											className="text-success size-5 shrink-0"
											aria-label={labels.ready}
										/>
									) : null}
								</ItemActions>
							</Item>
							{feed.config.workflow === 'item' &&
							ticket.completedAt === null ? (
								<Button
									className="mt-3 h-auto min-h-11 w-full py-2 leading-snug"
									variant={line.stage === 'ready' ? 'ghost' : 'outline'}
									disabled={disabled}
									onClick={() =>
										onCommand({
											lineId: line.id,
											stage: nextKitchenStage(line.stage, feed.config),
										})
									}
								>
									{line.stage === 'ready' ? (
										<>
											<Icon name="undo-2" className="size-4" />
											<Trans>Prepare again</Trans>
										</>
									) : line.stage === 'new' && feed.config.showPreparing ? (
										<Trans>Start item</Trans>
									) : (
										<Trans>Item ready</Trans>
									)}
								</Button>
							) : null}
						</li>
					)
				})}
			</ul>
			{!ticket.cancelled ? (
				<footer className="grid gap-2 px-3 pt-1 pb-3">
					{ticket.completedAt !== null ? (
						<Button
							size="lg"
							className="h-auto min-h-11 py-2 text-sm leading-snug"
							variant="outline"
							disabled={disabled}
							onClick={() => onCommand({ action: 'recall', stationId: null })}
						>
							<Icon name="undo-2" className="size-5" />
							<Trans>Recall ticket</Trans>
						</Button>
					) : allReady && !stationId ? (
						<Button
							size="lg"
							className="h-auto min-h-11 py-2 text-sm leading-snug"
							variant="primary"
							disabled={disabled}
							onClick={() => onCommand({ action: 'done', stationId: null })}
						>
							<Icon name="check" className="size-5" />
							<Trans>Done · clear ticket</Trans>
						</Button>
					) : stage === 'ready' ? (
						<p className="text-success py-2 text-center text-sm font-semibold">
							<Trans>Ready for the pass</Trans>
						</p>
					) : (
						<Button
							size="lg"
							className="h-auto min-h-11 py-2 text-sm leading-snug"
							variant={next === 'ready' ? 'primary' : 'secondary'}
							disabled={disabled}
							onClick={() => onCommand({ stage: next })}
						>
							{actionLabel}
						</Button>
					)}
					{stage !== 'new' && ticket.completedAt === null ? (
						<Button
							variant="ghost"
							className="h-auto min-h-11 py-2 leading-snug"
							disabled={disabled}
							onClick={() => onCommand({ stage: 'new' })}
						>
							<Icon name="undo-2" className="size-4" />
							<Trans>Reset preparation</Trans>
						</Button>
					) : null}
				</footer>
			) : null}
		</article>
	)
}
