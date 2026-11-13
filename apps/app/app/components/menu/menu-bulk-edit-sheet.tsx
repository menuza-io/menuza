import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Separator } from '@repo/ui/separator'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { Switch } from '@repo/ui/switch'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
	type BulkItemOperation,
	type BulkOptionOperation,
} from '#app/utils/menu/bulk-edit.ts'

type BulkTarget = 'item' | 'option'

type ItemActionKey =
	| 'price'
	| 'availability'
	| 'apply_sales_tax'
	| 'dietary'
	| 'popular'
	| 'upsell'
	| 'add_category'
	| 'remove_category'
	| 'add_modifier_group'
	| 'remove_modifier_group'

type OptionActionKey = 'price' | 'availability' | 'dietary'

type PreviewPlan = {
	id: string
	before: Record<string, unknown>
	after: Record<string, unknown>
	skipped?: string
	updatedAt?: string
}

type CatalogItem = { id: string; label: string }

export function MenuBulkEditSheet({
	orgSlug,
	open,
	onOpenChange,
	targetType,
	selectedIds,
	rows,
	locations = [],
	categories = [],
	modifierGroups = [],
	defaultLocale = 'en',
	currencyExponent = 2,
	onUndoSnapshot,
}: {
	orgSlug: string
	open: boolean
	onOpenChange: (open: boolean) => void
	targetType: BulkTarget
	selectedIds: string[]
	rows: Array<{ id: string; displayName: string; price: number; updatedAt: string }>
	locations?: CatalogItem[]
	categories?: CatalogItem[]
	modifierGroups?: CatalogItem[]
	defaultLocale?: string
	currencyExponent?: number
	onUndoSnapshot?: (snapshotId: string) => void
}) {
	const { _ } = useLingui()
	const [itemAction, setItemAction] = useState<ItemActionKey>('price')
	const [optionAction, setOptionAction] = useState<OptionActionKey>('price')
	const [priceKind, setPriceKind] = useState<'percent' | 'amount' | 'set'>('percent')
	const [priceValue, setPriceValue] = useState('5')
	const [priceEnding, setPriceEnding] = useState<'none' | '00' | '50' | '95' | '99'>(
		'none',
	)
	const [endingDirection, setEndingDirection] = useState<
		'up' | 'down' | 'nearest'
	>('up')
	const [availabilityStatus, setAvailabilityStatus] = useState<
		'available' | 'unavailable' | 'hidden'
	>('unavailable')
	const [dietaryFlag, setDietaryFlag] = useState<
		'vegetarian' | 'gluten_free' | 'alcohol'
	>('vegetarian')
	const [dietaryEnabled, setDietaryEnabled] = useState(true)
	const [toggleEnabled, setToggleEnabled] = useState(true)
	const [categoryId, setCategoryId] = useState('')
	const [modifierGroupId, setModifierGroupId] = useState('')
	const [locationId, setLocationId] = useState<string>('')
	const [preview, setPreview] = useState<PreviewPlan[] | null>(null)
	const [includedIds, setIncludedIds] = useState<Set<string>>(new Set())
	const [loading, setLoading] = useState(false)

	useEffect(() => {
		if (!open) {
			setPreview(null)
			setIncludedIds(new Set())
		}
	}, [open])

	const actionKey = targetType === 'item' ? itemAction : optionAction

	const buildOperation = (): BulkItemOperation | BulkOptionOperation => {
		if (targetType === 'option') {
			if (optionAction === 'price') {
				const change =
					priceKind === 'percent'
						? { kind: 'percent' as const, value: Number.parseFloat(priceValue) || 0 }
						: priceKind === 'amount'
							? { kind: 'amount' as const, value: Number.parseFloat(priceValue) || 0 }
							: { kind: 'set' as const, value: Number.parseFloat(priceValue) || 0 }
				const ending =
					currencyExponent === 2 && priceEnding !== 'none'
						? { to: priceEnding, direction: endingDirection }
						: undefined
				return { type: 'price', change, ...(ending ? { ending } : {}) }
			}
			if (optionAction === 'availability') {
				return { type: 'availability', status: availabilityStatus }
			}
			return {
				type: 'dietary',
				flag: dietaryFlag,
				enabled: dietaryEnabled,
			}
		}

		switch (itemAction) {
			case 'price': {
				const change =
					priceKind === 'percent'
						? { kind: 'percent' as const, value: Number.parseFloat(priceValue) || 0 }
						: priceKind === 'amount'
							? { kind: 'amount' as const, value: Number.parseFloat(priceValue) || 0 }
							: { kind: 'set' as const, value: Number.parseFloat(priceValue) || 0 }
				const ending =
					currencyExponent === 2 && priceEnding !== 'none'
						? { to: priceEnding, direction: endingDirection }
						: undefined
				return { type: 'price', change, ...(ending ? { ending } : {}) }
			}
			case 'availability':
				return { type: 'availability', status: availabilityStatus }
			case 'apply_sales_tax':
				return { type: 'apply_sales_tax', enabled: toggleEnabled }
			case 'dietary':
				return { type: 'dietary', flag: dietaryFlag, enabled: dietaryEnabled }
			case 'popular':
				return { type: 'popular', enabled: toggleEnabled }
			case 'upsell':
				return { type: 'upsell', enabled: toggleEnabled }
			case 'add_category':
				return { type: 'add_category', categoryId }
			case 'remove_category':
				return { type: 'remove_category', categoryId }
			case 'add_modifier_group':
				return { type: 'add_modifier_group', modifierGroupId }
			case 'remove_modifier_group':
				return { type: 'remove_modifier_group', modifierGroupId }
		}
	}

	const scopeLocation =
		locationId && (actionKey === 'price' || actionKey === 'availability')

	const loadPreview = async () => {
		setLoading(true)
		try {
			const op = buildOperation()
			const response = await fetch(`/${orgSlug}/menu/bulk`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					intent: 'preview',
					targetType,
					ids: selectedIds,
					operation: op,
					locationId: scopeLocation ? locationId : null,
				}),
			})
			if (!response.ok) {
				const data = (await response.json().catch(() => ({}))) as { error?: string }
				toast.error(data.error ?? _('Could not build preview'))
				return
			}
			const data = (await response.json()) as { plans: PreviewPlan[] }
			const plans = data.plans.map((plan) => ({
				...plan,
				updatedAt: rows.find((row) => row.id === plan.id)?.updatedAt,
			}))
			setPreview(plans)
			setIncludedIds(new Set(plans.filter((p) => !p.skipped).map((p) => p.id)))
		} finally {
			setLoading(false)
		}
	}

	const applyIds = useMemo(() => {
		if (!preview) return []
		return preview
			.filter((row) => includedIds.has(row.id) && !row.skipped)
			.map((row) => row.id)
	}, [includedIds, preview])

	const apply = async () => {
		if (!preview || applyIds.length === 0) return
		setLoading(true)
		try {
			const updatedAt: Record<string, string> = {}
			for (const row of preview) {
				if (applyIds.includes(row.id) && row.updatedAt) {
					updatedAt[row.id] = row.updatedAt
				}
			}
			const response = await fetch(`/${orgSlug}/menu/bulk`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					intent: 'apply',
					targetType,
					ids: applyIds,
					operation: buildOperation(),
					locationId: scopeLocation ? locationId : null,
					updatedAt,
				}),
			})
			const data = (await response.json()) as {
				ok?: boolean
				snapshotId?: string
				error?: string
				staleIds?: string[]
			}
			if (!response.ok) {
				if (data.error === 'stale_rows' && data.staleIds?.length) {
					toast.error(
						_(t`Some rows changed. Refresh the preview and try again.`),
					)
				} else {
					toast.error(data.error ?? _('Could not apply changes'))
				}
				return
			}
			toast.success(_(t`Bulk changes applied`), {
				description: scopeLocation
					? _(t`Location override updated`)
					: undefined,
				action: data.snapshotId
					? {
							label: _(t`Undo`),
							onClick: () => onUndoSnapshot?.(data.snapshotId!),
						}
					: undefined,
			})
			onOpenChange(false)
		} finally {
			setLoading(false)
		}
	}

	const formatCell = (plan: PreviewPlan, which: 'before' | 'after') => {
		const row = plan[which]
		if (actionKey === 'price') {
			const price = row.price as number | undefined
			return price != null ? price.toFixed(currencyExponent === 0 ? 0 : 2) : '—'
		}
		if (actionKey === 'availability') {
			return String(row.availabilityStatus ?? '—')
		}
		if (actionKey === 'apply_sales_tax') {
			return row.applySalesTax ? _(t`Tax on`) : _(t`Tax off`)
		}
		if (actionKey === 'dietary') {
			if (dietaryFlag === 'vegetarian')
				return row.isVegetarian ? _(t`Vegetarian`) : '—'
			if (dietaryFlag === 'gluten_free')
				return row.isGlutenFree ? _(t`Gluten-free`) : '—'
			return row.isAlcohol ? _(t`Alcohol`) : '—'
		}
		if (actionKey === 'popular') {
			return row.isPopular ? _(t`Popular`) : '—'
		}
		if (actionKey === 'upsell') {
			return row.isUpsell ? _(t`Upsell`) : '—'
		}
		if (
			actionKey === 'add_category' ||
			actionKey === 'remove_category'
		) {
			const ids = row.categoryIds as string[] | undefined
			return ids?.length ? String(ids.length) : '0'
		}
		if (
			actionKey === 'add_modifier_group' ||
			actionKey === 'remove_modifier_group'
		) {
			const ids = row.modifierGroupIds as string[] | undefined
			return ids?.length ? String(ids.length) : '0'
		}
		return '—'
	}

	const toggleIncluded = (id: string, checked: boolean) => {
		setIncludedIds((prev) => {
			const next = new Set(prev)
			if (checked) next.add(id)
			else next.delete(id)
			return next
		})
	}

	const needsCategory =
		targetType === 'item' &&
		(itemAction === 'add_category' || itemAction === 'remove_category')
	const needsModifier =
		targetType === 'item' &&
		(itemAction === 'add_modifier_group' ||
			itemAction === 'remove_modifier_group')
	const canPreview =
		(!needsCategory || categoryId) && (!needsModifier || modifierGroupId)

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="flex h-full w-full flex-col gap-0 p-0 sm:max-w-2xl">
				<div className="px-6 pt-6">
					<SheetHeader className="text-start">
						<SheetTitle>
							<Trans>Bulk edit</Trans>
						</SheetTitle>
						<SheetDescription>
							<Trans>
								Preview changes on the server, untick rows you do not want, then
								apply in one batch.
							</Trans>
						</SheetDescription>
					</SheetHeader>
				</div>

				<div className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant="secondary">
							{selectedIds.length}{' '}
							<Trans>selected</Trans>
						</Badge>
						{scopeLocation ? (
							<Badge variant="outline">
								<Trans>Location override</Trans>
							</Badge>
						) : null}
					</div>

					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2 sm:col-span-2">
							<Label htmlFor="bulk-action">
								<Trans>Action</Trans>
							</Label>
							<Select
								value={actionKey}
								onValueChange={(value) => {
									if (targetType === 'item') {
										setItemAction(value as ItemActionKey)
									} else {
										setOptionAction(value as OptionActionKey)
									}
									setPreview(null)
								}}
							>
								<SelectTrigger id="bulk-action">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="price">
										<Trans>Change price</Trans>
									</SelectItem>
									<SelectItem value="availability">
										<Trans>Set availability</Trans>
									</SelectItem>
									{targetType === 'item' ? (
										<>
											<SelectSeparator />
											<SelectItem value="apply_sales_tax">
												<Trans>Sales tax</Trans>
											</SelectItem>
											<SelectItem value="dietary">
												<Trans>Dietary flag</Trans>
											</SelectItem>
											<SelectItem value="popular">
												<Trans>Popular</Trans>
											</SelectItem>
											<SelectItem value="upsell">
												<Trans>Upsell</Trans>
											</SelectItem>
											<SelectItem value="add_category">
												<Trans>Add to category</Trans>
											</SelectItem>
											<SelectItem value="remove_category">
												<Trans>Remove from category</Trans>
											</SelectItem>
											<SelectItem value="add_modifier_group">
												<Trans>Add modifier group</Trans>
											</SelectItem>
											<SelectItem value="remove_modifier_group">
												<Trans>Remove modifier group</Trans>
											</SelectItem>
										</>
									) : (
										<SelectItem value="dietary">
											<Trans>Dietary flag</Trans>
										</SelectItem>
									)}
								</SelectContent>
							</Select>
						</div>

						{actionKey === 'price' ? (
							<>
								<div className="space-y-2">
									<Label>
										<Trans>Price change</Trans>
									</Label>
									<Select
										value={priceKind}
										onValueChange={(value) =>
											setPriceKind(value as typeof priceKind)
										}
									>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="percent">
												<Trans>Percent</Trans>
											</SelectItem>
											<SelectItem value="amount">
												<Trans>Amount</Trans>
											</SelectItem>
											<SelectItem value="set">
												<Trans>Set to</Trans>
											</SelectItem>
										</SelectContent>
									</Select>
								</div>
								<div className="space-y-2">
									<Label htmlFor="bulk-price-value">
										{priceKind === 'percent' ? (
											<Trans>Value (%)</Trans>
										) : (
											<Trans>Value</Trans>
										)}
									</Label>
									<Input
										id="bulk-price-value"
										type="number"
										inputMode="decimal"
										value={priceValue}
										onChange={(event) => setPriceValue(event.target.value)}
									/>
								</div>
								{currencyExponent === 2 ? (
									<>
										<div className="space-y-2">
											<Label>
												<Trans>Price ending</Trans>
											</Label>
											<Select
												value={priceEnding}
												onValueChange={(value) =>
													setPriceEnding(value as typeof priceEnding)
												}
											>
												<SelectTrigger>
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="none">
														<Trans>None</Trans>
													</SelectItem>
													<SelectItem value="99">.99</SelectItem>
													<SelectItem value="95">.95</SelectItem>
													<SelectItem value="50">.50</SelectItem>
													<SelectItem value="00">.00</SelectItem>
												</SelectContent>
											</Select>
										</div>
										{priceEnding !== 'none' ? (
											<div className="space-y-2">
												<Label>
													<Trans>Round</Trans>
												</Label>
												<Select
													value={endingDirection}
													onValueChange={(value) =>
														setEndingDirection(value as typeof endingDirection)
													}
												>
													<SelectTrigger>
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="up">
															<Trans>Up</Trans>
														</SelectItem>
														<SelectItem value="down">
															<Trans>Down</Trans>
														</SelectItem>
														<SelectItem value="nearest">
															<Trans>Nearest</Trans>
														</SelectItem>
													</SelectContent>
												</Select>
											</div>
										) : null}
									</>
								) : null}
							</>
						) : null}

						{actionKey === 'availability' ? (
							<div className="space-y-2 sm:col-span-2">
								<Label>
									<Trans>Status</Trans>
								</Label>
								<Select
									value={availabilityStatus}
									onValueChange={(value) =>
										setAvailabilityStatus(
											value as typeof availabilityStatus,
										)
									}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="available">
											<Trans>Available</Trans>
										</SelectItem>
										<SelectItem value="unavailable">
											<Trans>Unavailable</Trans>
										</SelectItem>
										<SelectItem value="hidden">
											<Trans>Hidden</Trans>
										</SelectItem>
									</SelectContent>
								</Select>
							</div>
						) : null}

						{actionKey === 'dietary' ? (
							<>
								<div className="space-y-2">
									<Label>
										<Trans>Flag</Trans>
									</Label>
									<Select
										value={dietaryFlag}
										onValueChange={(value) =>
											setDietaryFlag(value as typeof dietaryFlag)
										}
									>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="vegetarian">
												<Trans>Vegetarian</Trans>
											</SelectItem>
											<SelectItem value="gluten_free">
												<Trans>Gluten-free</Trans>
											</SelectItem>
											<SelectItem value="alcohol">
												<Trans>Alcohol</Trans>
											</SelectItem>
										</SelectContent>
									</Select>
								</div>
								<div className="flex items-center justify-between gap-3 rounded-lg border p-3">
									<Label htmlFor="dietary-enabled" className="cursor-pointer">
										<Trans>Enabled</Trans>
									</Label>
									<Switch
										id="dietary-enabled"
										checked={dietaryEnabled}
										onCheckedChange={setDietaryEnabled}
									/>
								</div>
							</>
						) : null}

						{actionKey === 'apply_sales_tax' ||
						actionKey === 'popular' ||
						actionKey === 'upsell' ? (
							<div className="flex items-center justify-between gap-3 rounded-lg border p-3 sm:col-span-2">
								<Label htmlFor="toggle-enabled" className="cursor-pointer">
									<Trans>Enabled</Trans>
								</Label>
								<Switch
									id="toggle-enabled"
									checked={toggleEnabled}
									onCheckedChange={setToggleEnabled}
								/>
							</div>
						) : null}

						{needsCategory ? (
							<div className="space-y-2 sm:col-span-2">
								<Label>
									<Trans>Category</Trans>
								</Label>
								<Select value={categoryId} onValueChange={setCategoryId}>
									<SelectTrigger>
										<SelectValue placeholder={_(t`Choose a category`)} />
									</SelectTrigger>
									<SelectContent>
										{categories.map((cat) => (
											<SelectItem key={cat.id} value={cat.id}>
												{cat.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						) : null}

						{needsModifier ? (
							<div className="space-y-2 sm:col-span-2">
								<Label>
									<Trans>Modifier group</Trans>
								</Label>
								<Select
									value={modifierGroupId}
									onValueChange={setModifierGroupId}
								>
									<SelectTrigger>
										<SelectValue placeholder={_(t`Choose a group`)} />
									</SelectTrigger>
									<SelectContent>
										{modifierGroups.map((group) => (
											<SelectItem key={group.id} value={group.id}>
												{group.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						) : null}

						{(actionKey === 'price' || actionKey === 'availability') &&
						locations.length > 0 ? (
							<div className="space-y-2 sm:col-span-2">
								<Label>
									<Trans>Scope</Trans>
								</Label>
								<Select
									value={locationId || '__all__'}
									onValueChange={(value) =>
										setLocationId(value === '__all__' ? '' : value)
									}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="__all__">
											<Trans>All locations (base menu)</Trans>
										</SelectItem>
										{locations.map((loc) => (
											<SelectItem key={loc.id} value={loc.id}>
												{loc.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Location scope writes an override, not the base dish price.
									</Trans>
								</p>
							</div>
						) : null}
					</div>

					<div className="flex flex-wrap gap-2">
						<Button
							variant="outline"
							onClick={loadPreview}
							disabled={loading || !canPreview}
						>
							{loading ? (
								<Icon name="loader" className="size-4 animate-spin" />
							) : null}
							<Trans>Preview</Trans>
						</Button>
					</div>

					{preview ? (
						<>
							<Separator />
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead className="w-10">
											<span className="sr-only">
												<Trans>Include</Trans>
											</span>
										</TableHead>
										<TableHead>
											<Trans>Name</Trans>
										</TableHead>
										<TableHead className="text-right">
											<Trans>Before</Trans>
										</TableHead>
										<TableHead className="text-right">
											<Trans>After</Trans>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{preview.map((row) => {
										const title =
											getLocalizedMenuValue(
												String(row.before.displayName ?? ''),
												defaultLocale,
												defaultLocale,
											) ||
											rows.find((r) => r.id === row.id)?.displayName ||
											row.id
										return (
											<TableRow
												key={row.id}
												className={
													row.skipped ? 'bg-muted/40 opacity-70' : undefined
												}
											>
												<TableCell>
													<Checkbox
														disabled={Boolean(row.skipped)}
														checked={includedIds.has(row.id)}
														onCheckedChange={(value) =>
															toggleIncluded(row.id, value === true)
														}
														aria-label={_(t`Include {name}`, { name: title })}
													/>
												</TableCell>
												<TableCell className="max-w-[10rem] truncate">
													{title}
												</TableCell>
												<TableCell className="text-right tabular-nums">
													{formatCell(row, 'before')}
												</TableCell>
												<TableCell className="text-right tabular-nums">
													{row.skipped ? (
														<span className="text-muted-foreground text-xs">
															{row.skipped}
														</span>
													) : (
														formatCell(row, 'after')
													)}
												</TableCell>
											</TableRow>
										)
									})}
								</TableBody>
							</Table>
						</>
					) : null}
				</div>

				<SheetFooter className="border-border border-t px-6 py-4">
					<Button
						className="w-full sm:w-auto"
						onClick={apply}
						disabled={!preview || applyIds.length === 0 || loading}
					>
						{plural(applyIds.length, {
							one: 'Apply # change',
							other: 'Apply # changes',
						})}
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	)
}
