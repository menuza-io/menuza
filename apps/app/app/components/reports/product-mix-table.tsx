import { Trans, useLingui } from '@lingui/react/macro'
import {
	type ProductMixLevel,
	type ProductMixNode,
	type ProductMixTree,
} from '@repo/reports/product-mix'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useMemo } from 'react'

export function formatMinor(minor: number, currency: string, locale: string) {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
		}).format(minor / 100)
	} catch {
		return `${(minor / 100).toFixed(2)} ${currency}`
	}
}

function formatPercent(value: number | null, locale: string) {
	if (value === null) return '—'
	return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)}%`
}

type FlatRow = { node: ProductMixNode; depth: number }

function flatten(nodes: readonly ProductMixNode[], depth = 0): FlatRow[] {
	return nodes.flatMap((node) => [
		{ node, depth },
		...flatten(node.children, depth + 1),
	])
}

/**
 * One currency's product mix tree (#227). Indentation shows the level, the
 * total row is the sum of the dishes whichever levels are shown, and option
 * rows are an "of which" of their dish (never added to it).
 */
export function ProductMixTable({
	tree,
	showPercentages,
	levelLabel,
}: {
	tree: ProductMixTree
	showPercentages: boolean
	/** Translated names of the levels. */
	levelLabel: (level: ProductMixLevel) => string
}) {
	const { i18n } = useLingui()
	const locale = i18n.locale
	const rows = useMemo(() => flatten(tree.nodes), [tree])
	const averageOfTotal =
		tree.total.quantity > 0
			? Math.round(tree.total.salesMinor / tree.total.quantity)
			: null
	return (
		<div className="overflow-x-auto" data-testid={`product-mix-${tree.currency}`}>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>
							<Trans>Name</Trans>
						</TableHead>
						<TableHead className="text-end">
							<Trans>Quantity</Trans>
						</TableHead>
						<TableHead className="text-end">
							<Trans>Sales</Trans>
						</TableHead>
						{showPercentages ? (
							<>
								<TableHead className="text-end">
									<Trans>Share of quantity</Trans>
								</TableHead>
								<TableHead className="text-end">
									<Trans>Share of sales</Trans>
								</TableHead>
							</>
						) : null}
						<TableHead className="text-end">
							<Trans>Average price</Trans>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map(({ node, depth }) => (
						<TableRow key={node.key} data-testid="product-mix-row">
							<TableCell>
								<span
									className="flex items-baseline gap-2"
									style={{ paddingInlineStart: `${depth * 1.25}rem` }}
								>
									<span className="text-muted-foreground text-xs">
										{levelLabel(node.level)}
									</span>
									<span className="font-medium">{node.label}</span>
								</span>
							</TableCell>
							<TableCell className="text-end tabular-nums">
								{node.quantity}
							</TableCell>
							<TableCell className="text-end tabular-nums">
								{formatMinor(node.salesMinor, tree.currency, locale)}
							</TableCell>
							{showPercentages ? (
								<>
									<TableCell className="text-end tabular-nums">
										{formatPercent(node.shareOfQuantity, locale)}
									</TableCell>
									<TableCell className="text-end tabular-nums">
										{formatPercent(node.shareOfSales, locale)}
									</TableCell>
								</>
							) : null}
							<TableCell className="text-end tabular-nums">
								{node.averagePriceMinor === null
									? '—'
									: formatMinor(node.averagePriceMinor, tree.currency, locale)}
							</TableCell>
						</TableRow>
					))}
					<TableRow className="font-semibold" data-testid="product-mix-total">
						<TableCell>
							<Trans>Total</Trans>
						</TableCell>
						<TableCell className="text-end tabular-nums">
							{tree.total.quantity}
						</TableCell>
						<TableCell className="text-end tabular-nums">
							{formatMinor(tree.total.salesMinor, tree.currency, locale)}
						</TableCell>
						{showPercentages ? (
							<>
								<TableCell className="text-end tabular-nums">
									{formatPercent(tree.total.quantity > 0 ? 100 : null, locale)}
								</TableCell>
								<TableCell className="text-end tabular-nums">
									{formatPercent(tree.total.salesMinor > 0 ? 100 : null, locale)}
								</TableCell>
							</>
						) : null}
						<TableCell className="text-end tabular-nums">
							{averageOfTotal === null
								? '—'
								: formatMinor(averageOfTotal, tree.currency, locale)}
						</TableCell>
					</TableRow>
				</TableBody>
			</Table>
		</div>
	)
}

/** The words for each level, for labels and the level switches. */
export function useLevelLabels(): (level: ProductMixLevel) => string {
	const { t } = useLingui()
	return (level) => {
		switch (level) {
			case 'menu':
				return t`Menu`
			case 'category':
				return t`Category`
			case 'dish':
				return t`Dish`
			case 'optionGroup':
				return t`Option group`
			case 'option':
				return t`Option`
		}
	}
}

