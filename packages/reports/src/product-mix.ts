/**
 * The product mix tree (#227): menu, category, dish, option group, option,
 * each row with quantity, sales, share of quantity, share of sales and
 * average price. Pure: it folds the finest-grain rows the region returns into
 * whichever levels are switched on, so toggling a level never changes the
 * total. Option sales roll up into their dish (they are already part of the
 * dish's sales), which is why the total is the dishes' sales and an option
 * row is an "of which".
 *
 * One tree per currency: money is never added across currencies.
 */

export const PRODUCT_MIX_LEVELS = [
	'menu',
	'category',
	'dish',
	'optionGroup',
	'option',
] as const
export type ProductMixLevel = (typeof PRODUCT_MIX_LEVELS)[number]

export const PRODUCT_MIX_LEVEL_LABELS: Record<ProductMixLevel, string> = {
	menu: 'Menu',
	category: 'Category',
	dish: 'Dish',
	optionGroup: 'Option group',
	option: 'Option',
}

/** What a line sold before the menu and category were stamped is grouped under. */
export const EARLIER_SALES = 'Earlier sales'

/**
 * One finest-grain row from the region. `dish` rows carry the dish's whole
 * sales (options included); `option` rows carry the options' share of it and
 * repeat the dish's menu, category and name.
 */
export type ProductMixRow = {
	kind: 'dish' | 'option'
	currency: string
	menuId: string
	menu: string
	categoryId: string
	category: string
	itemId: string
	item: string
	/** Option rows only. */
	optionGroup?: string
	option?: string
	quantity: number
	/** Net sales in minor units. */
	salesMinor: number
}

export type ProductMixNode = {
	/** Stable across renders: the level and the names down to this row. */
	key: string
	level: ProductMixLevel
	label: string
	quantity: number
	salesMinor: number
	/** 0 to 100, of the filtered total. Null when the total is 0. */
	shareOfQuantity: number | null
	shareOfSales: number | null
	/** Net sales per unit in minor units; null for no units. */
	averagePriceMinor: number | null
	children: ProductMixNode[]
}

export type ProductMixTree = {
	currency: string
	total: { quantity: number; salesMinor: number }
	nodes: ProductMixNode[]
}

/** The levels in their fixed order, whichever were asked for. */
export function orderedLevels(
	levels: readonly ProductMixLevel[],
): ProductMixLevel[] {
	return PRODUCT_MIX_LEVELS.filter((level) => levels.includes(level))
}

function labelOf(row: ProductMixRow, level: ProductMixLevel): string {
	switch (level) {
		case 'menu':
			return row.menu || EARLIER_SALES
		case 'category':
			return row.category || EARLIER_SALES
		case 'dish':
			return row.item || row.itemId
		case 'optionGroup':
			return row.optionGroup || ''
		case 'option':
			return row.option || ''
	}
}

function keyPartOf(row: ProductMixRow, level: ProductMixLevel): string {
	switch (level) {
		case 'menu':
			return row.menuId || row.menu
		case 'category':
			return row.categoryId || row.category
		case 'dish':
			return row.itemId
		case 'optionGroup':
			return row.optionGroup ?? ''
		case 'option':
			return row.option ?? ''
	}
}

type Draft = {
	key: string
	level: ProductMixLevel
	label: string
	quantity: number
	salesMinor: number
	children: Map<string, Draft>
}

function share(part: number, whole: number): number | null {
	return whole > 0 ? (part / whole) * 100 : null
}

/**
 * Folds `rows` of one currency into a tree of the shown `levels`.
 *
 * - The grand total is the sum of the dish rows, whatever is shown.
 * - A dish, category or menu node's sales are the sum of the dish rows under
 *   it, so the nodes of any one of those levels add up to the total.
 * - An option group or option node shows the options' own quantity and sales
 *   (a share of the dish rows' sales, not an addition to them).
 * - With the dish level off, option rows hang from the nearest shown level
 *   above them, and with option levels off the dish rows' sales already
 *   include them: no combination changes the total.
 */
export function buildProductMixTree(
	rows: readonly ProductMixRow[],
	levels: readonly ProductMixLevel[],
	currency: string,
): ProductMixTree {
	const shown = orderedLevels(levels)
	const mine = rows.filter((row) => row.currency === currency)
	const dishRows = mine.filter((row) => row.kind === 'dish')
	const total = dishRows.reduce(
		(sum, row) => ({
			quantity: sum.quantity + row.quantity,
			salesMinor: sum.salesMinor + row.salesMinor,
		}),
		{ quantity: 0, salesMinor: 0 },
	)

	const root = new Map<string, Draft>()
	const place = (row: ProductMixRow, rowLevels: readonly ProductMixLevel[]) => {
		let siblings = root
		let path = ''
		for (const level of rowLevels) {
			const part = keyPartOf(row, level)
			path = `${path}${path ? '\u0000' : ''}${level}:${part}`
			let node = siblings.get(path)
			if (!node) {
				node = {
					key: path,
					level,
					label: labelOf(row, level),
					quantity: 0,
					salesMinor: 0,
					children: new Map(),
				}
				siblings.set(path, node)
			}
			node.quantity += row.quantity
			node.salesMinor += row.salesMinor
			siblings = node.children
		}
	}

	const structural = shown.filter(
		(level) => level === 'menu' || level === 'category' || level === 'dish',
	)
	const optionLevels = shown.filter(
		(level) => level === 'optionGroup' || level === 'option',
	)
	for (const row of dishRows) place(row, structural)
	// Option rows add their own figures at the option levels, under the same
	// structural ancestors, but never to those ancestors (their sales are the
	// dishes' sales).
	if (optionLevels.length > 0) {
		for (const row of mine.filter((entry) => entry.kind === 'option')) {
			let siblings = root
			let path = ''
			for (const level of structural) {
				path = `${path}${path ? '\u0000' : ''}${level}:${keyPartOf(row, level)}`
				let node = siblings.get(path)
				if (!node) {
					// An option whose dish row is not in the window (a refund-free
					// edge): its ancestors exist with nothing of their own.
					node = {
						key: path,
						level,
						label: labelOf(row, level),
						quantity: 0,
						salesMinor: 0,
						children: new Map(),
					}
					siblings.set(path, node)
				}
				siblings = node.children
			}
			for (const level of optionLevels) {
				const part = keyPartOf(row, level)
				// An option sits inside its group when both levels are shown.
				path = `${path}${path ? '\u0000' : ''}${level}:${part}`
				let node = siblings.get(path)
				if (!node) {
					node = {
						key: path,
						level,
						label: labelOf(row, level),
						quantity: 0,
						salesMinor: 0,
						children: new Map(),
					}
					siblings.set(path, node)
				}
				node.quantity += row.quantity
				node.salesMinor += row.salesMinor
				siblings = node.children
			}
		}
	}

	const finish = (drafts: Map<string, Draft>): ProductMixNode[] =>
		[...drafts.values()]
			.sort(
				(a, b) =>
					b.salesMinor - a.salesMinor ||
					b.quantity - a.quantity ||
					a.label.localeCompare(b.label),
			)
			.map((draft) => ({
				key: draft.key,
				level: draft.level,
				label: draft.label,
				quantity: draft.quantity,
				salesMinor: draft.salesMinor,
				shareOfQuantity: share(draft.quantity, total.quantity),
				shareOfSales: share(draft.salesMinor, total.salesMinor),
				averagePriceMinor:
					draft.quantity > 0
						? Math.round(draft.salesMinor / draft.quantity)
						: null,
				children: finish(draft.children),
			}))
	return { currency, total, nodes: finish(root) }
}

/** The currencies present, most sales first (one tree block each). */
export function productMixCurrencies(rows: readonly ProductMixRow[]): string[] {
	const sales = new Map<string, number>()
	for (const row of rows) {
		if (row.kind !== 'dish') continue
		sales.set(row.currency, (sales.get(row.currency) ?? 0) + row.salesMinor)
	}
	return [...sales.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([currency]) => currency)
}

export type FlatProductMixRow = {
	level: ProductMixLevel
	path: string[]
	label: string
	quantity: number
	salesMinor: number
	shareOfQuantity: number | null
	shareOfSales: number | null
	averagePriceMinor: number | null
}

/** The tree as rows in reading order, each with the labels down to it. */
export function flattenProductMixTree(
	tree: ProductMixTree,
	only?: ProductMixLevel,
): FlatProductMixRow[] {
	const out: FlatProductMixRow[] = []
	const visit = (nodes: readonly ProductMixNode[], path: string[]) => {
		for (const node of nodes) {
			const here = [...path, node.label]
			if (!only || node.level === only) {
				out.push({
					level: node.level,
					path: here,
					label: node.label,
					quantity: node.quantity,
					salesMinor: node.salesMinor,
					shareOfQuantity: node.shareOfQuantity,
					shareOfSales: node.shareOfSales,
					averagePriceMinor: node.averagePriceMinor,
				})
			}
			visit(node.children, here)
		}
	}
	visit(tree.nodes, [])
	return out
}

function csvCell(value: string): string {
	// A cell that starts like a formula is quoted as text, and quotes are doubled.
	const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
	return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

function percent(value: number | null): string {
	return value === null ? '' : value.toFixed(1)
}

function money(minor: number | null): string {
	return minor === null ? '' : (minor / 100).toFixed(2)
}

/**
 * CSV of the tree: one file per level (`only`) or every shown row in one file.
 * Each row names its level and the path down to it, so one file can be sorted
 * and filtered in a spreadsheet.
 */
export function productMixCsv(
	tree: ProductMixTree,
	only?: ProductMixLevel,
	showPercentages = true,
): string {
	const header = [
		'Level',
		'Menu / Category / Dish / Option group / Option',
		'Currency',
		'Quantity',
		'Sales',
		...(showPercentages ? ['Share of quantity %', 'Share of sales %'] : []),
		'Average price',
	]
	const lines = [header.map(csvCell).join(',')]
	for (const row of flattenProductMixTree(tree, only)) {
		lines.push(
			[
				PRODUCT_MIX_LEVEL_LABELS[row.level],
				row.path.join(' > '),
				tree.currency,
				String(row.quantity),
				money(row.salesMinor),
				...(showPercentages
					? [percent(row.shareOfQuantity), percent(row.shareOfSales)]
					: []),
				money(row.averagePriceMinor),
			]
				.map(csvCell)
				.join(','),
		)
	}
	lines.push(
		[
			'Total',
			'All dishes',
			tree.currency,
			String(tree.total.quantity),
			money(tree.total.salesMinor),
			...(showPercentages ? ['100.0', '100.0'] : []),
			money(
				tree.total.quantity > 0
					? Math.round(tree.total.salesMinor / tree.total.quantity)
					: null,
			),
		]
			.map(csvCell)
			.join(','),
	)
	return lines.join('\n')
}
