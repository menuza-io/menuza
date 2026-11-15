import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	EMAIL_MENU_ITEM_MAX,
	formatEmailPrice,
	menuItemChanges,
	type EmailMenuItemBlock,
	type EmailMenuItemSnapshotItem,
} from '@repo/common/email-blocks-restaurant'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFetcher } from 'react-router'

type Catalog = {
	items: EmailMenuItemSnapshotItem[]
	locations: Array<{ id: string; name: string }>
	currency: string
	/** The location this list is for (null = base prices). */
	locationId: string | null
}

type Update = (patch: Record<string, unknown>) => void

function snapshotOf(items: EmailMenuItemSnapshotItem[]) {
	return { resolvedAt: new Date().toISOString(), items }
}

/**
 * Inspector for the Menu item block: pick one to three dishes from the live
 * menu, choose whose prices to show, and see when the menu has moved on since
 * the block was saved ("Update from menu"). The host route answers the
 * `menu_items` intent; the saved snapshot is re-resolved again on the server
 * when the email is saved, so this list only drives the editor.
 */
export function MenuItemInspector({
	block,
	onUpdate,
	enabled,
	endpoint,
}: {
	block: EmailMenuItemBlock
	onUpdate: Update
	enabled: boolean
	endpoint?: string
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<Catalog>()
	const fetcherRef = useRef(fetcher)
	fetcherRef.current = fetcher
	const [pickerOpen, setPickerOpen] = useState(false)
	const [query, setQuery] = useState('')
	const rebuildOnLoad = useRef(false)
	const { locationId, itemIds, showPrice, showDescription, snapshot } =
		block.config

	useEffect(() => {
		if (!enabled) return
		fetcherRef.current.submit(
			{ intent: 'menu_items', locationId: locationId ?? '' },
			endpoint ? { method: 'post', action: endpoint } : { method: 'post' },
		)
	}, [enabled, endpoint, locationId])

	const catalog =
		fetcher.data && fetcher.data.locationId === locationId ? fetcher.data : null
	const byId = useMemo(
		() => new Map((catalog?.items ?? []).map((item) => [item.itemId, item])),
		[catalog],
	)
	const changes = useMemo(
		() => (catalog ? menuItemChanges(block, byId) : []),
		[block, byId, catalog],
	)

	const rebuild = () => {
		const items = itemIds.flatMap((id) => {
			const fresh = byId.get(id)
			return fresh ? [fresh] : []
		})
		onUpdate({
			itemIds: items.map((item) => item.itemId),
			snapshot: items.length > 0 ? snapshotOf(items) : null,
		})
	}

	// A location change reprices the dishes once that location's list arrives.
	useEffect(() => {
		if (!catalog || !rebuildOnLoad.current) return
		rebuildOnLoad.current = false
		rebuild()
		// eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per arrival of the list
	}, [catalog])

	const chosen = snapshot?.items ?? []
	const fullRow = itemIds.length >= EMAIL_MENU_ITEM_MAX

	const add = (item: EmailMenuItemSnapshotItem) => {
		onUpdate({
			itemIds: [...itemIds, item.itemId],
			snapshot: snapshotOf([...chosen, item]),
		})
		setPickerOpen(false)
		setQuery('')
	}

	const remove = (itemId: string) => {
		const items = chosen.filter((item) => item.itemId !== itemId)
		onUpdate({
			itemIds: itemIds.filter((id) => id !== itemId),
			snapshot: items.length > 0 ? snapshotOf(items) : null,
		})
	}

	const candidates = (catalog?.items ?? []).filter(
		(item) =>
			!itemIds.includes(item.itemId) &&
			item.name.toLowerCase().includes(query.trim().toLowerCase()),
	)

	if (!enabled) {
		return (
			<p className="text-muted-foreground text-xs">
				<Trans>Dishes can't be picked in this editor.</Trans>
			</p>
		)
	}

	return (
		<div className="space-y-4">
			{changes.length > 0 ? (
				<div
					role="alert"
					className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
				>
					<p className="font-medium">
						<Trans>The menu has changed since this was saved.</Trans>
					</p>
					<ul className="list-disc space-y-0.5 ps-4">
						{changes.map((change) => {
							const name =
								chosen.find((item) => item.itemId === change.itemId)?.name ?? ''
							return (
								<li key={`${change.itemId}-${change.kind}`}>
									{change.kind === 'price' ? (
										<Trans>{name}: the price changed.</Trans>
									) : (
										<Trans>
											{name}: no longer on the live menu. Updating removes it.
										</Trans>
									)}
								</li>
							)
						})}
					</ul>
					<Button type="button" size="sm" variant="outline" onClick={rebuild}>
						<Icon name="refresh-cw" className="size-3.5" />
						<Trans>Update from menu</Trans>
					</Button>
				</div>
			) : null}

			{(catalog?.locations.length ?? 0) > 1 ? (
				<div className="space-y-2">
					<Label htmlFor="menu-item-location">
						<Trans>Prices at</Trans>
					</Label>
					<select
						id="menu-item-location"
						className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
						value={locationId ?? ''}
						onChange={(event) => {
							rebuildOnLoad.current = true
							onUpdate({ locationId: event.target.value || null })
						}}
					>
						<option value="">{_(msg`Base price`)}</option>
						{catalog?.locations.map((location) => (
							<option key={location.id} value={location.id}>
								{location.name}
							</option>
						))}
					</select>
				</div>
			) : null}

			<div className="space-y-2">
				<Label>
					<Trans>Dishes</Trans>
				</Label>
				{chosen.length === 0 ? (
					<p className="text-muted-foreground text-xs">
						<Trans>Pick up to three dishes from your live menu.</Trans>
					</p>
				) : (
					<ul className="space-y-1.5">
						{chosen.map((item) => (
							<li
								key={item.itemId}
								className="border-border flex items-center gap-2 rounded-lg border p-2"
							>
								<div className="min-w-0 flex-1">
									<div className="truncate text-sm font-medium">
										{item.name}
									</div>
									{item.priceMinor !== null ? (
										<div className="text-muted-foreground text-xs">
											{formatEmailPrice(item.priceMinor, item.currency, 'en')}
										</div>
									) : null}
								</div>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									aria-label={_(msg`Remove dish`)}
									onClick={() => remove(item.itemId)}
								>
									<Icon name="trash-2" className="size-3.5" />
								</Button>
							</li>
						))}
					</ul>
				)}
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="w-full"
					disabled={fullRow || !catalog}
					onClick={() => setPickerOpen(true)}
				>
					<Icon name="plus" className="size-3.5" />
					<Trans>Add dish</Trans>
				</Button>
			</div>

			<div className="flex items-center gap-2">
				<Checkbox
					id="menu-item-show-price"
					checked={showPrice}
					onCheckedChange={(checked) =>
						onUpdate({ showPrice: checked === true })
					}
				/>
				<Label htmlFor="menu-item-show-price">
					<Trans>Show price</Trans>
				</Label>
			</div>
			<div className="flex items-center gap-2">
				<Checkbox
					id="menu-item-show-description"
					checked={showDescription}
					onCheckedChange={(checked) =>
						onUpdate({ showDescription: checked === true })
					}
				/>
				<Label htmlFor="menu-item-show-description">
					<Trans>Show description</Trans>
				</Label>
			</div>

			<Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
				<DialogContent className="gap-4 sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							<Trans>Add a dish</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>Only dishes on your live menu can be added.</Trans>
						</DialogDescription>
					</DialogHeader>
					<Input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={_(msg`Search dishes`)}
						aria-label={_(msg`Search dishes`)}
					/>
					<ul className="max-h-72 space-y-1 overflow-y-auto">
						{candidates.length === 0 ? (
							<li className="text-muted-foreground p-2 text-sm">
								<Trans>No dishes found.</Trans>
							</li>
						) : (
							candidates.slice(0, 100).map((item) => (
								<li key={item.itemId}>
									<button
										type="button"
										className="hover:bg-muted flex w-full items-center justify-between gap-3 rounded-md p-2 text-start text-sm"
										onClick={() => add(item)}
									>
										<span className="truncate">{item.name}</span>
										{item.priceMinor !== null ? (
											<span className="text-muted-foreground shrink-0 text-xs">
												{formatEmailPrice(item.priceMinor, item.currency, 'en')}
											</span>
										) : null}
									</button>
								</li>
							))
						)}
					</ul>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>
							<Trans>Cancel</Trans>
						</DialogClose>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}
