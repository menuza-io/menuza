import {
	DndContext,
	DragOverlay,
	KeyboardSensor,
	MouseSensor,
	pointerWithin,
	rectIntersection,
	TouchSensor,
	useSensor,
	useSensors,
	type DragEndEvent,
	type DragStartEvent,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
	arrayMove,
	SortableContext,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import {
	db,
	eq,
	asc,
	OrganizationMenu,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import {
	type LoaderFunctionArgs,
	Link,
	useFetcher,
	useLoaderData,
	useSearchParams,
} from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	MenuSortableCategory,
	type OverviewCategoryData,
} from '#app/components/menu/menu-sortable-category.tsx'
import { makeMenuItemDragId } from '#app/components/menu/menu-sortable-item.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

function collisionStrategy(args: any) {
	const activeType = args.active.data.current?.type
	const activeCategoryId = args.active.data.current?.categoryId
	const droppableContainers = args.droppableContainers.filter(
		(container: {
			data: { current?: { type?: string; categoryId?: string } }
		}) =>
			container.data.current?.type === activeType &&
			(activeType !== 'item' ||
				container.data.current?.categoryId === activeCategoryId),
	)
	const collisionArgs = { ...args, droppableContainers }
	const pointerCollisions = pointerWithin(collisionArgs)
	return pointerCollisions.length > 0
		? pointerCollisions
		: rectIntersection(collisionArgs)
}

type ActiveDrag =
	| { type: 'category'; name: string; itemCount: number }
	| { type: 'item'; name: string; price: number }
	| null

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteDefaultLocale: true,
	})

	const defaultLocale = organization.siteDefaultLocale ?? 'en'

	// Load all menus for this organization
	const menus = await db.query.OrganizationMenu.findMany({
		where: eq(OrganizationMenu.organizationId, organization.id),
		orderBy: [asc(OrganizationMenu.position), asc(OrganizationMenu.createdAt)],
	})

	const url = new URL(request.url)
	const requestedMenuId = url.searchParams.get('menuId')
	const activeMenu =
		menus.find((m) => m.id === requestedMenuId) ?? menus[0] ?? null

	let categories: OverviewCategoryData[] = []

	if (activeMenu) {
		// Load category assignments for this menu
		const catAssignments =
			await db.query.OrganizationMenuCategoryAssignment.findMany({
				where: eq(OrganizationMenuCategoryAssignment.menuId, activeMenu.id),
				orderBy: [asc(OrganizationMenuCategoryAssignment.position)],
				with: {
					category: {
						with: {
							itemAssignments: {
								orderBy: [asc(OrganizationMenuItemCategoryAssignment.position)],
								with: {
									item: true,
								},
							},
						},
					},
				},
			})

		categories = catAssignments.map((ca) => ({
			id: ca.category.id,
			displayName: ca.category.displayName,
			description: ca.category.description,
			internalName: ca.category.internalName,
			position: ca.position,
			items: ca.category.itemAssignments.map((ia) => ({
				id: ia.item.id,
				displayName: ia.item.displayName,
				description: ia.item.description,
				price: ia.item.price,
				imageUrl: ia.item.imageUrl,
				isAlcohol: ia.item.isAlcohol,
				isGlutenFree: ia.item.isGlutenFree,
				isVegetarian: ia.item.isVegetarian,
				availabilityStatus: ia.item.availabilityStatus,
				unavailableUntil: ia.item.unavailableUntil
					? ia.item.unavailableUntil.toISOString()
					: null,
				position: ia.position,
			})),
		}))
	}

	return {
		organization,
		defaultLocale,
		menus: menus.map((m) => ({
			id: m.id,
			displayName: m.displayName,
			internalName: m.internalName,
			menuType: m.menuType,
			availabilityStatus: m.availabilityStatus,
			unavailableUntil: m.unavailableUntil
				? m.unavailableUntil.toISOString()
				: null,
		})),
		activeMenuId: activeMenu?.id ?? null,
		categories,
	}
}

export default function MenuOverviewRoute() {
	const { organization, defaultLocale, menus, activeMenuId, categories } =
		useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const [searchParams, setSearchParams] = useSearchParams()
	const reorderFetcher = useFetcher()

	const [categoryList, setCategoryList] =
		useState<OverviewCategoryData[]>(categories)
	const [activeDrag, setActiveDrag] = useState<ActiveDrag>(null)

	useEffect(() => {
		setCategoryList(categories)
	}, [categories])

	const dndId = useId()
	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 250, tolerance: 5 },
		}),
		useSensor(KeyboardSensor),
	)

	const currentMenuId = searchParams.get('menuId') || activeMenuId

	const handleSelectMenu = (menuId: string) => {
		const newParams = new URLSearchParams(searchParams)
		newParams.set('menuId', menuId)
		setSearchParams(newParams)
	}

	const handleDragStart = ({ active }: DragStartEvent) => {
		const category = categoryList.find((entry) => entry.id === active.id)
		if (category) {
			setActiveDrag({
				type: 'category',
				name:
					getLocalizedMenuValue(
						category.displayName,
						defaultLocale,
						defaultLocale,
					) ||
					category.internalName ||
					'Untitled Category',
				itemCount: category.items.length,
			})
			return
		}

		for (const entry of categoryList) {
			const item = entry.items.find(
				(candidate) =>
					makeMenuItemDragId(entry.id, candidate.id) === String(active.id),
			)
			if (item) {
				setActiveDrag({
					type: 'item',
					name:
						getLocalizedMenuValue(
							item.displayName,
							defaultLocale,
							defaultLocale,
						) || 'Untitled Item',
					price: item.price,
				})
				return
			}
		}
	}

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event
		setActiveDrag(null)
		if (!over || active.id === over.id || !currentMenuId) return

		// Check if dragging category
		const activeCatIndex = categoryList.findIndex((c) => c.id === active.id)
		const overCatIndex = categoryList.findIndex((c) => c.id === over.id)

		if (activeCatIndex !== -1 && overCatIndex !== -1) {
			const newCategoryList = arrayMove(
				categoryList,
				activeCatIndex,
				overCatIndex,
			)
			setCategoryList(newCategoryList)

			// Persist in background
			void reorderFetcher.submit(
				JSON.stringify({
					entity: 'category',
					menuId: currentMenuId,
					orderedIds: newCategoryList.map((c) => c.id),
				}),
				{
					method: 'POST',
					action: `/${organization.slug}/menu/reorder`,
					encType: 'application/json',
				},
			)
			return
		}

		// Check if dragging item inside a category
		for (let cIdx = 0; cIdx < categoryList.length; cIdx++) {
			const cat = categoryList[cIdx]
			if (!cat) continue
			const activeItemIdx = cat.items.findIndex(
				(item) => makeMenuItemDragId(cat.id, item.id) === String(active.id),
			)
			const overItemIdx = cat.items.findIndex(
				(item) => makeMenuItemDragId(cat.id, item.id) === String(over.id),
			)

			if (activeItemIdx !== -1 && overItemIdx !== -1) {
				const newItems = arrayMove(cat.items, activeItemIdx, overItemIdx)
				const newCategoryList = [...categoryList]
				newCategoryList[cIdx] = { ...cat, items: newItems }
				setCategoryList(newCategoryList)

				// Persist in background
				void reorderFetcher.submit(
					JSON.stringify({
						entity: 'item',
						categoryId: cat.id,
						orderedIds: newItems.map((i) => i.id),
					}),
					{
						method: 'POST',
						action: `/${organization.slug}/menu/reorder`,
						encType: 'application/json',
					},
				)
				return
			}
		}
	}

	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>Menu Overview</Trans>}
				description={
					<Trans>
						Drag and reorder your menu categories and items exactly as they
						appear to guests.
					</Trans>
				}
				headingLevel="h2"
				size="section"
				actions={
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button>
									<Icon name="plus" className="size-4" />
									<Trans>Add</Trans>
									<Icon name="chevron-down" className="size-3.5 opacity-70" />
								</Button>
							}
						/>
						<DropdownMenuContent align="end" className="w-40">
							<DropdownMenuItem
								render={
									<Link to={`/${organization.slug}/menu/menus/new`}>
										<Trans>New Menu</Trans>
									</Link>
								}
							/>
							<DropdownMenuItem
								render={
									<Link to={`/${organization.slug}/menu/categories/new`}>
										<Trans>New Category</Trans>
									</Link>
								}
							/>
							<DropdownMenuItem
								render={
									<Link to={`/${organization.slug}/menu/items/new`}>
										<Trans>New Item</Trans>
									</Link>
								}
							/>
							<DropdownMenuItem
								render={
									<Link to={`/${organization.slug}/menu/modifiers/new`}>
										<Trans>New Modifier Group</Trans>
									</Link>
								}
							/>
							<DropdownMenuItem
								render={
									<Link to={`/${organization.slug}/menu/options/new`}>
										<Trans>New Modifier Option</Trans>
									</Link>
								}
							/>
						</DropdownMenuContent>
					</DropdownMenu>
				}
			/>

			{menus.length === 0 ? (
				<EmptyState
					title={_(t`No menus created yet`)}
					description={_(
						t`Create your first menu (e.g. Main Menu, Lunch, Catering) to start organizing categories and items.`,
					)}
					icons={['file-text', 'blocks', 'sparkles']}
				/>
			) : (
				<div className="space-y-6">
					{/* Menu selector tabs & controls */}
					<div className="border-border/50 flex flex-wrap items-center justify-between gap-3 border-b pb-3">
						<div className="bg-muted/40 border-border/50 inline-flex max-w-full [scrollbar-width:none] items-center gap-1.5 overflow-x-auto rounded-xl border p-1">
							{menus.map((menu) => {
								const isSelected = menu.id === currentMenuId
								const menuName =
									getLocalizedMenuValue(
										menu.displayName,
										defaultLocale,
										defaultLocale,
									) ||
									menu.internalName ||
									'Untitled Menu'

								return (
									<button
										key={menu.id}
										type="button"
										onClick={() => handleSelectMenu(menu.id)}
										className={cn(
											'group flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-150 select-none',
											isSelected
												? 'bg-background text-foreground border-border/60 border shadow-xs'
												: 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
										)}
									>
										<span>{menuName}</span>
									</button>
								)
							})}
						</div>

						{currentMenuId && (
							<Button
								variant="ghost"
								size="xs"
								render={
									<Link
										to={`/${organization.slug}/menu/menus/${currentMenuId}`}
									/>
								}
								className="text-muted-foreground hover:text-foreground h-8 gap-1.5 text-xs font-medium"
							>
								<Icon name="settings" className="size-3.5" />
								<Trans>Menu Settings</Trans>
							</Button>
						)}
					</div>

					{/* Categories and Items drag-and-drop container */}
					{categoryList.length === 0 ? (
						<div className="rounded-xl border border-dashed p-12 text-center">
							<div className="bg-muted mx-auto flex size-12 items-center justify-center rounded-full">
								<Icon name="blocks" className="text-muted-foreground size-6" />
							</div>
							<h3 className="text-foreground mt-4 text-base">
								<Trans>No categories assigned to this menu</Trans>
							</h3>
							<p className="text-muted-foreground mt-1 text-sm">
								<Trans>
									Assign categories to this menu or create a new category to
									begin.
								</Trans>
							</p>
							<div className="mt-6 flex justify-center gap-3">
								<Button
									variant="outline"
									render={
										<Link
											to={`/${organization.slug}/menu/menus/${currentMenuId}`}
										/>
									}
								>
									<Trans>Manage Menu Categories</Trans>
								</Button>
								<Button
									render={
										<Link to={`/${organization.slug}/menu/categories/new`} />
									}
								>
									<Trans>Create Category</Trans>
								</Button>
							</div>
						</div>
					) : (
						<DndContext
							id={dndId}
							sensors={sensors}
							collisionDetection={collisionStrategy}
							modifiers={[restrictToVerticalAxis]}
							onDragStart={handleDragStart}
							onDragEnd={handleDragEnd}
							onDragCancel={() => setActiveDrag(null)}
						>
							<Frame className="w-full">
								<Table variant="card">
									<TableHeader>
										<TableRow>
											<TableHead>
												<Trans>Menu item</Trans>
											</TableHead>
											<TableHead className="hidden text-right sm:table-cell">
												<Trans>Price / count</Trans>
											</TableHead>
											<TableHead className="hidden md:table-cell">
												<Trans>Details</Trans>
											</TableHead>
											<TableHead className="hidden sm:table-cell">
												<Trans>Status</Trans>
											</TableHead>
											<TableHead className="w-12">
												<span className="sr-only">
													<Trans>Actions</Trans>
												</span>
											</TableHead>
										</TableRow>
									</TableHeader>
									<SortableContext
										id={dndId}
										items={categoryList.map((category) => category.id)}
										strategy={verticalListSortingStrategy}
									>
										{categoryList.map((category, index) => (
											<MenuSortableCategory
												key={category.id}
												category={category}
												showSeparator={index < categoryList.length - 1}
												orgSlug={organization.slug}
												locale={defaultLocale}
												defaultLocale={defaultLocale}
											/>
										))}
									</SortableContext>
									<TableFooter>
										<TableRow>
											<TableCell colSpan={4}>
												{categoryList.length === 1 ? (
													<Trans>1 category</Trans>
												) : (
													// eslint-disable-next-line lingui/no-expression-in-message
													<Trans>{categoryList.length} categories</Trans>
												)}
											</TableCell>
											<TableCell />
										</TableRow>
									</TableFooter>
								</Table>
							</Frame>
							{typeof window !== 'undefined' &&
								createPortal(
									<DragOverlay
										dropAnimation={{
											duration: 180,
											easing: 'cubic-bezier(0.2, 0, 0, 1)',
										}}
									>
										{activeDrag ? (
											<div className="bg-background w-[min(36rem,calc(100vw-2rem))] rounded-md border px-4 py-3 shadow-lg">
												<div className="flex items-center gap-3">
													<Icon
														name="grip-vertical"
														className="text-muted-foreground size-4"
													/>
													<div className="min-w-0">
														<p className="truncate text-sm font-medium">
															{activeDrag.name}
														</p>
														<p className="text-muted-foreground text-xs">
															{activeDrag.type === 'category'
																? `${activeDrag.itemCount} ${activeDrag.itemCount === 1 ? 'item' : 'items'}`
																: `$${activeDrag.price.toFixed(2)}`}
														</p>
													</div>
												</div>
											</div>
										) : null}
									</DragOverlay>,
									document.body,
								)}
						</DndContext>
					)}
				</div>
			)}
		</div>
	)
}
