import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	type MergeItemPreview,
	type MergeLink,
	mergeCandidatesResultSchema,
	mergeItemPreviewSchema,
	mergeResultSchema,
	mergeSupplierPreviewSchema,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { BlockerList } from './blocker-list.tsx'

type Target = { id: string; name: string; reasons: string[] }

/** Undoes a merge (within a day) from a toast or a banner. */
export function useUndoMerge(onUndone: () => void) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	return async (mergeId: string) => {
		try {
			await request(`/merges/${encodeURIComponent(mergeId)}/undo`, {
				method: 'POST',
				body: JSON.stringify({}),
			})
			toast.success(t`Merge undone.`)
			notifyChanged()
			onUndone()
		} catch (caught) {
			toast.error(i18n._(inventorySaveErrorMessage(caught)))
		}
	}
}

function BannerText({ into, name }: { into: boolean; name: string }) {
	return (
		<span className="wrap-anywhere">
			{into ? (
				<Trans>Merged into {name}.</Trans>
			) : (
				<Trans>Merged {name} into this item.</Trans>
			)}
		</span>
	)
}

/** "Merged into X · Undo" for a duplicate, and "Merged Y into this" for the item kept. */
export function MergeBanners({
	mergedInto,
	mergedFrom,
	onUndone,
	canEdit,
}: {
	mergedInto: MergeLink | null | undefined
	mergedFrom: readonly MergeLink[] | undefined
	onUndone: () => void
	canEdit: boolean
}) {
	const undo = useUndoMerge(onUndone)
	const [now] = useState(() => Date.now())
	const live = (link: MergeLink) => !link.undone && link.undoUntil > now
	const rows = [
		...(mergedInto && !mergedInto.undone
			? [{ link: mergedInto, into: true as const }]
			: []),
		...(mergedFrom ?? [])
			.filter((link) => !link.undone)
			.map((link) => ({ link, into: false as const })),
	]
	if (rows.length === 0) return null
	return (
		<ul className="flex flex-col gap-2" data-testid="item-merge-banners">
			{rows.map(({ link, into }) => (
				<li key={link.mergeId}>
					<Alert>
						<Icon name="layers" />
						<AlertDescription>
							<div className="flex flex-wrap items-center justify-between gap-2">
								<BannerText into={into} name={link.name} />
								{canEdit && live(link) ? (
									<Button
										type="button"
										size="sm"
										variant="outline"
										onClick={() => void undo(link.mergeId)}
										data-testid={`merge-undo-${link.mergeId}`}
									>
										<Trans>Undo</Trans>
									</Button>
								) : null}
							</div>
						</AlertDescription>
					</Alert>
				</li>
			))}
		</ul>
	)
}

export function MergeItemDialog({
	itemId,
	itemName,
	open,
	onOpenChange,
	onMerged,
}: {
	itemId: string
	itemName: string
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Called with the new merge once it is done (the item is archived). */
	onMerged: () => void
}) {
	const { i18n, t } = useLingui()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const quantity = useQuantityFormat()
	const candidates = useInventoryQuery(
		open ? `/items/${encodeURIComponent(itemId)}/merge-candidates` : null,
		mergeCandidatesResultSchema,
	)
	const [filter, setFilter] = useState('')
	const [target, setTarget] = useState<Target | null>(null)
	const [preview, setPreview] = useState<MergeItemPreview | null>(null)
	const [loading, setLoading] = useState(false)
	const [working, setWorking] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const undo = useUndoMerge(onMerged)

	useEffect(() => {
		if (open) return
		setFilter('')
		setTarget(null)
		setPreview(null)
		setError(null)
	}, [open])

	useEffect(() => {
		if (!target) {
			setPreview(null)
			return
		}
		let cancelled = false
		setLoading(true)
		request(
			`/items/${encodeURIComponent(itemId)}/merge-preview?${new URLSearchParams({ intoItemId: target.id })}`,
		)
			.then((answer) => {
				if (!cancelled) {
					setPreview(mergeItemPreviewSchema.parse(answer))
					setError(null)
				}
			})
			.catch((caught: unknown) => {
				if (!cancelled) {
					setPreview(null)
					setError(i18n._(inventorySaveErrorMessage(caught)))
				}
			})
			.finally(() => {
				if (!cancelled) setLoading(false)
			})
		return () => {
			cancelled = true
		}
	}, [target, itemId, request, i18n])

	async function merge() {
		if (!preview || !preview.canApply || working) return
		setWorking(true)
		setError(null)
		try {
			const result = mergeResultSchema.parse(
				await request(`/items/${encodeURIComponent(itemId)}/merge`, {
					method: 'POST',
					body: JSON.stringify({
						intoItemId: preview.intoItemId,
						expectedVersion: preview.itemVersion,
						intoExpectedVersion: preview.intoItemVersion,
					}),
				}),
			)
			notifyChanged()
			const kept = preview.intoItemName
			toast.success(t`Merged into ${kept}.`, {
				duration: 15_000,
				action: {
					label: t`Undo`,
					onClick: () => void undo(result.mergeId),
				},
			})
			onOpenChange(false)
			onMerged()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setWorking(false)
		}
	}

	const needle = filter.trim().toLowerCase()
	const list = (candidates.data?.candidates ?? []).filter(
		(candidate) =>
			needle === '' || candidate.name.toLowerCase().includes(needle),
	)

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!working) onOpenChange(next)
			}}
		>
			<DialogContent
				className="max-h-dvh overflow-y-auto sm:max-w-lg"
				data-testid="merge-item-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Merge into another item</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Use this when <span className="wrap-anywhere">{itemName}</span> is
							the same thing as another item. Its recipes, suppliers and stock
							move to the item you keep, and this one is archived. You can undo
							it for 24 hours.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				{error ? (
					<Alert variant="destructive" data-testid="merge-error">
						<Icon name="alert-triangle" />
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}

				<Input
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
					placeholder={t`Search items`}
					aria-label={t`Search items`}
					disabled={working}
				/>
				<ul
					className="flex max-h-56 flex-col divide-y overflow-y-auto rounded-xl border"
					data-testid="merge-candidates"
				>
					{candidates.loading && !candidates.data ? (
						<li className="text-muted-foreground p-3 text-sm">
							<Trans>Loading items…</Trans>
						</li>
					) : list.length === 0 ? (
						<li className="text-muted-foreground p-3 text-sm">
							<Trans>No other item in the same unit.</Trans>
						</li>
					) : (
						list.map((candidate) => (
							<li key={candidate.id}>
								<button
									type="button"
									className="hover:bg-muted flex w-full items-center justify-between gap-3 p-3 text-start text-sm"
									aria-pressed={target?.id === candidate.id}
									disabled={working}
									onClick={() => {
										// The old preview answers for another target.
										setPreview(null)
										setError(null)
										setTarget({
											id: candidate.id,
											name: candidate.name,
											reasons: candidate.reasons,
										})
									}}
									data-testid={`merge-candidate-${candidate.id}`}
								>
									<span className="min-w-0 wrap-anywhere">
										{candidate.name}
									</span>
									<span className="flex shrink-0 items-center gap-1">
										{candidate.reasons.includes('name') ? (
											<Badge variant="secondary">
												<Trans>Similar name</Trans>
											</Badge>
										) : null}
										{candidate.reasons.includes('supplier_product') ? (
											<Badge variant="secondary">
												<Trans>Same product</Trans>
											</Badge>
										) : null}
										{target?.id === candidate.id ? <Icon name="check" /> : null}
									</span>
								</button>
							</li>
						))
					)}
				</ul>

				<div id="merge-preview-region" aria-live="polite" aria-atomic="false">
					{loading ? (
						<p className="text-muted-foreground text-sm">
							<Trans>Checking what would move…</Trans>
						</p>
					) : preview ? (
						<div className="flex flex-col gap-3" data-testid="merge-preview">
							{preview.unitMismatch ? (
								<Alert variant="destructive">
									<AlertDescription>
										<Trans>
											These two are counted in different units. Change the unit
											of one of them first, then merge.
										</Trans>
									</AlertDescription>
								</Alert>
							) : null}
							{preview.kindMismatch ? (
								<Alert variant="destructive">
									<AlertDescription>
										<Trans>
											One of these is bought and the other is made in house, so
											they cannot be merged.
										</Trans>
									</AlertDescription>
								</Alert>
							) : null}
							{preview.needsRecipeGrant ? (
								<Alert variant="destructive">
									<AlertDescription>
										<Trans>
											Recipes use this item, so merging it needs the recipe
											role.
										</Trans>
									</AlertDescription>
								</Alert>
							) : null}
							{preview.blockers.length > 0 ? (
								<BlockerList
									blockers={preview.blockers}
									title={<Trans>Finish these first</Trans>}
								/>
							) : null}
							<ul className="text-sm">
								<li>
									<Plural
										value={preview.moves.recipes}
										one="# recipe moves over"
										other="# recipes move over"
									/>
								</li>
								<li>
									<Plural
										value={preview.moves.supplierProducts}
										one="# supplier product moves over"
										other="# supplier products move over"
									/>
								</li>
								{preview.onHand.map((row) => (
									<li key={row.locationId} data-testid="merge-on-hand">
										<Trans>
											Stock becomes{' '}
											<bdi dir="ltr" className="tabular-nums">
												{quantity.format(row.after, {
													baseUnit: preview.baseUnit,
												})}
											</bdi>
										</Trans>
									</li>
								))}
							</ul>
						</div>
					) : null}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={working}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						onClick={() => void merge()}
						disabled={!preview || !preview.canApply || working || loading}
						aria-describedby={preview ? 'merge-preview-region' : undefined}
						data-testid="merge-apply"
					>
						{working ? <Trans>Merging…</Trans> : <Trans>Merge</Trans>}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

/** Merge a duplicate supplier into the one to keep (supplier sheet). */
export function MergeSupplierDialog({
	supplierId,
	supplierName,
	suppliers,
	open,
	onOpenChange,
	onMerged,
}: {
	supplierId: string
	supplierName: string
	suppliers: readonly { id: string; name: string }[]
	open: boolean
	onOpenChange: (open: boolean) => void
	onMerged: () => void
}) {
	const { i18n, t } = useLingui()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const [targetId, setTargetId] = useState<string | null>(null)
	const [preview, setPreview] = useState<ReturnType<
		typeof mergeSupplierPreviewSchema.parse
	> | null>(null)
	const [working, setWorking] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const undo = useUndoMerge(onMerged)

	useEffect(() => {
		if (!open) {
			setTargetId(null)
			setPreview(null)
			setError(null)
		}
	}, [open])
	useEffect(() => {
		if (!targetId) return
		let cancelled = false
		request(
			`/suppliers/${encodeURIComponent(supplierId)}/merge-preview?${new URLSearchParams({ intoSupplierId: targetId })}`,
		)
			.then((answer) => {
				if (!cancelled) setPreview(mergeSupplierPreviewSchema.parse(answer))
			})
			.catch((caught: unknown) => {
				if (!cancelled) setError(i18n._(inventorySaveErrorMessage(caught)))
			})
		return () => {
			cancelled = true
		}
	}, [targetId, supplierId, request, i18n])

	async function merge() {
		if (!preview || !preview.canApply || working) return
		setWorking(true)
		setError(null)
		try {
			const result = mergeResultSchema.parse(
				await request(`/suppliers/${encodeURIComponent(supplierId)}/merge`, {
					method: 'POST',
					body: JSON.stringify({
						intoSupplierId: preview.intoSupplierId,
						expectedVersion: preview.supplierVersion,
						intoExpectedVersion: preview.intoSupplierVersion,
					}),
				}),
			)
			notifyChanged()
			const kept = preview.intoSupplierName
			toast.success(t`Merged into ${kept}.`, {
				duration: 15_000,
				action: { label: t`Undo`, onClick: () => void undo(result.mergeId) },
			})
			onOpenChange(false)
			onMerged()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setWorking(false)
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!working) onOpenChange(next)
			}}
		>
			<DialogContent
				className="sm:max-w-md"
				data-testid="merge-supplier-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Merge into another supplier</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							<span className="wrap-anywhere">{supplierName}</span> becomes part
							of the supplier you keep: its products, deliveries and what you
							still owe move over. You can undo it for 24 hours.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
				<ul className="flex max-h-56 flex-col divide-y overflow-y-auto rounded-xl border">
					{suppliers
						.filter((supplier) => supplier.id !== supplierId)
						.map((supplier) => (
							<li key={supplier.id}>
								<button
									type="button"
									className="hover:bg-muted flex w-full items-center justify-between gap-3 p-3 text-start text-sm"
									aria-pressed={targetId === supplier.id}
									disabled={working}
									onClick={() => {
										setPreview(null)
										setError(null)
										setTargetId(supplier.id)
									}}
									data-testid={`merge-supplier-${supplier.id}`}
								>
									<span className="wrap-anywhere">{supplier.name}</span>
									{targetId === supplier.id ? <Icon name="check" /> : null}
								</button>
							</li>
						))}
				</ul>
				<div id="merge-supplier-region" aria-live="polite" aria-atomic="false">
					{targetId && !preview && !error ? (
						<p className="text-muted-foreground text-sm">
							<Trans>Checking what would move…</Trans>
						</p>
					) : null}
					{preview ? (
						<div
							className="flex flex-col gap-2"
							data-testid="merge-supplier-preview"
						>
							{preview.blockers.length > 0 ? (
								<BlockerList
									blockers={preview.blockers}
									title={<Trans>Receive or cancel these first</Trans>}
								/>
							) : null}
							<p className="text-sm">
								<Plural
									value={preview.moves.products}
									one="# product moves over."
									other="# products move over."
								/>{' '}
								<Plural
									value={preview.moves.deliveries}
									one="# delivery stays on record."
									other="# deliveries stay on record."
								/>
							</p>
						</div>
					) : null}
				</div>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={working}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						onClick={() => void merge()}
						disabled={!preview || !preview.canApply || working}
						aria-describedby={preview ? 'merge-supplier-region' : undefined}
						data-testid="merge-supplier-apply"
					>
						<Trans>Merge</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
