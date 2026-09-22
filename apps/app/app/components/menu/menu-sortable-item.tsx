import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { TableCell, TableRow } from '@repo/ui/table'
import { memo } from 'react'
import { Link } from 'react-router'
import { MenuStatusBadge } from './menu-status-badge.tsx'

export interface OverviewItemData {
	id: string
	displayName: string
	description: string | null
	price: number
	imageUrl: string | null
	isAlcohol: boolean
	isGlutenFree: boolean
	isVegetarian: boolean
	availabilityStatus: string
	unavailableUntil?: Date | string | null
	position: number
}

export function makeMenuItemDragId(categoryId: string, itemId: string) {
	return `${categoryId}::${itemId}`
}

interface MenuSortableItemProps {
	item: OverviewItemData
	categoryId: string
	orgSlug: string
	locale?: string
	defaultLocale?: string
}

export const MenuSortableItem = memo(function MenuSortableItem({
	item,
	categoryId,
	orgSlug,
	locale = 'en',
	defaultLocale = 'en',
}: MenuSortableItemProps) {
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: makeMenuItemDragId(categoryId, item.id),
		data: { type: 'item', categoryId, item },
	})

	const itemName =
		getLocalizedMenuValue(item.displayName, locale, defaultLocale) ||
		'Untitled Item'

	return (
		<TableRow
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
			}}
			className={cn(isDragging && 'opacity-25')}
		>
			<TableCell className="py-3">
				<div className="flex min-w-0 items-center gap-3 pl-7 sm:pl-9">
					<button
						type="button"
						ref={setActivatorNodeRef}
						{...attributes}
						{...listeners}
						className="text-muted-foreground/50 hover:bg-muted hover:text-foreground focus-visible:ring-ring -ml-1 shrink-0 cursor-grab rounded p-1 transition-colors focus-visible:ring-2 focus-visible:outline-none active:cursor-grabbing"
						aria-label="Drag to reorder item"
					>
						<Icon name="grip-vertical" className="size-4" />
					</button>
					<div className="bg-muted flex size-9 shrink-0 items-center justify-center overflow-hidden rounded border">
						{item.imageUrl ? (
							<img
								src={item.imageUrl}
								alt=""
								className="size-full object-cover"
							/>
						) : (
							<Icon name="image" className="text-muted-foreground/50 size-4" />
						)}
					</div>
					<div className="min-w-0">
						<Link
							to={`/${orgSlug}/menu/items/${item.id}`}
							className="text-foreground hover:text-primary block truncate text-sm font-medium"
						>
							{itemName}
						</Link>
						{item.description ? (
							<p className="text-muted-foreground mt-0.5 max-w-xl truncate text-xs">
								{getLocalizedMenuValue(item.description, locale, defaultLocale)}
							</p>
						) : null}
					</div>
				</div>
			</TableCell>
			<TableCell className="hidden text-right font-medium tabular-nums sm:table-cell">
				${item.price.toFixed(2)}
			</TableCell>
			<TableCell className="hidden md:table-cell">
				<div className="flex flex-wrap gap-1">
					{item.isGlutenFree ? (
						<span className="text-muted-foreground text-xs">GF</span>
					) : null}
					{item.isVegetarian ? (
						<span className="text-muted-foreground text-xs">V</span>
					) : null}
					{item.isAlcohol ? (
						<span className="text-muted-foreground text-xs">21+</span>
					) : null}
					{!item.isGlutenFree && !item.isVegetarian && !item.isAlcohol ? (
						<span className="text-muted-foreground text-xs">—</span>
					) : null}
				</div>
			</TableCell>
			<TableCell className="hidden sm:table-cell">
				<MenuStatusBadge
					status={item.availabilityStatus}
					unavailableUntil={item.unavailableUntil}
				/>
			</TableCell>
			<TableCell className="text-right">
				<Button
					variant="ghost"
					size="icon-sm"
					render={<Link to={`/${orgSlug}/menu/items/${item.id}`} />}
					aria-label="Edit item"
				>
					<Icon name="pencil" className="size-4" />
				</Button>
			</TableCell>
		</TableRow>
	)
})
