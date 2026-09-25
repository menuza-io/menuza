import {
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Trans } from '@lingui/macro'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { TableBody, TableCell, TableRow, TableSpacer } from '@repo/ui/table'
import { memo, useState } from 'react'
import { Link } from 'react-router'
import {
	MenuSortableItem,
	makeMenuItemDragId,
	type OverviewItemData,
} from './menu-sortable-item.tsx'

export interface OverviewCategoryData {
	id: string
	displayName: string
	description: string | null
	internalName: string | null
	position: number
	items: OverviewItemData[]
}

interface MenuSortableCategoryProps {
	category: OverviewCategoryData
	orgSlug: string
	locale?: string
	defaultLocale?: string
	showSeparator?: boolean
}

export const MenuSortableCategory = memo(function MenuSortableCategory({
	category,
	orgSlug,
	locale = 'en',
	defaultLocale = 'en',
	showSeparator = false,
}: MenuSortableCategoryProps) {
	const [expanded, setExpanded] = useState(true)
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: category.id, data: { type: 'category', category } })

	const categoryName =
		getLocalizedMenuValue(category.displayName, locale, defaultLocale) ||
		category.internalName ||
		'Untitled Category'

	return (
		<>
			<TableBody
				ref={setNodeRef}
				style={{
					transform: CSS.Transform.toString(transform),
					transition,
				}}
			>
				<TableRow
					className={cn('hover:[&>td]:bg-muted/70', isDragging && 'opacity-25')}
				>
					<TableCell className="py-3.5">
						<div className="flex min-w-0 items-center gap-2">
							<button
								type="button"
								ref={setActivatorNodeRef}
								{...attributes}
								{...listeners}
								className="text-muted-foreground/60 hover:bg-background hover:text-foreground focus-visible:ring-ring -ml-1 shrink-0 cursor-grab rounded p-1 transition-colors focus-visible:ring-2 focus-visible:outline-none active:cursor-grabbing"
								aria-label="Drag to reorder category"
							>
								<Icon name="grip-vertical" className="size-4" />
							</button>
							<button
								type="button"
								onClick={() => setExpanded((value) => !value)}
								className="text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-ring shrink-0 rounded p-1 transition-colors focus-visible:ring-2 focus-visible:outline-none"
								aria-label={expanded ? 'Collapse category' : 'Expand category'}
							>
								<Icon
									name="chevron-down"
									className={cn(
										'size-4 transition-transform duration-150',
										!expanded && '-rotate-90',
									)}
								/>
							</button>
							<div className="min-w-0">
								<Link
									to={`/${orgSlug}/menu/categories/${category.id}`}
									className="text-foreground hover:text-primary block truncate text-sm"
								>
									{categoryName}
								</Link>
								{category.description ? (
									<p className="text-muted-foreground mt-0.5 truncate text-xs">
										{getLocalizedMenuValue(
											category.description,
											locale,
											defaultLocale,
										)}
									</p>
								) : null}
							</div>
						</div>
					</TableCell>
					<TableCell className="text-muted-foreground hidden text-right text-sm sm:table-cell">
						{category.items.length}{' '}
						{category.items.length === 1 ? 'item' : 'items'}
					</TableCell>
					<TableCell className="hidden md:table-cell">
						<span className="text-muted-foreground text-xs">
							<Trans>Category</Trans>
						</span>
					</TableCell>
					<TableCell className="hidden sm:table-cell" />
					<TableCell className="text-right">
						<Button
							variant="ghost"
							size="icon-sm"
							render={
								<Link to={`/${orgSlug}/menu/categories/${category.id}`} />
							}
							aria-label="Edit category"
						>
							<Icon name="pencil" className="size-4" />
						</Button>
					</TableCell>
				</TableRow>
				{expanded ? (
					category.items.length ? (
						<SortableContext
							items={category.items.map((item) =>
								makeMenuItemDragId(category.id, item.id),
							)}
							strategy={verticalListSortingStrategy}
						>
							{category.items.map((item) => (
								<MenuSortableItem
									key={item.id}
									item={item}
									categoryId={category.id}
									orgSlug={orgSlug}
									locale={locale}
									defaultLocale={defaultLocale}
								/>
							))}
						</SortableContext>
					) : (
						<TableRow>
							<TableCell
								colSpan={5}
								className="text-muted-foreground py-5 text-center text-sm"
							>
								<Trans>No items in this category yet.</Trans>{' '}
								<Link
									to={`/${orgSlug}/menu/items/new?categoryId=${category.id}`}
									className="text-primary font-medium hover:underline"
								>
									<Trans>Add item</Trans>
								</Link>
							</TableCell>
						</TableRow>
					)
				) : null}
			</TableBody>
			{showSeparator ? <TableSpacer colSpan={5} /> : null}
		</>
	)
})
