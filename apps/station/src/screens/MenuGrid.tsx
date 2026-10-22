import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Flame, Leaf, Plus, Search, X } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import { categoryItems, isSoldOut } from '~/lib/catalog.ts'
import { lowestPriceCents } from '~/lib/menu-display.ts'
import { type MoneyFormatter } from '~/lib/money.ts'
import { type MenuCategory, type MenuItem } from '~/lib/types.ts'
import { Button, cn } from '~/ui/primitives.tsx'

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

	const items = useMemo(() => {
		if (deferredQuery) {
			return all.filter(
				(i) =>
					i.displayName.toLowerCase().includes(deferredQuery) ||
					i.description?.toLowerCase().includes(deferredQuery),
			)
		}
		if (topId === POPULAR) return popular
		return deepest ? categoryItems(deepest) : []
	}, [all, popular, deepest, topId, deferredQuery])

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
					<Search className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2" />
					<input
						type="search"
						autoComplete="off"
						autoCapitalize="none"
						spellCheck={false}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={_(t`Search menu`)}
						className="border-input bg-card placeholder:text-muted-foreground focus:border-ring h-12 w-full rounded-xl border ps-10 pe-12 text-base"
					/>
					{query ? (
						<button
							type="button"
							aria-label={_(t`Clear search`)}
							onClick={() => setQuery('')}
							className="text-muted-foreground hover:bg-accent absolute end-0.5 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-lg"
						>
							<X className="size-4" />
						</button>
					) : null}
				</label>
				<nav
					aria-label={_(t`Categories`)}
					className="no-scrollbar -mx-3 flex min-w-0 flex-1 gap-2 overflow-x-auto px-3 py-1 sm:mx-0 sm:px-0"
				>
					{topTabs.map((tab) => {
						const selected = !deferredQuery && tab.id === topId
						return (
							<Chip
								key={tab.id}
								selected={selected}
								size="lg"
								onClick={() => {
									setQuery('')
									setPath([tab.id])
								}}
							>
								{tab.id === POPULAR ? <Flame className="size-4" /> : null}
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
								selected={selected === null}
								onClick={() => choose(depth, null)}
							>
								<Trans>All {node.displayName}</Trans>
							</Chip>
							{(node.subcategories ?? []).map((sub) => (
								<Chip
									key={sub.id}
									selected={selected === sub.id}
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
				<h2 className="min-w-0 truncate text-lg font-semibold">{heading}</h2>
				<p
					className="text-muted-foreground shrink-0 text-sm"
					role="status"
					aria-atomic="true"
				>
					{plural(itemCount, { one: '# item', other: '# items' })}
				</p>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 sm:px-4">
				{items.length === 0 ? (
					<div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 px-4 py-8 text-center">
						<Search className="mb-2 size-8" />
						<p className="text-foreground text-lg font-medium">
							<Trans>Nothing found</Trans>
						</p>
						<p>
							{deferredQuery ? (
								<Trans>No items match “{query}”.</Trans>
							) : (
								<Trans>This category is empty.</Trans>
							)}
						</p>
						{deferredQuery ? (
							<Button
								variant="outline"
								className="mt-3"
								onClick={() => setQuery('')}
							>
								<Trans>Clear search</Trans>
							</Button>
						) : null}
					</div>
				) : (
					<ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))] gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))] sm:gap-3">
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

function Chip({
	selected,
	size = 'md',
	onClick,
	children,
}: {
	selected: boolean
	size?: 'md' | 'lg'
	onClick: () => void
	children: React.ReactNode
}) {
	return (
		<button
			type="button"
			aria-current={selected ? 'true' : undefined}
			onClick={onClick}
			className={cn(
				'flex shrink-0 items-center gap-2 rounded-xl border font-semibold transition active:scale-95',
				size === 'lg' ? 'h-12 px-4' : 'h-11 px-3.5 text-sm',
				selected
					? 'border-primary bg-primary text-primary-foreground shadow-sm'
					: 'border-border bg-card hover:bg-accent',
			)}
		>
			{children}
		</button>
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
		<button
			type="button"
			disabled={soldOut}
			onClick={() => onPick(item)}
			aria-label={label}
			className={cn(
				'group relative flex h-full min-h-36 w-full flex-col overflow-hidden rounded-2xl border-2 text-start transition active:scale-[0.99]',
				soldOut
					? 'bg-muted/40 text-muted-foreground cursor-not-allowed border-dashed'
					: inCart > 0
						? 'border-primary bg-primary/5'
						: 'border-border bg-card hover:border-primary/50 hover:bg-muted/40',
			)}
		>
			{item.imageUrl ? (
				<img
					src={item.imageUrl}
					alt=""
					loading="lazy"
					className="aspect-[16/9] w-full object-cover"
				/>
			) : null}
			<div className="flex flex-1 flex-col gap-1.5 p-3">
				<div
					className={cn(
						'flex items-start gap-2',
						inCart > 0 && !item.imageUrl && 'pe-8',
					)}
				>
					<span className="line-clamp-2 min-w-0 flex-1 text-base leading-snug font-semibold">
						{item.displayName}
					</span>
					{item.isVegetarian ? (
						<Leaf
							aria-label={_(t`Vegetarian`)}
							className="text-success mt-0.5 size-4 shrink-0"
						/>
					) : null}
				</div>
				{item.description && !item.imageUrl ? (
					<span className="text-muted-foreground line-clamp-2 text-sm">
						{item.description}
					</span>
				) : null}
				<div className="mt-auto flex items-center justify-between gap-2 pt-3">
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
						<Plus
							aria-hidden="true"
							className="text-muted-foreground group-hover:text-primary size-4 shrink-0"
						/>
					) : null}
				</div>
			</div>
			{inCart > 0 ? (
				<span
					aria-hidden="true"
					className="tnum mono bg-primary text-primary-foreground absolute end-2 top-2 flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-sm font-bold"
				>
					{inCart}
				</span>
			) : null}
		</button>
	)
}
