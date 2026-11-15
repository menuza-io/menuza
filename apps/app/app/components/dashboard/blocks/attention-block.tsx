import { Trans, msg, plural } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button, buttonVariants } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Skeleton } from '@repo/ui/skeleton'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useFetcher } from 'react-router'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import {
	attentionItem,
	callFollowUpsSchema,
	inventoryCountsSchema,
	orderAttentionItems,
	paymentReviewCountsSchema,
	type AttentionData,
	type AttentionItem,
	type OrderChannel,
} from '#app/utils/dashboards/attention.ts'
import {
	ALL_LOCATIONS,
	type HomeLocation,
} from '#app/utils/dashboards/today.ts'
import { useHomeLocation } from '../use-home-location.ts'

type TokenResponse = { jwt?: unknown; tenantApiUrl?: unknown }

async function regionalGet(
	tokenUrl: string,
	path: (base: string) => string,
	signal: AbortSignal,
): Promise<unknown> {
	const tokenResponse = await fetch(tokenUrl, { signal })
	const token = (await tokenResponse.json().catch(() => ({}))) as TokenResponse
	if (
		!tokenResponse.ok ||
		typeof token.jwt !== 'string' ||
		typeof token.tenantApiUrl !== 'string'
	) {
		throw new Error('attention_token_failed')
	}
	const response = await fetch(path(token.tenantApiUrl), {
		headers: { Authorization: `Bearer ${token.jwt}` },
		signal,
	})
	if (!response.ok) throw new Error('attention_regional_failed')
	return response.json()
}

/**
 * Regional counts, fetched by the browser from each module's operator routes
 * with its short-lived token (counts only). Each source is independent: one
 * that fails is skipped and the rest of the feed stays.
 */
function useRegionalItems(
	orgSlug: string,
	regional: AttentionData['regional'],
	locations: readonly HomeLocation[],
) {
	const [items, setItems] = useState<AttentionItem[]>([])
	const locationKey = locations.map((location) => location.id).join(',')
	const { paymentReview, callFollowUps, inventoryCounts } = regional

	useEffect(() => {
		const controller = new AbortController()
		const { signal } = controller
		const byId = new Map(locations.map((location) => [location.id, location]))
		const sources: Array<Promise<AttentionItem[]>> = []
		if (paymentReview) {
			sources.push(
				regionalGet(
					`/${orgSlug}/orders-token`,
					(base) => `${base}/operator/orders/attention`,
					signal,
				).then((raw) =>
					paymentReviewCountsSchema.parse(raw).locations.flatMap((row) => {
						const location = byId.get(row.locationId)
						return location && row.paymentReview > 0
							? [
									attentionItem('payment_review', location, {
										count: row.paymentReview,
										href: '/orders',
									}),
								]
							: []
					}),
				),
			)
		}
		if (callFollowUps) {
			sources.push(
				regionalGet(
					`/${orgSlug}/phone-agent/calls-token`,
					(base) => `${base}/operator/calls?limit=1`,
					signal,
				).then((raw) => {
					const { openFollowUps } = callFollowUpsSchema.parse(raw)
					return openFollowUps > 0
						? [
								attentionItem('call_follow_ups', null, {
									count: openFollowUps,
									href: '/phone-agent/calls',
								}),
							]
						: []
				}),
			)
		}
		if (inventoryCounts) {
			for (const location of locations) {
				sources.push(
					regionalGet(
						`/${orgSlug}/inventory-token?scope=read`,
						(base) =>
							`${base}/operator/inventory/counts?${new URLSearchParams({
								locationId: location.id,
								status: 'open',
							})}`,
						signal,
					).then((raw) => {
						const waiting = inventoryCountsSchema
							.parse(raw)
							.counts.filter((count) => count.status === 'in_review').length
						return waiting > 0
							? [
									attentionItem('inventory_counts_waiting', location, {
										count: waiting,
										href: '/inventory/counts',
									}),
								]
							: []
					}),
				)
			}
		}
		void Promise.allSettled(sources).then((results) => {
			if (signal.aborted) return
			setItems(
				results.flatMap((result) =>
					result.status === 'fulfilled' ? result.value : [],
				),
			)
		})
		return () => controller.abort()
		// `locations` is keyed by its ids.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [orgSlug, paymentReview, callFollowUps, inventoryCounts, locationKey])

	return items
}

function useItemText() {
	const { _, i18n } = useLingui()
	const time = (iso: string | null) =>
		iso
			? new Intl.DateTimeFormat(i18n.locale, {
					dateStyle: 'medium',
					timeStyle: 'short',
				}).format(new Date(iso))
			: ''
	const channelLabel = (channel: OrderChannel) =>
		channel === 'pickup'
			? _(msg`Pickup`)
			: channel === 'delivery'
				? _(msg`Delivery`)
				: _(msg`Scheduled ordering`)
	const list = (values: string[]) =>
		new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(values)

	return (item: AttentionItem): { title: string; detail: string | null } => {
		const location = item.locationName ?? ''
		const count = item.count ?? 0
		switch (item.kind) {
			case 'payments_not_connected':
				return {
					title: _(msg`Online payments are not connected`),
					detail: _(
						msg`Connect Stripe or Checkout.com to take card payments online.`,
					),
				}
			case 'payment_review':
				return {
					title: _(
						plural(count, {
							one: `# order at ${location} needs a payment review`,
							other: `# orders at ${location} need a payment review`,
						}),
					),
					detail: null,
				}
			case 'ordering_paused': {
				const since = time(item.since)
				const until = time(item.until)
				return {
					title: _(msg`Online ordering is paused at ${location}`),
					detail: item.until
						? _(msg`Paused since ${since}, until ${until}.`)
						: _(msg`Paused since ${since}, until someone resumes it.`),
				}
			}
			case 'no_active_menu':
				return {
					title: _(msg`${location} has no menu on sale`),
					detail: _(msg`Guests see nothing to order.`),
				}
			case 'site_unpublished':
				return {
					title: _(msg`Your site is not published`),
					detail: _(msg`Guests cannot find you or order online yet.`),
				}
			case 'custom_domain_error':
				return {
					title: _(msg`Your custom domain has a problem`),
					detail: _(msg`Check the domain settings on your website page.`),
				}
			case 'no_hours':
				return {
					title: _(msg`${location} has no opening hours`),
					detail: _(msg`Guests cannot see when you are open.`),
				}
			case 'menu_health_low': {
				const score = item.score ?? 0
				return {
					title: _(msg`Your menu health score is ${score}`),
					detail: _(msg`Fix the top issues to reach 60 or more.`),
				}
			}
			case 'channel_off': {
				const channels = list((item.channels ?? []).map(channelLabel))
				return {
					title: _(msg`${channels} switched off at ${location}`),
					detail: null,
				}
			}
			case 'dishes_unavailable':
				return {
					title: location
						? _(
								plural(count, {
									one: `# dish is sold out at ${location}`,
									other: `# dishes are sold out at ${location}`,
								}),
							)
						: _(
								plural(count, {
									one: '# dish is sold out',
									other: '# dishes are sold out',
								}),
							),
					detail: null,
				}
			case 'override_active': {
				const parts = (item.overrides ?? []).map((override) => {
					if (override === 'special_hours') return _(msg`Special hours`)
					const minutes = item.minutes ?? 0
					return override === 'busy'
						? _(msg`Busy mode (+${minutes} min prep)`)
						: _(msg`A prep-time change`)
				})
				const what = list(parts)
				const ends = time(item.until)
				return {
					title: _(msg`${what} in force at ${location}`),
					detail: item.until
						? _(msg`Ends ${ends}.`)
						: _(msg`Until someone turns it off.`),
				}
			}
			case 'reviews_unanswered':
				return {
					title: _(
						plural(count, {
							one: '# review has no reply after 48 hours',
							other: '# reviews have no reply after 48 hours',
						}),
					),
					detail: null,
				}
			case 'call_follow_ups':
				return {
					title: _(
						plural(count, {
							one: '# phone call has an open follow-up',
							other: '# phone calls have an open follow-up',
						}),
					),
					detail: null,
				}
			case 'inventory_counts_waiting':
				return {
					title: _(
						plural(count, {
							one: `# stock count at ${location} is waiting for review`,
							other: `# stock counts at ${location} are waiting for review`,
						}),
					),
					detail: null,
				}
		}
	}
}

/**
 * Needs attention: problems that cost the restaurant money, urgent first,
 * each with one button to the screen that fixes it. Control-plane items come
 * with the page; regional counts are added by the browser. Advice can be
 * dismissed for a week; urgent items stay until fixed.
 */
export function AttentionBlock({
	orgSlug,
	data,
	locationStorageKey,
}: {
	orgSlug: string
	data: AttentionData
	locationStorageKey: string
}) {
	const { _ } = useLingui()
	const [selection, setSelection] = useHomeLocation(locationStorageKey)
	const [dismissedHere, setDismissedHere] = useState<string[]>([])
	const onDismissed = useCallback(
		(key: string) =>
			setDismissedHere((keys) => (keys.includes(key) ? keys : [...keys, key])),
		[],
	)
	const regionalItems = useRegionalItems(orgSlug, data.regional, data.locations)
	const selected =
		selection !== ALL_LOCATIONS &&
		data.locations.some((location) => location.id === selection)
			? selection
			: null
	const items = useMemo(
		() =>
			orderAttentionItems(
				[...data.items, ...regionalItems].filter(
					(item) =>
						!selected ||
						item.locationId === null ||
						item.locationId === selected,
				),
				[...data.dismissedKeys, ...dismissedHere],
			),
		[data.items, data.dismissedKeys, dismissedHere, regionalItems, selected],
	)

	return (
		<Card className="h-full overflow-auto" data-testid="attention-block">
			<CardContent className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h3 className="text-sm font-semibold">
						<Trans>Needs attention</Trans>
					</h3>
					{data.locations.length > 1 ? (
						<FilterSelect
							label={_(msg`Location`)}
							options={[
								{ value: ALL_LOCATIONS, label: _(msg`All locations`) },
								...data.locations.map((location) => ({
									value: location.id,
									label: location.name,
								})),
							]}
							value={selected ?? ALL_LOCATIONS}
							onValueChange={setSelection}
							testId="attention-location"
						/>
					) : null}
				</div>
				{items.length === 0 ? (
					<p
						className="text-muted-foreground text-sm"
						data-testid="attention-empty"
					>
						<Trans>Nothing needs your attention.</Trans>
					</p>
				) : (
					<ul className="flex flex-col gap-2" data-testid="attention-items">
						{items.map((item) => (
							<AttentionRow
								key={item.key}
								item={item}
								orgSlug={orgSlug}
								onDismissed={onDismissed}
							/>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	)
}

function AttentionRow({
	item,
	orgSlug,
	onDismissed,
}: {
	item: AttentionItem
	orgSlug: string
	onDismissed: (key: string) => void
}) {
	const { _ } = useLingui()
	const text = useItemText()(item)
	const itemTitle = text.title
	const dismiss = useFetcher<{ ok: boolean }>()
	const resume = useFetcher<{ ok: boolean }>()
	const [restoreOpen, setRestoreOpen] = useState(false)

	useEffect(() => {
		if (dismiss.state === 'idle' && dismiss.data?.ok) onDismissed(item.key)
	}, [dismiss.state, dismiss.data, item.key, onDismissed])

	return (
		<li
			className="border-border flex flex-col gap-2 rounded-lg border p-3"
			data-testid={`attention-item-${item.kind}`}
			data-key={item.key}
		>
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="flex min-w-0 flex-col gap-0.5">
					<p className="text-sm font-medium">{text.title}</p>
					{text.detail ? (
						<p className="text-muted-foreground text-xs">{text.detail}</p>
					) : null}
				</div>
				<Badge
					variant={item.urgency === 'urgent' ? 'destructive' : 'secondary'}
				>
					{item.urgency === 'urgent' ? (
						<Trans>Urgent</Trans>
					) : (
						<Trans>To do</Trans>
					)}
				</Badge>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				{item.kind === 'ordering_paused' &&
				item.canResume &&
				item.locationId ? (
					<resume.Form
						method="post"
						action={`/${orgSlug}/orders/ordering-controls`}
					>
						<input type="hidden" name="intent" value="resume" />
						<input type="hidden" name="locationId" value={item.locationId} />
						<Button
							type="submit"
							size="sm"
							disabled={resume.state !== 'idle'}
							data-testid="attention-resume"
						>
							<Trans>Resume</Trans>
						</Button>
					</resume.Form>
				) : item.kind === 'dishes_unavailable' && item.canRestore ? (
					<Button
						size="sm"
						onClick={() => setRestoreOpen(true)}
						data-testid="attention-restore"
					>
						<Trans>Mark available</Trans>
					</Button>
				) : null}
				<Link
					to={`/${orgSlug}${item.href}`}
					className={buttonVariants({
						variant:
							item.kind === 'ordering_paused' ||
							(item.kind === 'dishes_unavailable' && item.canRestore)
								? 'outline'
								: 'default',
						size: 'sm',
					})}
				>
					{item.kind === 'dishes_unavailable' ? (
						<Trans>Open the menu</Trans>
					) : (
						<Trans>Fix it</Trans>
					)}
				</Link>
				{item.dismissible ? (
					<dismiss.Form method="post" action={`/${orgSlug}?index`}>
						<input type="hidden" name="intent" value="dismiss-attention" />
						<input type="hidden" name="key" value={item.key} />
						<Button
							type="submit"
							variant="ghost"
							size="sm"
							disabled={dismiss.state !== 'idle'}
							aria-label={_(msg`Dismiss for a week: ${itemTitle}`)}
						>
							<Trans>Dismiss for a week</Trans>
						</Button>
					</dismiss.Form>
				) : null}
			</div>
			{restoreOpen ? (
				<RestoreDishesDialog
					orgSlug={orgSlug}
					locationId={item.locationId}
					title={text.title}
					onClose={() => setRestoreOpen(false)}
				/>
			) : null}
		</li>
	)
}

type SoldOutResponse = {
	dishes: Array<{ id: string; name: string; byStock: boolean }>
	stockKnown: boolean
	canRestore: boolean
}

function RestoreDishesDialog({
	orgSlug,
	locationId,
	title,
	onClose,
}: {
	orgSlug: string
	locationId: string | null
	title: string
	onClose: () => void
}) {
	const list = useFetcher<SoldOutResponse>()
	const restore = useFetcher<
		{ ok: true; restored: number; skippedByStock: number } | { ok: false }
	>()
	const [picked, setPicked] = useState<string[]>([])
	const query = locationId ? `?${new URLSearchParams({ locationId })}` : ''

	// Load once per dialog; a failed load is not retried in a loop.
	const requested = useRef(false)
	const { load } = list
	useEffect(() => {
		if (requested.current) return
		requested.current = true
		void load(`/${orgSlug}/home-sold-out${query}`)
	}, [load, orgSlug, query])

	const done = restore.state === 'idle' && restore.data?.ok === true
	const dishes = list.data?.dishes ?? []
	const restorable = dishes.filter((dish) => !dish.byStock)

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>Mark dishes available</Trans>
					</DialogTitle>
					<DialogDescription>{title}</DialogDescription>
				</DialogHeader>
				{!list.data ? (
					<Skeleton className="h-24 rounded-lg" aria-hidden="true" />
				) : done ? (
					<p className="text-sm" role="status">
						<Trans>Done. The dishes are back on the menu.</Trans>
					</p>
				) : (
					<restore.Form
						method="post"
						action={`/${orgSlug}?index`}
						id="restore-dishes"
						className="flex max-h-80 flex-col gap-2 overflow-auto"
					>
						<input type="hidden" name="intent" value="restore-dishes" />
						<input type="hidden" name="locationId" value={locationId ?? ''} />
						<input
							type="hidden"
							name="itemIds"
							value={JSON.stringify(picked)}
						/>
						{dishes.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								<Trans>No dishes are sold out here now.</Trans>
							</p>
						) : null}
						{dishes.map((dish) => (
							<label
								key={dish.id}
								className="flex items-center gap-2 text-sm"
								data-testid={`restore-dish-${dish.id}`}
							>
								<Checkbox
									checked={picked.includes(dish.id)}
									disabled={dish.byStock}
									onCheckedChange={(checked) =>
										setPicked((current) =>
											checked
												? [...current, dish.id]
												: current.filter((id) => id !== dish.id),
										)
									}
								/>
								<span className="min-w-0 truncate">{dish.name}</span>
								{dish.byStock ? (
									<span className="text-muted-foreground text-xs">
										<Trans>Sold out by stock: undo it in Inventory</Trans>
									</span>
								) : null}
							</label>
						))}
						{!list.data.stockKnown ? (
							<p className="text-muted-foreground text-xs">
								<Trans>
									We couldn't check which dishes inventory took off. Try again
									in a moment.
								</Trans>
							</p>
						) : null}
						{restore.data && !restore.data.ok ? (
							<p className="text-destructive text-xs" role="alert">
								<Trans>Couldn't mark the dishes available. Try again.</Trans>
							</p>
						) : null}
					</restore.Form>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						{done ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
					</Button>
					{!done && list.data?.canRestore ? (
						<Button
							type="submit"
							form="restore-dishes"
							disabled={
								picked.length === 0 ||
								restorable.length === 0 ||
								!list.data.stockKnown ||
								restore.state !== 'idle'
							}
						>
							<Trans>Mark available</Trans>
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
