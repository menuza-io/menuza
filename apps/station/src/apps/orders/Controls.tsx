import { type MessageDescriptor } from '@lingui/core'
import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	ORDERING_PAUSE_DURATIONS,
	type OrderingPauseDuration,
	type PosAvailabilityCommand,
	type PosHeldByStock,
	type PosSoldOutEntityType,
	type PosStationControls,
} from '@repo/common/pos-station-controls'
import { Icon } from '@repo/ui/icon'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type OrdersApi, OrdersError } from './api.ts'
import { isAvailable } from '~/lib/availability.ts'
import { categoryItems } from '~/lib/catalog.ts'
import { menuText } from '~/lib/menu-text.ts'
import { usePos } from '~/lib/store.ts'
import { type MenuCategory } from '~/lib/types.ts'
import { Badge, Button, Input, Modal } from '~/ui/primitives.tsx'

const PAUSE_LABEL: Record<OrderingPauseDuration, MessageDescriptor> = {
	'15m': msg`15 minutes`,
	'30m': msg`30 minutes`,
	'60m': msg`1 hour`,
	rest_of_day: msg`Rest of today`,
	until_resumed: msg`Until I resume`,
}

/** A dish or option on this till's menu, with its state here. */
type Entry = {
	key: string
	entityType: PosSoldOutEntityType
	entityId: string
	name: string
	/** The dish an option belongs to, to tell same-named options apart. */
	context: string | null
	available: boolean
}

/** Every dish and option on the till's menu, once each. */
export function menuEntries(categories: MenuCategory[]): Entry[] {
	const out = new Map<string, Entry>()
	for (const category of categories) {
		const walk = (c: MenuCategory) => {
			for (const item of categoryItems(c)) {
				const key = `item:${item.id}`
				if (!out.has(key))
					out.set(key, {
						key,
						entityType: 'item',
						entityId: item.id,
						name: menuText(item.displayName),
						context: null,
						available: isAvailable(item.availabilityStatus),
					})
				for (const group of item.modifierGroups)
					for (const option of group.options) {
						const optionKey = `modifier_option:${option.id}`
						if (out.has(optionKey)) continue
						out.set(optionKey, {
							key: optionKey,
							entityType: 'modifier_option',
							entityId: option.id,
							name: menuText(option.displayName),
							context: menuText(group.name),
							available: isAvailable(option.availabilityStatus),
						})
					}
			}
		}
		walk(category)
	}
	return [...out.values()]
}

function failureText(
	_: (descriptor: MessageDescriptor) => string,
	error: unknown,
): string {
	const code = error instanceof OrdersError ? error.code : ''
	if (code === 'permission_required')
		return _(msg`Only a manager can change this.`)
	if (code === 'inventory_unavailable')
		return _(
			msg`Stock is switched off right now, so a dish it took off cannot be brought back here. Use the App.`,
		)
	// A write that timed out or lost its connection may still have gone
	// through: never claim it did not. The sheet reads the state again.
	return _(
		msg`That may not have gone through. Check what is shown below before trying again.`,
	)
}

/**
 * Mid-service manager controls for this location: pause online ordering with
 * the App's presets, and mark dishes and options sold out (and back). Every
 * change goes to the region at once; offline nothing is offered and nothing
 * is kept to send later.
 */
export function ControlsSheet({
	open,
	onClose,
	api,
	online,
	timeZone,
}: {
	open: boolean
	onClose: () => void
	api: Pick<OrdersApi, 'controls' | 'pause' | 'availability'>
	online: boolean
	timeZone?: string
}) {
	const { _, i18n } = useLingui()
	const categories = usePos((s) => s.categories)
	const refreshMenu = usePos((s) => s.refresh)
	const [state, setState] = useState<PosStationControls | null>(null)
	const [busy, setBusy] = useState<string | null>(null)
	const [failure, setFailure] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	/** What this sheet changed, shown until the menu is read again. */
	const [changed, setChanged] = useState<ReadonlyMap<string, boolean>>(
		() => new Map(),
	)
	const [confirm, setConfirm] = useState<Entry | null>(null)
	const asked = useRef(0)

	const load = useCallback(async () => {
		const ask = ++asked.current
		try {
			const next = await api.controls()
			if (ask === asked.current) {
				setState(next)
				setFailure(null)
			}
		} catch (error) {
			if (ask === asked.current) setFailure(failureText(_, error))
		}
	}, [api, _])
	useEffect(() => {
		if (!open) {
			asked.current += 1
			// Never show the last opening's pause or stock holds as current.
			setState(null)
			setQuery('')
			setConfirm(null)
			setFailure(null)
			return
		}
		if (online) void load()
	}, [open, online, load])
	// A fresh menu carries what changed; forget the local marks then.
	useEffect(() => setChanged(new Map()), [categories])

	const held = useMemo(() => {
		const map = new Map<string, PosHeldByStock>()
		for (const entry of state?.heldByStock ?? [])
			map.set(`${entry.entityType}:${entry.entityId}`, entry)
		return map
	}, [state])
	const entries = useMemo(() => menuEntries(categories), [categories])
	const shown = useMemo(() => {
		const text = query.trim().toLocaleLowerCase()
		const list = entries.map((entry) => ({
			...entry,
			available: changed.get(entry.key) ?? entry.available,
		}))
		if (text)
			return list.filter(
				(entry) =>
					entry.name.toLocaleLowerCase().includes(text) ||
					entry.context?.toLocaleLowerCase().includes(text),
			)
		// Without a search: what is off here first, then the dishes.
		return list
			.filter(
				(entry) =>
					!entry.available ||
					held.has(entry.key) ||
					// Changed here: stays in view (and keeps focus) until the sheet closes.
					changed.has(entry.key) ||
					entry.entityType === 'item',
			)
			.sort((a, b) => Number(a.available) - Number(b.available))
	}, [entries, changed, query, held])

	const until = useMemo(
		() =>
			new Intl.DateTimeFormat(i18n.locale, {
				weekday: 'short',
				hour: 'numeric',
				minute: '2-digit',
				...(timeZone ? { timeZone } : {}),
			}),
		[i18n.locale, timeZone],
	)

	const run = async (
		key: string,
		write: () => Promise<PosStationControls>,
	): Promise<boolean | 'held'> => {
		if (!online || busy) return false
		setBusy(key)
		setFailure(null)
		try {
			setState(await write())
			return true
		} catch (error) {
			if (error instanceof OrdersError && error.code === 'held_by_stock') {
				await load()
				return 'held' as const
			}
			setFailure(failureText(_, error))
			// Whatever happened, show what is true now.
			if (online) void load()
			return false
		} finally {
			setBusy(null)
		}
	}

	const setAvailability = async (entry: Entry, overrideStock = false) => {
		const command: PosAvailabilityCommand = {
			entityType: entry.entityType,
			entityId: entry.entityId,
			available: !entry.available,
			...(overrideStock ? { overrideStock: true } : {}),
		}
		const ok = await run(entry.key, () => api.availability(command))
		// Stock took it off since the sheet loaded: ask, as for any held dish.
		if (ok === 'held') {
			setConfirm(entry)
			return
		}
		if (!ok) return
		setChanged((previous) => new Map(previous).set(entry.key, !entry.available))
		setConfirm(null)
		void refreshMenu()
	}

	const pause = state?.pause ?? null
	const disabled = !online || state === null
	return (
		<>
			<Modal
				open={open}
				onClose={onClose}
				title={_(t`Pause and sold out`)}
				size="lg"
			>
				<div className="flex flex-col gap-5 p-4 sm:p-5">
					{!online ? (
						<p role="status" className="notice-warning px-4 py-2 text-sm">
							<Trans>
								Not available offline. Changes are never saved to send later:
								reconnect to pause ordering or mark dishes sold out.
							</Trans>
						</p>
					) : null}
					{failure && !confirm ? (
						<p role="alert" className="notice-warning px-4 py-2 text-sm">
							{failure}
						</p>
					) : null}
					{online && state === null && !failure ? (
						<p role="status" className="text-muted-foreground text-sm">
							<Trans>Loading…</Trans>
						</p>
					) : null}
					<section
						aria-labelledby="controls-pause"
						className="flex flex-col gap-3"
					>
						<div className="flex flex-wrap items-center gap-2">
							<h3 id="controls-pause" className="me-auto font-semibold">
								<Trans>Online ordering here</Trans>
							</h3>
							{state === null ? null : pause ? (
								<Badge tone="warning">
									{pause.until !== null
										? _(t`Paused until ${until.format(pause.until)}`)
										: _(t`Paused until resumed`)}
								</Badge>
							) : (
								<Badge tone="success">
									<Trans>Taking orders</Trans>
								</Badge>
							)}
						</div>
						{pause ? (
							<Button
								variant="primary"
								disabled={disabled || busy !== null}
								onClick={() =>
									void run('pause', () => api.pause({ action: 'resume' }))
								}
							>
								<Trans>Resume online ordering</Trans>
							</Button>
						) : (
							<>
								<p className="text-muted-foreground text-sm">
									<Trans>
										Pause new web and QR orders at this location only. Orders
										already placed carry on.
									</Trans>
								</p>
								<div className="flex flex-wrap gap-2">
									{ORDERING_PAUSE_DURATIONS.map((duration) => (
										<Button
											key={duration}
											variant="outline"
											disabled={disabled || busy !== null}
											onClick={() =>
												void run('pause', () =>
													api.pause({ action: 'pause', duration }),
												)
											}
										>
											{_(PAUSE_LABEL[duration])}
										</Button>
									))}
								</div>
							</>
						)}
					</section>
					<section
						aria-labelledby="controls-sold-out"
						className="flex flex-col gap-3"
					>
						<h3 id="controls-sold-out" className="font-semibold">
							<Trans>Sold out here</Trans>
						</h3>
						<Input
							type="search"
							aria-label={_(t`Find a dish or option`)}
							placeholder={_(t`Find a dish or option`)}
							value={query}
							maxLength={60}
							onChange={(event) => setQuery(event.target.value)}
						/>
						{shown.length === 0 ? (
							<p className="text-muted-foreground py-2 text-center text-sm">
								<Trans>Nothing on the menu matches.</Trans>
							</p>
						) : (
							<ul className="divide-border border-border divide-y rounded-(--station-control-radius) border">
								{shown.slice(0, 80).map((entry) => {
									const stock = held.get(entry.key)
									return (
										<li
											key={entry.key}
											className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2"
										>
											<span className="me-auto min-w-0">
												<bdi className="block truncate">{entry.name}</bdi>
												{entry.context ? (
													<span className="text-muted-foreground block truncate text-xs">
														<Trans>Option · {entry.context}</Trans>
													</span>
												) : null}
												{stock ? (
													<span className="text-muted-foreground block text-xs">
														<Trans>
															Out of stock: {stock.causeItemName} ran out
														</Trans>
													</span>
												) : null}
											</span>
											{!entry.available ? (
												<Badge tone="danger">
													<Trans>Sold out</Trans>
												</Badge>
											) : null}
											<Button
												variant={entry.available ? 'outline' : 'primary'}
												disabled={disabled || busy !== null}
												// The visible words lead the name (voice control: "Back on").
												aria-label={
													entry.available
														? _(t`Sold out: ${entry.name}`)
														: _(t`Back on: ${entry.name}`)
												}
												onClick={() =>
													!entry.available && stock
														? setConfirm(entry)
														: void setAvailability(entry)
												}
											>
												{busy === entry.key ? (
													<Icon name="refresh-cw" className="size-4" />
												) : null}
												{entry.available ? (
													<Trans>Sold out</Trans>
												) : (
													<Trans>Back on</Trans>
												)}
											</Button>
										</li>
									)
								})}
							</ul>
						)}
						<p className="text-muted-foreground text-xs">
							<Trans>
								Changes reach the website and QR menus within seconds and are
								recorded in the activity log.
							</Trans>
						</p>
					</section>
				</div>
			</Modal>
			<Modal
				open={confirm !== null}
				onClose={() => setConfirm(null)}
				title={_(t`Bring it back anyway?`)}
				footer={
					<div className="flex w-full justify-end gap-2">
						<Button onClick={() => setConfirm(null)} disabled={busy !== null}>
							<Trans>Keep it off</Trans>
						</Button>
						<Button
							variant="primary"
							disabled={disabled || busy !== null}
							onClick={() => confirm && void setAvailability(confirm, true)}
						>
							<Trans>Bring back anyway</Trans>
						</Button>
					</div>
				}
			>
				{failure && confirm ? (
					// The sheet behind is inert while this is open: say it here.
					<p
						role="alert"
						className="notice-warning mx-4 mt-4 px-4 py-2 text-sm sm:mx-5"
					>
						{failure}
					</p>
				) : null}
				<p className="p-4 text-sm sm:p-5">
					{confirm
						? _(
								t`Stock took ${confirm.name} off because ${held.get(confirm.key)?.causeItemName ?? ''} ran out. Bringing it back overrides that: stock leaves it on until the ingredient has been counted in stock again.`,
							)
						: null}
				</p>
			</Modal>
		</>
	)
}
