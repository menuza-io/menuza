import { plural } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	bulkCreateItemsResultSchema,
	INVENTORY_PERMISSIONS,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Label } from '@repo/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { type FormEvent, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { type z } from 'zod'
import { BulkReviewRows } from '#app/components/inventory/bulk-review-rows.tsx'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { useStockContext } from '#app/components/inventory/stock-context.ts'
import { SelectField, TextAreaField } from '#app/components/staff/controls.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import {
	BULK_MAX_ROWS,
	type BulkDraft,
	parseBulkText,
	reviewBulkDrafts,
	toBulkItems,
} from '#app/utils/inventory/bulk-import.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import {
	RESTAURANT_TYPE_LABELS,
	RESTAURANT_TYPES,
	type RestaurantType,
	starterBulkItems,
	starterItemsFor,
} from '#app/utils/inventory/starter-lists.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'
import { type Route } from './+types/stock.add-many.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug, {
		anyOf: [INVENTORY_PERMISSIONS.UPDATE_INVENTORY],
	})
	return null
}

type BulkResult = z.infer<typeof bulkCreateItemsResultSchema>
type Source = 'starter' | 'paste'
type Step = 'input' | 'review' | 'done'

export default function InventoryAddManyRoute() {
	const { t, i18n } = useLingui()
	const ctx = useStockContext()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const { system } = useQuantityFormat()
	const checkId = useId()

	const [source, setSource] = useState<Source>('starter')
	const [step, setStep] = useState<Step>('input')
	const [restaurantType, setRestaurantType] =
		useState<RestaurantType>('shawarma_grill')
	const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set())
	const [text, setText] = useState('')
	const [inputError, setInputError] = useState<string | null>(null)
	const [drafts, setDrafts] = useState<BulkDraft[]>([])
	const [truncated, setTruncated] = useState(false)
	const [pending, setPending] = useState(false)
	const [submitError, setSubmitError] = useState<string | null>(null)
	const [result, setResult] = useState<BulkResult | null>(null)
	const clientIdRef = useRef(newClientId('b'))

	const starterItems = useMemo(
		() => starterItemsFor(restaurantType),
		[restaurantType],
	)
	const chosenStarter = starterItems.filter((item) => !unchecked.has(item.key))
	const reviewed = useMemo(
		() => reviewBulkDrafts(drafts, { currency: ctx.currency }),
		[drafts, ctx.currency],
	)
	const ready = reviewed.filter((row) => row.problems.length === 0)
	const readyCount = ready.length
	const needFix = reviewed.length - readyCount

	async function post(items: ReturnType<typeof toBulkItems>) {
		if (pending || items.length === 0) return
		setPending(true)
		setSubmitError(null)
		try {
			const parsed = bulkCreateItemsResultSchema.parse(
				await request('/items/bulk', {
					method: 'POST',
					body: JSON.stringify({
						clientId: clientIdRef.current,
						locationId: ctx.activeLocationId,
						items,
					}),
				}),
			)
			clientIdRef.current = newClientId('b')
			setResult(parsed)
			setStep('done')
			notifyChanged()
			ctx.reload()
			const added = parsed.created.length
			toast.success(
				plural(added, { one: '# item added.', other: '# items added.' }),
			)
		} catch (caught) {
			setSubmitError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setPending(false)
		}
	}

	function review(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const parsed = parseBulkText(text, i18n)
		if (parsed.drafts.length === 0) {
			setInputError(t`Paste at least one item to continue.`)
			return
		}
		setInputError(null)
		setTruncated(parsed.truncated)
		setDrafts(parsed.drafts)
		setStep('review')
	}

	if (step === 'done' && result) {
		const added = result.created.length
		const skipped = result.skipped.length
		return (
			<SheetForm
				title={t`Items added`}
				onSubmit={(event) => {
					event.preventDefault()
					ctx.close()
				}}
				footer={
					<Button type="submit" data-testid="add-many-done">
						<Trans>Done</Trans>
					</Button>
				}
			>
				<p role="status" className="text-sm" data-testid="add-many-summary">
					<Trans>
						{added} added, {skipped} skipped because they are already in your
						list.
					</Trans>
				</p>
				{result.areasCreated > 0 ? (
					<p className="text-muted-foreground text-sm">
						<Plural
							value={result.areasCreated}
							one="# storage area was created for them."
							other="# storage areas were created for them."
						/>
					</p>
				) : null}
			</SheetForm>
		)
	}

	if (step === 'review') {
		return (
			<SheetForm
				title={t`Review before adding`}
				description={t`Nothing is added until you confirm. Fix a row here or remove it.`}
				onSubmit={(event) => {
					event.preventDefault()
					void post(toBulkItems(ready, { currency: ctx.currency }))
				}}
				footer={
					<>
						<Button
							type="button"
							variant="outline"
							disabled={pending}
							onClick={() => setStep('input')}
						>
							<Trans>Back</Trans>
						</Button>
						<Button
							type="submit"
							disabled={pending || readyCount === 0}
							data-testid="add-many-confirm"
						>
							{pending ? (
								<Trans>Adding…</Trans>
							) : (
								<Plural
									value={readyCount}
									one="Add # item"
									other="Add # items"
								/>
							)}
						</Button>
					</>
				}
			>
				<p role="status" className="text-muted-foreground text-sm">
					<Trans>
						{readyCount} ready, {needFix} need a fix. Rows with a problem are
						skipped.
					</Trans>
				</p>
				{truncated ? (
					<p className="text-sm">
						<Trans>
							Only the first {BULK_MAX_ROWS} rows were read. Add the rest in a
							second batch.
						</Trans>
					</p>
				) : null}
				<BulkReviewRows
					rows={reviewed}
					onChange={(id, patch) =>
						setDrafts((current) =>
							current.map((draft) =>
								draft.id === id ? { ...draft, ...patch } : draft,
							),
						)
					}
					onRemove={(id) =>
						setDrafts((current) => current.filter((draft) => draft.id !== id))
					}
				/>
				{submitError ? (
					<Alert variant="destructive" data-testid="add-many-error">
						<AlertDescription>{submitError}</AlertDescription>
					</Alert>
				) : null}
			</SheetForm>
		)
	}

	return (
		<SheetForm
			title={t`Add many items`}
			description={t`Start from a ready-made list, or paste a list from a spreadsheet.`}
			onSubmit={(event) => {
				if (source === 'paste') review(event)
				else {
					event.preventDefault()
					void post(starterBulkItems(chosenStarter, { i18n, system }))
				}
			}}
			footer={
				<>
					<Button type="button" variant="outline" onClick={ctx.close}>
						<Trans>Cancel</Trans>
					</Button>
					{source === 'paste' ? (
						<Button type="submit" data-testid="add-many-review">
							<Trans>Review list</Trans>
						</Button>
					) : (
						<Button
							type="submit"
							disabled={pending || chosenStarter.length === 0}
							data-testid="add-many-starter-submit"
						>
							{pending ? (
								<Trans>Adding…</Trans>
							) : (
								<Plural
									value={chosenStarter.length}
									one="Add # item"
									other="Add # items"
								/>
							)}
						</Button>
					)}
				</>
			}
		>
			<ToggleGroup
				aria-label={t`Where the items come from`}
				variant="segmented"
				value={[source]}
				onValueChange={(next) => {
					if (next[0]) setSource(next[0] as Source)
				}}
			>
				<ToggleGroupItem
					value="starter"
					className="h-11 md:h-7"
					data-testid="add-many-source-starter"
				>
					<Trans>Starter list</Trans>
				</ToggleGroupItem>
				<ToggleGroupItem
					value="paste"
					className="h-11 md:h-7"
					data-testid="add-many-source-paste"
				>
					<Trans>Paste from a spreadsheet</Trans>
				</ToggleGroupItem>
			</ToggleGroup>

			{source === 'starter' ? (
				<>
					<SelectField
						label={<Trans>Type of restaurant</Trans>}
						id={`${checkId}-type`}
						testId="add-many-type"
						options={RESTAURANT_TYPES.map((value) => ({
							value,
							label: i18n._(RESTAURANT_TYPE_LABELS[value]),
						}))}
						value={restaurantType}
						onValueChange={(next) => {
							setRestaurantType(next as RestaurantType)
							setUnchecked(new Set())
						}}
					/>
					<fieldset className="flex flex-col gap-2">
						<legend className="mb-1 text-sm font-medium">
							<Trans>Items to add</Trans>
						</legend>
						<p className="text-muted-foreground text-xs">
							<Trans>
								Names are saved in your language. Items already in your list are
								skipped.
							</Trans>
						</p>
						<ul className="flex flex-col" data-testid="add-many-starter-list">
							{starterItems.map((item) => {
								const name = i18n._(item.name)
								return (
									<li
										key={item.key}
										className="flex min-h-11 items-center gap-3 border-b py-1 last:border-b-0"
									>
										<Checkbox
											id={`${checkId}-${item.key}`}
											checked={!unchecked.has(item.key)}
											onCheckedChange={(checked) =>
												setUnchecked((current) => {
													const next = new Set(current)
													if (checked) next.delete(item.key)
													else next.add(item.key)
													return next
												})
											}
										/>
										<Label
											htmlFor={`${checkId}-${item.key}`}
											className="flex-1 cursor-pointer font-normal"
										>
											{name}
										</Label>
									</li>
								)
							})}
						</ul>
					</fieldset>
					{submitError ? (
						<Alert variant="destructive" data-testid="add-many-error">
							<AlertDescription>{submitError}</AlertDescription>
						</Alert>
					) : null}
				</>
			) : (
				<TextAreaField
					label={<Trans>Items</Trans>}
					value={text}
					onChange={(event) => setText(event.target.value)}
					rows={9}
					dir="auto"
					placeholder={
						'Chicken thighs, Meat, kg, 28\nGarlic sauce, Sauces, L, 14'
					}
					hint={t`One item per line: name, category, unit, then price per unit. A header row with Name, Category, Unit and Price also works.`}
					error={inputError}
					data-testid="add-many-text"
				/>
			)}
		</SheetForm>
	)
}
