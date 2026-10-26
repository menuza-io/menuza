import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	Empty,
	EmptyHeader,
	EmptyTitle,
	EmptyDescription,
	EmptyContent,
} from '@repo/ui/empty'
import { Icon } from '@repo/ui/icon'
import { Item, ItemContent } from '@repo/ui/item'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { categoryItems, isSoldOut } from '~/lib/catalog.ts'
import { lowestPriceCents } from '~/lib/menu-display.ts'
import { type MoneyFormatter } from '~/lib/money.ts'
import { usePos } from '~/lib/store.ts'
import { type MenuCategory, type MenuItem } from '~/lib/types.ts'
import { Button, Chip, Input, NumberPop, cn } from '~/ui/primitives.tsx'

const POPULAR = '__popular'

/** Follows a path of category ids down the tree; stops at the first miss. */
function resolvePath(
	categories: MenuCategory[],
	path: string[],
): MenuCategory[] {
	const out: MenuCategory[] = []
	let level = categories
	for (const id of path) {
		const node = level.find((c) => c.id === id)
		if (!node) break
		out.push(node)
		level = node.subcategories ?? []
	}
	return out
}

export function MenuGrid({
	categories,
	money,
	counts,
	onPick,
}: {
	categories: MenuCategory[]
	money: MoneyFormatter
	/** itemId -> quantity already in the cart. */
	counts: Map<string, number>
	onPick: (item: MenuItem) => void
}) {
	const { _ } = useLingui()
	// `path` is the chosen category, then sub-category, then its sub-category…
	const [path, setPath] = useState<string[]>(() =>
		categories[0] ? [categories[0].id] : [POPULAR],
	)
	const [query, setQuery] = useState('')
	const deferredQuery = useDeferredValue(query.trim().toLowerCase())

	const all = useMemo(() => {
		const seen = new Set<string>()
		return categories
			.flatMap(categoryItems)
			.filter((i) => !seen.has(i.id) && seen.add(i.id))
	}, [categories])
	const popular = useMemo(() => all.filter((i) => i.isPopular), [all])

	const topTabs = useMemo(
		() => [
			...(popular.length > 0
				? [{ id: POPULAR, name: _(t`Popular`), count: popular.length }]
				: []),
			...categories.map((c) => ({
				id: c.id,
				name: c.displayName,
				count: categoryItems(c).length,
			})),
		],
		[categories, popular, _],
	)
	const topId = topTabs.some((tab) => tab.id === path[0])
		? path[0]!
		: (topTabs[0]?.id ?? POPULAR)
	const chain =
		topId === POPULAR ? [] : resolvePath(categories, [topId, ...path.slice(1)])
	const deepest = chain[chain.length - 1]
	// One chip row per level that has children, so a three-level menu is navigable.
	const rows = chain
		.filter((node) => (node.subcategories?.length ?? 0) > 0)
		.map((node, depth) => ({
			node,
			depth,
			selected: chain[depth + 1]?.id ?? null,
		}))

	// Search also matches the restaurant's own language ("burger" on an Arabic till).
	const recordItems = usePos((s) => s.recordItems)
	const items = useMemo(() => {
		if (deferredQuery) {
			const matches = (text: string | null | undefined) =>
				Boolean(text?.toLowerCase().includes(deferredQuery))
			return all.filter((i) => {
				const recorded = recordItems.get(i.id)
				return (
					matches(i.displayName) ||
					matches(i.description) ||
					matches(recorded?.displayName) ||
					matches(recorded?.description)
				)
			})
		}
		if (topId === POPULAR) return popular
		return deepest ? categoryItems(deepest) : []
	}, [all, popular, deepest, topId, deferredQuery, recordItems])

	// A category picked at the edge of the strip scrolls fully into view.
	const navRef = useRef<HTMLElement>(null)
	useEffect(() => {
		const chip = navRef.current?.querySelector<HTMLElement>(
			'[aria-current="true"]',
		)
		chip?.scrollIntoView({
			block: 'nearest',
			inline: 'nearest',
			behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
				? 'auto'
				: 'smooth',
		})
	}, [topId])

	const choose = (depth: number, id: string | null) => {
		setQuery('')
		setPath((p) =>
			id === null ? p.slice(0, depth + 1) : [...p.slice(0, depth + 1), id],
		)
	}
	const itemCount = items.length
	const heading = deferredQuery
		? _(t`Search menu`)
		: topId === POPULAR
			? _(t`Popular`)
			: deepest?.displayName

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 flex-col gap-2 px-3 pt-3 sm:px-4 xl:flex-row xl:items-center xl:gap-3">
				<label className="relative block shrink-0 xl:w-64">
					<span className="sr-only">
						<Trans>Search the menu</Trans>
					</span>
					<Icon
						name="search"
						className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2"
					/>
					<Input
						type="search"
						autoComplete="off"
						autoCapitalize="none"
						spellCheck={false}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={_(t`Search menu`)}
						className="bg-card ps-10 pe-12"
					/>
					{query ? (
						<button
							type="button"
							aria-label={_(t`Clear search`)}
							onClick={() => setQuery('')}
							className="t-pop-in text-muted-foreground hover:bg-accent hover:text-foreground absolute end-0.5 top-0.5 flex size-11 items-center justify-center rounded-lg transition-colors"
						>
							<Icon name="x" className="size-4" />
						</button>
					) : null}
				</label>
				<nav
					ref={navRef}
					aria-label={_(t`Categories`)}
					className="no-scrollbar -mx-3 flex min-w-0 flex-1 gap-2 overflow-x-auto px-3 py-1 sm:mx-0 sm:px-0"
				>
					{topTabs.map((tab) => {
						const selected = !deferredQuery && tab.id === topId
						return (
							<Chip
								key={tab.id}
								selected={selected}
								aria-current={selected ? 'true' : undefined}
								look="filled"
								size="lg"
								onClick={() => {
									setQuery('')
									setPath([tab.id])
								}}
							>
								{tab.id === POPULAR ? (
									<Icon name="flame" className="size-4" />
								) : null}
								{tab.name}
								<span
									className={cn(
										'tnum mono text-xs',
										!selected && 'text-muted-foreground',
									)}
								>
									{tab.count}
								</span>
							</Chip>
						)
					})}
				</nav>
			</div>

			{!deferredQuery
				? rows.map(({ node, depth, selected }) => (
						<nav
							key={node.id}
							aria-label={_(t`${node.displayName} sections`)}
							className="no-scrollbar flex shrink-0 gap-2 overflow-x-auto px-3 pt-1.5 pb-1 sm:px-4"
						>
							<Chip
								look="filled"
								selected={selected === null}
								aria-current={selected === null ? 'true' : undefined}
								onClick={() => choose(depth, null)}
							>
								<Trans>All {node.displayName}</Trans>
							</Chip>
							{(node.subcategories ?? []).map((sub) => (
								<Chip
									key={sub.id}
									look="filled"
									selected={selected === sub.id}
									aria-current={selected === sub.id ? 'true' : undefined}
									onClick={() => choose(depth, sub.id)}
								>
									{sub.displayName}
									<span
										className={cn(
											'tnum mono text-xs',
											selected !== sub.id && 'text-muted-foreground',
										)}
									>
										{categoryItems(sub).length}
									</span>
								</Chip>
							))}
						</nav>
					))
				: null}

			<div className="flex shrink-0 items-baseline justify-between gap-3 px-3 pt-4 pb-3 sm:px-4">
				<h2 className="min-w-0 text-base font-semibold break-words">
					{heading}
				</h2>
				<p
					className="text-muted-foreground shrink-0 text-sm"
					role="status"
					aria-atomic="true"
				>
					{plural(itemCount, { one: '# item', other: '# items' })}
				</p>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4 sm:px-4">
				{items.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyTitle>
								<Trans>Nothing found</Trans>
							</EmptyTitle>
							<EmptyDescription>
								{deferredQuery ? (
									<Trans>No items match “{query}”.</Trans>
								) : (
									<Trans>This category is empty.</Trans>
								)}
							</EmptyDescription>
						</EmptyHeader>
						{deferredQuery ? (
							<EmptyContent>
								<Button variant="ghost" onClick={() => setQuery('')}>
									<Trans>Clear search</Trans>
								</Button>
							</EmptyContent>
						) : null}
					</Empty>
				) : (
					<ul
						// A new category rises in; typing a search does not replay it.
						key={deferredQuery ? 'search' : [topId, ...path.slice(1)].join('/')}
						// As many tiles as fit: two on a phone, more as the menu widens.
						className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))] gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))] sm:gap-3"
					>
						{items.map((item) => (
							<li key={item.id}>
								<ItemCard
									item={item}
									money={money}
									inCart={counts.get(item.id) ?? 0}
									onPick={onPick}
								/>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	)
}

function ItemCard({
	item,
	money,
	inCart,
	onPick,
}: {
	item: MenuItem
	money: MoneyFormatter
	inCart: number
	onPick: (item: MenuItem) => void
}) {
	const { _ } = useLingui()
	const soldOut = isSoldOut(item)
	const { cents, isFrom } = lowestPriceCents(item)
	const price = money(cents)
	const name = item.displayName
	const label = soldOut
		? inCart
			? _(t`${name}, sold out, ${inCart} in order`)
			: _(t`${name}, sold out`)
		: inCart
			? _(t`${name}, ${price}, ${inCart} in order`)
			: _(t`${name}, ${price}`)
	return (
		// The tile is the wrapper; the shared Item inside keeps its own spacing and stays the button.
		<div
			className={cn(
				'relative h-full overflow-hidden rounded-2xl border-2 transition active:scale-[0.99]',
				soldOut
					? 'bg-muted/40 text-muted-foreground border-dashed'
					: inCart > 0
						? 'border-primary bg-primary/5'
						: 'border-border bg-card hover:border-primary/50 hover:bg-muted/40',
			)}
		>
			<Item
				render={
					<button
						type="button"
						disabled={soldOut}
						onClick={() => onPick(item)}
						aria-label={label}
					/>
				}
				className="group h-full min-h-36 flex-col flex-nowrap items-stretch text-start disabled:cursor-not-allowed"
			>
				{item.imageUrl ? (
					<img
						src={item.imageUrl}
						alt=""
						loading="lazy"
						className="aspect-video w-full rounded-lg object-cover"
					/>
				) : null}
				<ItemContent>
					<span
						className={cn(
							'flex items-start gap-2',
							inCart > 0 && !item.imageUrl && 'pe-8',
						)}
					>
						<span className="line-clamp-2 min-w-0 flex-1 text-base leading-snug font-semibold">
							{item.displayName}
						</span>
						{item.isVegetarian ? (
							<Icon
								name="leaf"
								aria-label={_(t`Vegetarian`)}
								className="text-success mt-0.5 size-4 shrink-0"
							/>
						) : null}
					</span>
					{item.description && !item.imageUrl ? (
						<span className="text-muted-foreground line-clamp-2 text-sm">
							{item.description}
						</span>
					) : null}
					<span className="mt-auto flex items-center justify-between gap-2 pt-3">
						<span
							className={cn(
								'tnum text-sm font-medium',
								soldOut ? 'text-muted-foreground' : 'text-foreground',
							)}
						>
							{soldOut ? (
								<Trans>Sold out</Trans>
							) : isFrom ? (
								<Trans>From {price}</Trans>
							) : (
								price
							)}
						</span>
						{!soldOut ? (
							<Icon
								name="plus"
								aria-hidden
								className="text-muted-foreground group-hover:text-primary size-4 shrink-0"
							/>
						) : null}
					</span>
				</ItemContent>
			</Item>
			{inCart > 0 ? (
				<span
					aria-hidden
					className="tnum mono bg-primary text-primary-foreground pointer-events-none absolute end-2 top-2 flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-sm font-semibold"
				>
					<NumberPop value={String(inCart)} />
				</span>
			) : null}
		</div>
	)
}
