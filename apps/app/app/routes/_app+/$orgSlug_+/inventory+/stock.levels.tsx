import { plural } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	INVENTORY_PERMISSIONS,
	levelSuggestionsSchema,
	listLevelsResultSchema,
	putLevelsResultSchema,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Skeleton } from '@repo/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { useStockContext } from '#app/components/inventory/stock-context.ts'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import {
	inventoryErrorMessage,
	inventorySaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import {
	applyLevelSuggestion,
	buildPutLevels,
	enoughHistory,
	type LevelDraft,
	levelDraftChanged,
	levelDraftFromRow,
	type LevelProblem,
} from '#app/utils/inventory/levels-form.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'
import { type Route } from './+types/stock.levels.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireInventoryAccess(request, params.orgSlug, {
		anyOf: [INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING],
	})
	// Levels drive ordering, so they come with the purchasing flag.
	if (!access.features.purchasing) {
		throw new Response('Not Found', { status: 404 })
	}
	return null
}

const PAGE_SIZE = 50
const MAX_LIMIT = 200
const SEARCH_DELAY_MS = 250

type Show = 'all' | 'unset'

/**
 * Levels for every item in one table: "Order more when below" and "Fill up
 * to", each in the unit the item is counted in. Suggested orders use them.
 * "Suggest from use" fills the fields from what the location really used;
 * nothing is saved until Save.
 */
export default function InventoryLevelsRoute() {
	const { t, i18n } = useLingui()
	const ctx = useStockContext()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const [show, setShow] = useState<Show>('all')
	const [searchText, setSearchText] = useState('')
	const [q, setQ] = useState('')
	const [limit, setLimit] = useState(PAGE_SIZE)
	const [drafts, setDrafts] = useState<Record<string, LevelDraft>>({})
	const [problems, setProblems] = useState<Record<
		string,
		LevelProblem[]
	> | null>(null)
	const [suggestionsOn, setSuggestionsOn] = useState(false)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [refused, setRefused] = useState(0)

	useEffect(() => {
		const timer = setTimeout(() => setQ(searchText.trim()), SEARCH_DELAY_MS)
		return () => clearTimeout(timer)
	}, [searchText])

	const path = `/levels?${new URLSearchParams({
		locationId: ctx.activeLocationId,
		filter: show,
		limit: String(limit),
		...(q ? { q } : {}),
	})}`
	const levels = useInventoryQuery(path, listLevelsResultSchema)
	const suggestions = useInventoryQuery(
		suggestionsOn
			? `/levels/suggestions?locationId=${encodeURIComponent(ctx.activeLocationId)}`
			: null,
		levelSuggestionsSchema,
	)
	const rows = useMemo(() => levels.data?.levels ?? [], [levels.data])
	const system = quantity.system

	// New rows start from what the region has; rows already being edited keep
	// what was typed, also across a search or a filter.
	useEffect(() => {
		setDrafts((current) => {
			let next = current
			for (const row of rows) {
				if (!(row.itemId in current)) {
					if (next === current) next = { ...current }
					next[row.itemId] = levelDraftFromRow(row, system)
				}
			}
			return next
		})
	}, [rows, system])

	const suggestionByItem = useMemo(
		() =>
			new Map(
				(suggestions.data?.suggestions ?? []).map((entry) => [
					entry.itemId,
					entry,
				]),
			),
		[suggestions.data],
	)
	const changed = Object.values(drafts).filter(levelDraftChanged)

	function patch(itemId: string, update: Partial<LevelDraft>) {
		setDrafts((current) => {
			const draft = current[itemId]
			return draft ? { ...current, [itemId]: { ...draft, ...update } } : current
		})
	}

	function applySuggestionTo(itemId: string) {
		const suggestion = suggestionByItem.get(itemId)
		setDrafts((current) => {
			const draft = current[itemId]
			return draft && suggestion
				? { ...current, [itemId]: applyLevelSuggestion(draft, suggestion) }
				: current
		})
	}

	function applyAllSuggestions() {
		setDrafts((current) => {
			const next = { ...current }
			for (const row of rows) {
				const suggestion = suggestionByItem.get(row.itemId)
				const draft = next[row.itemId]
				if (suggestion && draft) {
					next[row.itemId] = applyLevelSuggestion(draft, suggestion)
				}
			}
			return next
		})
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (saving) return
		setError(null)
		setRefused(0)
		const built = buildPutLevels(Object.values(drafts), {
			clientId: newClientId('l'),
			locationId: ctx.activeLocationId,
		})
		if (built.ok === 'empty') return
		if (!built.ok) {
			setProblems(built.problems)
			return
		}
		setProblems(null)
		setSaving(true)
		try {
			const result = putLevelsResultSchema.parse(
				await request('/levels/bulk', {
					method: 'PUT',
					body: JSON.stringify(built.payload),
				}),
			)
			const done = result.updated.length
			if (done > 0) {
				toast.success(
					plural(done, {
						one: 'Levels saved for # item',
						other: 'Levels saved for # items',
					}),
				)
			}
			setRefused(result.refused.length)
			// Saved rows keep what was typed under their new version; a row that was
			// refused starts over from what the region has now.
			setDrafts((current) => {
				const next = { ...current }
				for (const saved of result.updated) {
					const draft = next[saved.itemId]
					if (!draft) continue
					const below = draft.belowText.trim()
					const fill = draft.fillText.trim()
					next[saved.itemId] = {
						...draft,
						belowText: below,
						fillText: fill,
						initialBelow: below,
						initialFill: fill,
						placeVersion: saved.version,
					}
				}
				for (const skipped of result.refused) delete next[skipped.itemId]
				return next
			})
			levels.reload()
			ctx.reload()
			notifyChanged()
			if (result.refused.length === 0 && done > 0) ctx.close()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setSaving(false)
		}
	}

	const daysObserved = suggestions.data?.daysObserved ?? null
	const total = levels.data?.total ?? 0
	const shown = rows.length

	return (
		<SheetForm
			title={<Trans>Levels</Trans>}
			description={
				<Trans>
					Say when to order more and how much to fill up to. Suggested orders
					use these.
				</Trans>
			}
			onSubmit={(event) => void submit(event)}
			footer={
				<>
					<Button type="button" variant="outline" onClick={ctx.close}>
						<Trans>Close</Trans>
					</Button>
					<Button
						type="submit"
						disabled={saving || changed.length === 0}
						data-testid="levels-save"
					>
						{saving ? <Icon name="loader" className="animate-spin" /> : null}
						{changed.length > 0 ? (
							<Plural
								value={changed.length}
								one="Save # change"
								other="Save # changes"
							/>
						) : (
							<Trans>Save</Trans>
						)}
					</Button>
				</>
			}
		>
			{error ? (
				<Alert variant="destructive" data-testid="levels-error">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			{refused > 0 ? (
				<Alert data-testid="levels-refused">
					<AlertDescription>
						<Plural
							value={refused}
							one="# item was changed by someone else, so it was not saved. It shows its new levels below."
							other="# items were changed by someone else, so they were not saved. They show their new levels below."
						/>
					</AlertDescription>
				</Alert>
			) : null}
			{problems ? (
				<Alert variant="destructive" data-testid="levels-problems">
					<AlertDescription>
						<Trans>
							Some levels need a look. Use numbers, and keep "order more when
							below" at or under "fill up to".
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			<div role="search" className="flex flex-col gap-3">
				<Input
					type="search"
					value={searchText}
					onChange={(event) => {
						setSearchText(event.target.value)
						setLimit(PAGE_SIZE)
					}}
					placeholder={t`Search items`}
					aria-label={t`Search items`}
					maxLength={80}
					className="h-11 md:h-8"
					data-testid="levels-search"
				/>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<ToggleGroup
						aria-label={t`Which items`}
						variant="segmented"
						value={[show]}
						onValueChange={(next) => {
							if (next[0]) {
								setShow(next[0] as Show)
								setLimit(PAGE_SIZE)
							}
						}}
					>
						<ToggleGroupItem
							value="all"
							className="h-11 md:h-7"
							data-testid="levels-show-all"
						>
							<Trans>All items</Trans>
						</ToggleGroupItem>
						<ToggleGroupItem
							value="unset"
							className="h-11 md:h-7"
							data-testid="levels-show-unset"
						>
							<Trans>No levels yet</Trans>
						</ToggleGroupItem>
					</ToggleGroup>
					{suggestionsOn ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={applyAllSuggestions}
							disabled={suggestionByItem.size === 0}
							data-testid="levels-use-all"
						>
							<Icon name="sparkles" />
							<Trans>Use all suggestions</Trans>
						</Button>
					) : (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setSuggestionsOn(true)}
							data-testid="levels-suggest"
						>
							<Icon name="sparkles" />
							<Trans>Suggest from use</Trans>
						</Button>
					)}
				</div>
			</div>

			{suggestionsOn && suggestions.loading ? (
				<p className="text-muted-foreground text-sm" role="status">
					<Trans>Looking at what you use…</Trans>
				</p>
			) : null}
			{suggestionsOn && suggestions.error && !suggestions.data ? (
				<Alert variant="destructive" data-testid="levels-suggest-error">
					<AlertDescription>
						{i18n._(inventoryErrorMessage(suggestions.error))}
					</AlertDescription>
				</Alert>
			) : null}
			{daysObserved !== null && !enoughHistory(daysObserved) ? (
				<Alert data-testid="levels-history-note">
					<AlertDescription>
						<Trans>
							Not enough history yet. Suggestions get better after about two
							weeks of use, so treat these as a first guess.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			{levels.error && !levels.data ? (
				<Alert variant="destructive" data-testid="levels-load-error">
					<AlertDescription>
						{i18n._(inventoryErrorMessage(levels.error))}
					</AlertDescription>
					<Button
						type="button"
						className="mt-2 justify-self-start"
						variant="outline"
						onClick={levels.reload}
					>
						<Trans>Try again</Trans>
					</Button>
				</Alert>
			) : !levels.data ? (
				<div role="status" className="flex flex-col gap-2">
					<span className="sr-only">
						<Trans>Loading your items</Trans>
					</span>
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			) : rows.length === 0 ? (
				<p className="text-muted-foreground text-sm" data-testid="levels-empty">
					{show === 'unset' && q === '' ? (
						<Trans>Every item has its levels.</Trans>
					) : (
						<Trans>No items match.</Trans>
					)}
				</p>
			) : (
				<ul
					className={
						levels.refreshing
							? 'flex flex-col divide-y rounded-xl border opacity-70 transition-opacity'
							: 'flex flex-col divide-y rounded-xl border'
					}
					aria-busy={levels.refreshing}
					data-testid="levels-list"
				>
					{rows.map((row) => {
						const draft = drafts[row.itemId]
						if (!draft) return null
						const suggestion = suggestionByItem.get(row.itemId)
						const found = problems?.[row.itemId] ?? []
						const name = row.name
						const unitName = quantity.unitName(draft.unit, draft.units)
						const weekly = suggestion
							? quantity.format(suggestion.weeklyUseQuantity, {
									baseUnit: row.baseUnit,
									countUnit: draft.unit,
									units: draft.units,
								})
							: null
						return (
							<li
								key={row.itemId}
								className="flex flex-col gap-2 p-3"
								data-testid={`level-row-${row.itemId}`}
							>
								<div className="flex flex-col">
									<span className="font-medium wrap-anywhere">{name}</span>
									{row.supplierName ? (
										<span className="text-muted-foreground text-xs wrap-anywhere">
											{row.supplierName}
										</span>
									) : null}
								</div>
								<div className="grid grid-cols-2 gap-3">
									<label className="flex flex-col gap-1 text-xs">
										<span className="text-muted-foreground">
											<Trans>Order more when below</Trans>
										</span>
										<span className="flex items-center gap-2">
											<Input
												value={draft.belowText}
												onChange={(event) =>
													patch(row.itemId, { belowText: event.target.value })
												}
												inputMode="decimal"
												dir="ltr"
												aria-label={t`${name}: order more when below`}
												aria-invalid={
													found.includes('below') || found.includes('order')
														? true
														: undefined
												}
												className="h-11 md:h-8"
												data-testid={`level-below-${row.itemId}`}
											/>
											<bdi dir="ltr" className="text-muted-foreground">
												{unitName}
											</bdi>
										</span>
									</label>
									<label className="flex flex-col gap-1 text-xs">
										<span className="text-muted-foreground">
											<Trans>Fill up to</Trans>
										</span>
										<span className="flex items-center gap-2">
											<Input
												value={draft.fillText}
												onChange={(event) =>
													patch(row.itemId, { fillText: event.target.value })
												}
												inputMode="decimal"
												dir="ltr"
												aria-label={t`${name}: fill up to`}
												aria-invalid={
													found.includes('fill') || found.includes('order')
														? true
														: undefined
												}
												className="h-11 md:h-8"
												data-testid={`level-fill-${row.itemId}`}
											/>
											<bdi dir="ltr" className="text-muted-foreground">
												{unitName}
											</bdi>
										</span>
									</label>
								</div>
								{found.length > 0 ? (
									<p className="text-destructive text-xs" role="alert">
										{found.includes('order') ? (
											<Trans>
												"Order more when below" cannot be more than "fill up
												to".
											</Trans>
										) : (
											<Trans>Enter a number, or leave it empty.</Trans>
										)}
									</p>
								) : null}
								{weekly ? (
									<div
										className="flex flex-wrap items-center gap-2 text-xs"
										data-testid={`level-suggestion-${row.itemId}`}
									>
										<span className="text-muted-foreground">
											<Trans>
												You use about <bdi dir="ltr">{weekly}</bdi> a week.
											</Trans>
										</span>
										<Button
											type="button"
											variant="outline"
											size="xs"
											onClick={() => applySuggestionTo(row.itemId)}
											data-testid={`level-use-${row.itemId}`}
										>
											<Trans>Use suggestion</Trans>
										</Button>
									</div>
								) : null}
							</li>
						)
					})}
				</ul>
			)}

			{levels.data && rows.length < total ? (
				<div className="flex items-center justify-between gap-3 text-sm">
					<span className="text-muted-foreground">
						<Trans>
							Showing {shown} of {total}
						</Trans>
					</span>
					{limit < MAX_LIMIT ? (
						<Button
							type="button"
							variant="outline"
							onClick={() =>
								setLimit((current) => Math.min(current + PAGE_SIZE, MAX_LIMIT))
							}
							data-testid="levels-show-more"
						>
							<Trans>Show more</Trans>
						</Button>
					) : (
						<span className="text-muted-foreground">
							<Trans>Search to narrow the list.</Trans>
						</span>
					)}
				</div>
			) : null}
		</SheetForm>
	)
}
