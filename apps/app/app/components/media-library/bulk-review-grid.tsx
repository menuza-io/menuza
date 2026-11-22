import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type BulkPhotoFlag,
	type MatchConfidence,
} from '@repo/common/dish-photo-match'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Switch } from '@repo/ui/switch'
import { useId, useMemo } from 'react'
import {
	usedItemIds,
	type ReviewState,
} from '#app/utils/media/bulk/review-state.ts'
import {
	type BulkDishChoice,
	type BulkProposedPhoto,
} from '#app/utils/media/bulk/types.ts'

const NO_DISH = '__none__'

type BadgeVariant = 'success' | 'warning' | 'secondary' | 'destructive'

export function confidenceLabel(confidence: MatchConfidence | null) {
	switch (confidence) {
		case 'high':
			return msg`High match`
		case 'medium':
			return msg`Medium match`
		case 'low':
			return msg`Low match`
		default:
			return msg`No match`
	}
}

const CONFIDENCE_VARIANT: Record<MatchConfidence, BadgeVariant> = {
	high: 'success',
	medium: 'warning',
	low: 'secondary',
}

function flagLabel(flag: BulkPhotoFlag) {
	switch (flag) {
		case 'not_food':
			return msg`Does not look like food`
		case 'too_small':
			return msg`Too small`
		case 'duplicate':
			return msg`Duplicate`
		case 'weak':
			return msg`Low quality`
	}
}

/**
 * The review step of Add dish photos in bulk (#316): each photo next to its
 * proposed dish with a confidence mark. The operator confirms, swaps or skips
 * every pair; nothing here writes anything.
 */
export function BulkReviewGrid({
	photos,
	dishes,
	state,
	onSwap,
	onConfirm,
	onReplace,
	onSkip,
}: {
	photos: BulkProposedPhoto[]
	dishes: BulkDishChoice[]
	state: ReviewState
	onSwap: (assetId: string, itemId: string | null) => void
	onConfirm: (assetId: string, confirmed: boolean) => void
	onReplace: (assetId: string, replace: boolean) => void
	onSkip: (assetId: string) => void
}) {
	const dishById = useMemo(
		() => new Map(dishes.map((dish) => [dish.id, dish])),
		[dishes],
	)
	return (
		<ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
			{photos.map((photo) => (
				<BulkReviewCard
					key={photo.assetId}
					photo={photo}
					dishes={dishes}
					dish={
						state[photo.assetId]?.itemId
							? dishById.get(state[photo.assetId]!.itemId!)
							: undefined
					}
					row={state[photo.assetId]}
					takenItemIds={usedItemIds(state, photo.assetId)}
					onSwap={onSwap}
					onConfirm={onConfirm}
					onReplace={onReplace}
					onSkip={onSkip}
				/>
			))}
		</ul>
	)
}

function BulkReviewCard({
	photo,
	dishes,
	dish,
	row,
	takenItemIds,
	onSwap,
	onConfirm,
	onReplace,
	onSkip,
}: {
	photo: BulkProposedPhoto
	dishes: BulkDishChoice[]
	dish: BulkDishChoice | undefined
	row: ReviewState[string] | undefined
	takenItemIds: ReadonlySet<string>
	onSwap: (assetId: string, itemId: string | null) => void
	onConfirm: (assetId: string, confirmed: boolean) => void
	onReplace: (assetId: string, replace: boolean) => void
	onSkip: (assetId: string) => void
}) {
	const { _ } = useLingui()
	const id = useId()
	const fileName = photo.fileName ?? _(msg`Untitled photo`)
	const selected = row?.itemId ?? NO_DISH
	const confirmed = Boolean(row?.confirmed)
	const items = useMemo(
		() => [
			{ value: NO_DISH, label: _(msg`No dish (stays in the library)`) },
			...dishes.map((candidate) => ({
				value: candidate.id,
				label: candidate.name || _(msg`Untitled dish`),
			})),
		],
		[dishes, _],
	)
	// The mark follows the pair the operator sees: a dish they swapped in is
	// theirs, not the model's, so it has no confidence.
	const proposedItemId = photo.proposal.itemId
	const confidence =
		dish && dish.id === proposedItemId ? photo.proposal.confidence : null
	const dishName = dish?.name ?? ''
	const flags = [
		...new Set<BulkPhotoFlag>([
			...photo.proposal.flags,
			...(photo.duplicateOfExisting ? (['duplicate'] as const) : []),
		]),
	]

	return (
		<li
			className={cn(
				'bg-card flex flex-col overflow-hidden rounded-xl border',
				confirmed && 'border-primary ring-primary/20 ring-2',
			)}
			data-confirmed={confirmed || undefined}
		>
			<div className="bg-muted relative aspect-4/3">
				<img
					src={photo.url}
					alt={fileName}
					loading="lazy"
					decoding="async"
					className="size-full object-cover"
				/>
				{confidence || flags.length > 0 ? (
					<div className="absolute start-2 top-2 flex flex-wrap gap-1">
						{confidence ? (
							<Badge variant={CONFIDENCE_VARIANT[confidence]}>
								{_(confidenceLabel(confidence))}
							</Badge>
						) : null}
					</div>
				) : null}
			</div>

			<div className="flex flex-1 flex-col gap-3 p-3">
				<div className="space-y-1.5">
					<p className="text-sm font-medium wrap-anywhere">{fileName}</p>
					{flags.length > 0 ? (
						<div className="flex flex-wrap gap-1">
							{flags.map((flag) => (
								<Badge
									key={flag}
									variant={flag === 'duplicate' ? 'secondary' : 'warning'}
								>
									<Icon name="alert-triangle" />
									{_(flagLabel(flag))}
								</Badge>
							))}
						</div>
					) : null}
				</div>

				<div className="space-y-1.5">
					<Label
						htmlFor={`${id}-dish`}
						className="text-muted-foreground text-xs"
					>
						<Trans>Add to this dish</Trans>
					</Label>
					<Select
						value={selected}
						items={items}
						onValueChange={(value) =>
							onSwap(
								photo.assetId,
								value === NO_DISH ? null : (value as string),
							)
						}
					>
						<SelectTrigger id={`${id}-dish`} className="w-full">
							<SelectValue placeholder={_(msg`Choose a dish`)} />
						</SelectTrigger>
						<SelectContent>
							{items.map((item) => (
								<SelectItem
									key={item.value}
									value={item.value}
									disabled={takenItemIds.has(item.value)}
								>
									<span className="wrap-anywhere whitespace-normal">
										{item.label}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				{dish?.hasPhoto ? (
					<div className="bg-muted/50 flex items-start gap-3 rounded-lg p-2">
						{dish.imageUrl ? (
							<img
								src={dish.imageUrl}
								alt={_(msg`Current photo of ${dishName}`)}
								loading="lazy"
								decoding="async"
								className="size-12 shrink-0 rounded-md object-cover"
							/>
						) : null}
						<div className="min-w-0 flex-1 space-y-1.5">
							<p className="text-sm">
								<Trans>This dish already has a photo.</Trans>
							</p>
							<div className="flex items-center gap-2">
								<Switch
									id={`${id}-replace`}
									checked={Boolean(row?.replace)}
									onCheckedChange={(checked) =>
										onReplace(photo.assetId, Boolean(checked))
									}
								/>
								<Label htmlFor={`${id}-replace`}>
									<Trans>Replace?</Trans>
								</Label>
							</div>
							<p className="text-muted-foreground text-xs">
								<Trans>The old photo stays in your media library.</Trans>
							</p>
						</div>
					</div>
				) : null}

				<div className="mt-auto flex items-center justify-between gap-2 pt-1">
					<Label
						htmlFor={`${id}-confirm`}
						className={cn(
							'gap-2',
							(!row?.itemId || (dish?.hasPhoto && !row?.replace)) &&
								'text-muted-foreground',
						)}
					>
						<Checkbox
							id={`${id}-confirm`}
							checked={confirmed}
							disabled={
								!row?.itemId || Boolean(dish?.hasPhoto && !row?.replace)
							}
							onCheckedChange={(checked) =>
								onConfirm(photo.assetId, Boolean(checked))
							}
						/>
						<span>
							<Trans>Confirm</Trans>
							<span className="sr-only"> {fileName}</span>
						</span>
					</Label>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={!row?.itemId}
						onClick={() => onSkip(photo.assetId)}
					>
						<Trans>Skip</Trans>
						<span className="sr-only"> {fileName}</span>
					</Button>
				</div>
			</div>
		</li>
	)
}
