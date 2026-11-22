import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	type UsedInResult,
	type UsedInRow,
	usedInResultSchema,
} from '@repo/inventory'
import { Skeleton } from '@repo/ui/skeleton'
import { Link } from 'react-router'
import { useQuantityFormat } from '#app/components/inventory/inventory-prefs.tsx'
import { useInventoryQuery } from '#app/hooks/use-inventory-client.ts'
import { isRecipesUnavailable } from '#app/utils/inventory/inventory-errors.ts'
import { recipeHref } from '#app/utils/inventory/recipe-links.ts'

export type UsedInNames = {
	dishes: ReadonlyMap<string, string>
	options: ReadonlyMap<string, string>
}

export function useUsedIn(itemId: string, enabled: boolean) {
	return useInventoryQuery(
		enabled ? `/items/${encodeURIComponent(itemId)}/used-in` : null,
		usedInResultSchema,
	)
}

/** What a row is called: the dish or option's name, a made item's own name, or a generic label. */
export function usedInName(
	row: UsedInRow,
	names: UsedInNames,
	generic: { size: string; dish: string; option: string },
): string {
	switch (row.ownerKind) {
		case 'made_item':
			return row.ownerName ?? generic.dish
		case 'menu_item':
			return names.dishes.get(row.ownerId) ?? generic.dish
		case 'option':
			return names.options.get(row.ownerId) ?? generic.option
		case 'variant':
			return generic.size
	}
}

/**
 * The list of recipes an item is in, with the quantity per portion and, for
 * members who may see money, each line's share of the dish's cost. Used on the
 * item sheet and in the archive confirmation.
 */
export function UsedInList({
	result,
	names,
	orgSlug,
	canSeeCost,
	currency,
	linkable = true,
	testId = 'used-in-list',
}: {
	result: UsedInResult
	names: UsedInNames
	orgSlug: string
	canSeeCost: boolean
	currency: string
	linkable?: boolean
	testId?: string
}) {
	const { t, i18n } = useLingui()
	const quantity = useQuantityFormat()
	const generic = {
		size: t`A size of a dish`,
		dish: t`A dish`,
		option: t`An option`,
	}
	const percent = new Intl.NumberFormat(i18n.locale, {
		style: 'percent',
		maximumFractionDigits: 0,
	})
	return (
		<ul
			className="flex flex-col divide-y rounded-xl border"
			data-testid={testId}
		>
			{result.rows.map((row, index) => {
				const name = usedInName(row, names, generic)
				const label = (
					<span className="wrap-anywhere">
						{row.mode === 'replace' ? <Trans>{name} (swapped in)</Trans> : name}
						{row.viaGroupName ? (
							<span className="text-muted-foreground">
								{' · '}
								<Trans>through {row.viaGroupName}</Trans>
							</span>
						) : null}
					</span>
				)
				return (
					<li
						key={`${row.ownerKind}-${row.ownerId}-${index}`}
						className="flex items-baseline justify-between gap-3 p-3 text-sm"
						data-testid={`used-in-row-${row.ownerId}`}
					>
						{linkable ? (
							<Link
								className="min-w-0 font-medium underline-offset-2 hover:underline"
								to={recipeHref({
									orgSlug,
									ownerKind: row.ownerKind,
									ownerId: row.ownerId,
									lineItemId: row.viaGroupItemId ?? undefined,
								})}
							>
								{label}
							</Link>
						) : (
							<span className="min-w-0 font-medium">{label}</span>
						)}
						<span className="text-muted-foreground shrink-0 text-end tabular-nums">
							<bdi dir="ltr">
								{quantity.format(row.quantity, { baseUnit: result.baseUnit })}
							</bdi>
							{canSeeCost &&
							row.shareBp !== null &&
							row.shareBp !== undefined ? (
								<>
									{' · '}
									<bdi dir="ltr">{percent.format(row.shareBp / 10_000)}</bdi>
								</>
							) : null}
							{canSeeCost && row.costMinor !== undefined ? (
								<span className="sr-only">{currency}</span>
							) : null}
						</span>
					</li>
				)
			})}
		</ul>
	)
}

/** The "Used in" card on the item sheet. Hidden while recipes are off. */
export function UsedInSection({
	itemId,
	enabled,
	names,
	orgSlug,
	canSeeCost,
	currency,
}: {
	itemId: string
	enabled: boolean
	names: UsedInNames
	orgSlug: string
	canSeeCost: boolean
	currency: string
}) {
	const used = useUsedIn(itemId, enabled)
	if (!enabled) return null
	if (used.error && isRecipesUnavailable(used.error)) return null
	return (
		<section
			className="flex flex-col gap-3"
			aria-labelledby="item-used-in"
			data-testid="item-used-in"
		>
			<h3 id="item-used-in" className="text-sm font-semibold">
				<Trans>Used in</Trans>
			</h3>
			{used.loading && !used.data ? (
				<Skeleton className="h-16 w-full rounded-xl" />
			) : !used.data ? null : used.data.rows.length === 0 ? (
				<p
					className="text-muted-foreground text-sm"
					data-testid="item-used-in-empty"
				>
					<Trans>No dish, option or made item uses this yet.</Trans>
				</p>
			) : (
				<>
					<UsedInList
						result={used.data}
						names={names}
						orgSlug={orgSlug}
						canSeeCost={canSeeCost}
						currency={currency}
					/>
					{used.data.more > 0 ? (
						<p className="text-muted-foreground text-sm">
							<Plural
								value={used.data.more}
								one="And # more recipe."
								other="And # more recipes."
							/>
						</p>
					) : null}
				</>
			)}
		</section>
	)
}
