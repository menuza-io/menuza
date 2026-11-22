import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	type SetupFinding,
	setupChecksResultSchema,
	setupFixResultSchema,
} from '@repo/inventory'
import { Alert, AlertAction, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Skeleton } from '@repo/ui/skeleton'
import { WorkspacePanel } from '@repo/ui/workspace'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	useInventoryRevision,
	useNotifyInventoryChanged,
} from '#app/components/inventory/inventory-prefs.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { recipeHref } from '#app/utils/inventory/recipe-links.ts'

export type SetupCheckNames = {
	dishes: ReadonlyMap<string, string>
	options: ReadonlyMap<string, string>
}

function PutIn({ area }: { area: string }) {
	return <Trans>Put in {area}</Trans>
}

function ownerLabel(
	finding: Extract<
		SetupFinding,
		{ kind: 'recipe_no_lines' | 'recipe_archived_item' }
	>,
	names: SetupCheckNames,
	generic: string,
): string {
	if (finding.ownerKind === 'menu_item') {
		return names.dishes.get(finding.ownerId) ?? generic
	}
	if (finding.ownerKind === 'option') {
		return names.options.get(finding.ownerId) ?? generic
	}
	return generic
}

/**
 * "Check your setup" (#510): stock data that is probably a mistake, one row
 * per finding with the evidence and one fix. Fix applies the suggested change
 * (or opens the screen that fixes it); "It's correct" hides the row until the
 * data it rests on changes. Rule-based: no model, nothing guessed.
 */
export function SetupChecksPanel({
	orgSlug,
	locationId,
	names,
	currency,
	limit,
	seeAllHref,
	canEdit,
	canManagePurchasing,
}: {
	orgSlug: string
	locationId: string
	names: SetupCheckNames
	currency: string
	/** Show only the first rows with a "See all" link (Today); all rows on the page. */
	limit?: number
	seeAllHref?: string
	canEdit: boolean
	canManagePurchasing: boolean
}) {
	const { i18n, t } = useLingui()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const checks = useInventoryQuery(
		`/setup-checks?${new URLSearchParams({ locationId })}`,
		setupChecksResultSchema,
	)
	const { reload } = checks
	const revision = useInventoryRevision()
	const seen = useRef(revision)
	useEffect(() => {
		if (revision !== seen.current) {
			seen.current = revision
			reload()
		}
	}, [revision, reload])
	const [busy, setBusy] = useState<string | null>(null)
	const listRef = useRef<HTMLUListElement | null>(null)

	const findings = checks.data?.findings ?? []
	const total = findings.length
	const shown = limit ? findings.slice(0, limit) : findings
	if (checks.loading && !checks.data) {
		return <Skeleton className="h-24 w-full rounded-xl" />
	}
	// Nothing to check yet, or the member cannot read it: say nothing on Today.
	if (limit && (checks.error || findings.length === 0)) return null

	async function act(finding: SetupFinding, path: 'fix' | 'dismiss') {
		setBusy(finding.key)
		try {
			const answer = await request(`/setup-checks/${path}`, {
				method: 'POST',
				body: JSON.stringify({
					locationId,
					key: finding.key,
					fingerprint: finding.fingerprint,
				}),
			})
			if (path === 'fix') setupFixResultSchema.parse(answer)
			toast.success(path === 'fix' ? t`Fixed.` : t`Hidden until it changes.`)
			notifyChanged()
			reload()
			// The row that held the button is gone: keep the keyboard in the list.
			listRef.current?.focus()
		} catch (caught) {
			toast.error(i18n._(inventorySaveErrorMessage(caught)))
			reload()
		} finally {
			setBusy(null)
		}
	}

	const money = (minor: number, code: string) =>
		formatMoney(minor, code || currency, i18n.locale)
	const generic = t`A recipe`

	function sentence(finding: SetupFinding): ReactNode {
		switch (finding.kind) {
			case 'price_placeholder': {
				const { itemName: item, supplierName: supplier } = finding
				const price = money(finding.priceMinor, finding.currency)
				return (
					<Trans>
						<span className="font-medium wrap-anywhere">{item}</span> from{' '}
						<span className="wrap-anywhere">{supplier}</span> is priced at{' '}
						<bdi dir="ltr">{price}</bdi>. That looks like a placeholder.
					</Trans>
				)
			}
			case 'price_out_of_line': {
				const {
					itemName: item,
					supplierName: supplier,
					packName: pack,
				} = finding
				const price = money(finding.priceMinor, finding.currency)
				const suggested = money(finding.suggestedPriceMinor, finding.currency)
				return (
					<Trans>
						<span className="font-medium wrap-anywhere">{item}</span> from{' '}
						<span className="wrap-anywhere">{supplier}</span> costs{' '}
						<bdi dir="ltr">{price}</bdi> for {pack}, far from its other prices
						(about <bdi dir="ltr">{suggested}</bdi>). Was the price per pack
						worked out?
					</Trans>
				)
			}
			case 'unit_off_1000x': {
				const {
					itemName: item,
					supplierName: supplier,
					packName: pack,
				} = finding
				const tooSmall =
					finding.suggestedPackBaseQuantity > finding.packBaseQuantity
				return tooSmall ? (
					<Trans>
						The size of {pack} of{' '}
						<span className="font-medium wrap-anywhere">{item}</span> from{' '}
						<span className="wrap-anywhere">{supplier}</span> looks 1,000 times
						too small.
					</Trans>
				) : (
					<Trans>
						The size of {pack} of{' '}
						<span className="font-medium wrap-anywhere">{item}</span> from{' '}
						<span className="wrap-anywhere">{supplier}</span> looks 1,000 times
						too big.
					</Trans>
				)
			}
			case 'recipe_no_lines': {
				const owner = ownerLabel(finding, names, generic)
				return (
					<Trans>
						<span className="font-medium wrap-anywhere">{owner}</span> has a
						recipe with no ingredients.
					</Trans>
				)
			}
			case 'recipe_archived_item': {
				const owner = ownerLabel(finding, names, generic)
				const item = finding.itemName
				return (
					<Trans>
						<span className="font-medium wrap-anywhere">{owner}</span> uses{' '}
						<span className="wrap-anywhere">{item}</span>, which is archived.
					</Trans>
				)
			}
			case 'made_item_no_recipe': {
				const item = finding.itemName
				return (
					<Trans>
						<span className="font-medium wrap-anywhere">{item}</span> is made in
						house but has no recipe.
					</Trans>
				)
			}
			case 'dish_no_recipe': {
				const dish = names.dishes.get(finding.menuItemId) ?? t`A dish`
				const sold = finding.soldCount
				return (
					<Trans>
						<span className="font-medium wrap-anywhere">{dish}</span> sold{' '}
						<Plural value={sold} one="# time" other="# times" /> in the last 7
						days and has no recipe.
					</Trans>
				)
			}
			case 'item_no_area': {
				const item = finding.itemName
				return (
					<Trans>
						<span className="font-medium wrap-anywhere">{item}</span> is in no
						storage area, so it is never counted.
					</Trans>
				)
			}
		}
	}

	function fixAction(finding: SetupFinding): ReactNode {
		const fix = finding.fix
		if (fix.kind === 'apply') {
			if (!canEdit) return null
			if (
				(finding.kind === 'price_out_of_line' ||
					finding.kind === 'unit_off_1000x') &&
				!canManagePurchasing
			) {
				return null
			}
			const label =
				finding.kind === 'item_no_area' ? (
					<PutIn area={finding.suggestedAreaName} />
				) : finding.kind === 'unit_off_1000x' ? (
					<Trans>Fix the size</Trans>
				) : (
					<Trans>Use the suggested price</Trans>
				)
			return (
				<Button
					type="button"
					size="sm"
					disabled={busy === finding.key}
					aria-describedby={`finding-${finding.key}`}
					onClick={() => void act(finding, 'fix')}
					data-testid={`setup-check-fix-${finding.kind}`}
				>
					{label}
				</Button>
			)
		}
		const to =
			fix.kind === 'open_recipe'
				? recipeHref({
						orgSlug,
						ownerKind: fix.ownerKind,
						ownerId: fix.ownerId,
						lineItemId: fix.lineItemId,
					})
				: fix.kind === 'open_item'
					? `/${orgSlug}/inventory/stock/${encodeURIComponent(fix.itemId)}`
					: `/${orgSlug}/inventory/purchasing/suppliers/${encodeURIComponent(fix.supplierId)}`
		return (
			<Button
				size="sm"
				render={<Link to={to} />}
				aria-describedby={`finding-${finding.key}`}
				data-testid={`setup-check-open-${finding.kind}`}
			>
				<Trans>Fix it</Trans>
			</Button>
		)
	}

	return (
		<WorkspacePanel
			title={
				total > 0 ? (
					<Trans>Check your setup ({total})</Trans>
				) : (
					<Trans>Check your setup</Trans>
				)
			}
			data-testid="setup-checks"
		>
			{checks.error && !checks.data ? (
				<Alert variant="destructive">
					<AlertDescription>
						<Trans>We could not check your setup. Try again.</Trans>
					</AlertDescription>
					<AlertAction>
						<Button type="button" variant="outline" onClick={reload}>
							<Trans>Try again</Trans>
						</Button>
					</AlertAction>
				</Alert>
			) : findings.length === 0 ? (
				<EmptyState
					icons={['check-circle']}
					title={<Trans>Nothing looks wrong</Trans>}
					description={
						<Trans>
							Prices that look off, recipes with gaps and items nobody counts
							will show here.
						</Trans>
					}
				/>
			) : (
				<ul
					ref={listRef}
					tabIndex={-1}
					aria-label={t`Things to check in your setup`}
					className="flex flex-col divide-y rounded-xl border outline-none"
					data-testid="setup-checks-list"
				>
					{shown.map((finding) => (
						<li
							key={finding.key}
							className="flex flex-col gap-2 p-3"
							data-testid={`setup-check-${finding.kind}`}
						>
							<p id={`finding-${finding.key}`} className="text-sm text-pretty">
								{sentence(finding)}
							</p>
							<div className="flex flex-wrap gap-2">
								{fixAction(finding)}
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={busy === finding.key || !canEdit}
									aria-describedby={`finding-${finding.key}`}
									onClick={() => void act(finding, 'dismiss')}
									data-testid={`setup-check-dismiss-${finding.kind}`}
								>
									<Trans>It's correct</Trans>
								</Button>
							</div>
						</li>
					))}
				</ul>
			)}
			{limit && findings.length > limit && seeAllHref ? (
				<div className="mt-3">
					<Button
						variant="outline"
						size="sm"
						render={<Link to={seeAllHref} />}
						data-testid="setup-checks-see-all"
					>
						<Trans>See all {total}</Trans>
					</Button>
				</div>
			) : null}
		</WorkspacePanel>
	)
}
