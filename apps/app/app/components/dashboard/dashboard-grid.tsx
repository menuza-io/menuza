import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import './dashboard-grid.css'
import { useLingui } from '@lingui/react'
import { useDirection } from '@repo/ui'
import { useCallback, useEffect, useMemo, type ReactNode } from 'react'
import {
	Responsive,
	useContainerWidth,
	type EventCallback,
} from 'react-grid-layout'
import { useMobileViewport } from '#app/hooks/use-mobile-viewport.ts'
import {
	BLOCK_DEFINITIONS,
	DASHBOARD_BREAKPOINTS,
	DASHBOARD_COLS,
	DASHBOARD_MARGIN,
	DASHBOARD_ROW_HEIGHT,
	type DashboardBlock,
	type DashboardLayouts,
	type GridItem,
	type PersistedBreakpoint,
} from '#app/utils/dashboards/config.ts'
import {
	breakpointForWidth,
	mirrorGridLayouts,
	sameLayout,
	sortBlocksByLayout,
	toGridItems,
	unmirrorLayout,
	visibleGridLayouts,
	withBlockSizeLimits,
} from '#app/utils/dashboards/layout.ts'
import {
	DashboardBlockFrame,
	DRAG_HANDLE_SELECTOR,
} from './dashboard-block-frame.tsx'
import { DashboardGridSkeleton } from './dashboard-grid-skeleton.tsx'

// The grid remounts on every breakpoint change (see its `key`), so width and
// viewport changes only apply once they have settled for this long.
const RESIZE_SETTLE_MS = 100
const NO_CONTAINER_PADDING = [0, 0] as const
const NO_HIDDEN_BLOCKS: readonly string[] = []
const DRAG_DISABLED = { enabled: false } as const
const RESIZE_DISABLED = { enabled: false } as const
const DRAG_ENABLED = {
	enabled: true,
	handle: DRAG_HANDLE_SELECTOR,
	// The handle is a button itself, so only other buttons are excluded.
	cancel:
		'a, input, textarea, select, [data-no-drag], button:not([data-dashboard-drag-handle])',
} as const
const RESIZE_LTR = { enabled: true, handles: ['se'] } as const
// The grid always runs left to right, so in right-to-left locales the
// bottom-end corner of a block is its bottom-left one.
const RESIZE_RTL = { enabled: true, handles: ['sw'] } as const

type DashboardGridProps<Block extends DashboardBlock> = {
	blocks: readonly Block[]
	/** Saved layouts in left-to-right coordinates. */
	layouts: DashboardLayouts
	/** Blocks that stay in the config but are not shown; their space is reused. */
	hiddenBlockIds?: readonly string[]
	renderBlock: (block: Block) => ReactNode
	/** Names a block, such as a report block after its report; defaults to its type. */
	blockTitle?: (block: Block) => string | null
	/** Lets blocks be moved, resized and removed. Mobile mode ignores it. */
	editing?: boolean
	/**
	 * Called when a drag or resize ends and moved something, with the layout
	 * of the visible blocks in left-to-right coordinates.
	 */
	onLayoutCommit?: (breakpoint: PersistedBreakpoint, layout: GridItem[]) => void
	onRemoveBlock?: (blockId: string) => void
	/**
	 * Whether the layout can be edited at the current size: not before the
	 * container is measured and not in mobile mode (one stacked column).
	 */
	onEditableChange?: (editable: boolean) => void
}

export function DashboardGrid<Block extends DashboardBlock>({
	blocks,
	layouts,
	hiddenBlockIds = NO_HIDDEN_BLOCKS,
	renderBlock,
	blockTitle,
	editing = false,
	onLayoutCommit,
	onRemoveBlock,
	onEditableChange,
}: DashboardGridProps<Block>) {
	const { _ } = useLingui()
	const direction = useDirection()
	// False until mounted, like the measured width, so server and client agree.
	const isMobile = useMobileViewport(RESIZE_SETTLE_MS)
	const { width, containerRef, mounted } = useContainerWidth({
		measureBeforeMount: true,
		debounceTimeout: RESIZE_SETTLE_MS,
	})

	const breakpoint = isMobile ? 'sm' : breakpointForWidth(width)
	const editable = mounted && breakpoint !== 'sm'
	const isEditing = editing && editable

	useEffect(() => {
		onEditableChange?.(editable)
	}, [editable, onEditableChange])

	const hiddenKey = hiddenBlockIds.join(' ')
	const gridLayouts = useMemo(
		() => visibleGridLayouts(layouts, hiddenKey ? hiddenKey.split(' ') : []),
		[layouts, hiddenKey],
	)
	// The grid only positions items left to right, so right-to-left locales get
	// a mirrored copy while the reading order still follows the saved layout.
	const displayLayouts = useMemo(() => {
		const positioned =
			direction === 'rtl' ? mirrorGridLayouts(gridLayouts) : gridLayouts
		return {
			lg: withBlockSizeLimits(positioned.lg, blocks, 'lg'),
			md: withBlockSizeLimits(positioned.md, blocks, 'md'),
			sm: positioned.sm,
		}
	}, [blocks, direction, gridLayouts])
	const activeLayout = gridLayouts[breakpoint]

	// Only the end of a drag or resize counts as a change; the grid also
	// reports layouts on mount and on breakpoint changes, which are not edits.
	const commitLayout = useCallback<EventCallback>(
		(layout) => {
			if (!onLayoutCommit || breakpoint === 'sm') return
			const items = toGridItems(layout)
			if (sameLayout(items, displayLayouts[breakpoint])) return
			onLayoutCommit(
				breakpoint,
				direction === 'rtl'
					? unmirrorLayout(items, DASHBOARD_COLS[breakpoint])
					: items,
			)
		},
		[breakpoint, direction, displayLayouts, onLayoutCommit],
	)

	const children = useMemo(() => {
		const shown = new Set(activeLayout.map((item) => item.i))
		const visibleBlocks = blocks.filter((block) => shown.has(block.id))
		// DOM order drives tab and screen reader order, so it follows the
		// visual order rather than the order blocks were added in.
		return sortBlocksByLayout(visibleBlocks, activeLayout).map((block) => (
			<div
				key={block.id}
				data-block-id={block.id}
				data-block-type={block.type}
				dir={direction}
			>
				<DashboardBlockFrame
					title={blockTitle?.(block) ?? _(BLOCK_DEFINITIONS[block.type].title)}
					editing={isEditing}
					onRemove={onRemoveBlock ? () => onRemoveBlock(block.id) : undefined}
				>
					{renderBlock(block)}
				</DashboardBlockFrame>
			</div>
		))
	}, [
		_,
		activeLayout,
		blockTitle,
		blocks,
		direction,
		isEditing,
		onRemoveBlock,
		renderBlock,
	])

	return (
		<div
			ref={containerRef}
			data-slot="dashboard-grid"
			data-editing={isEditing ? '' : undefined}
			dir="ltr"
			className="w-full"
		>
			{mounted ? (
				<Responsive
					// react-grid-layout keeps the layout in two components that sync
					// through effects; quick back-and-forth breakpoint changes can make
					// them swap layouts forever. A fresh grid per breakpoint avoids it.
					// Its items also keep their first resize handles, so a direction
					// change needs a fresh grid too.
					key={`${breakpoint}-${direction}`}
					width={width}
					breakpoint={breakpoint}
					breakpoints={DASHBOARD_BREAKPOINTS}
					cols={DASHBOARD_COLS}
					layouts={displayLayouts}
					rowHeight={DASHBOARD_ROW_HEIGHT}
					margin={DASHBOARD_MARGIN}
					containerPadding={NO_CONTAINER_PADDING}
					dragConfig={isEditing ? DRAG_ENABLED : DRAG_DISABLED}
					resizeConfig={
						isEditing
							? direction === 'rtl'
								? RESIZE_RTL
								: RESIZE_LTR
							: RESIZE_DISABLED
					}
					onDragStop={commitLayout}
					onResizeStop={commitLayout}
				>
					{children}
				</Responsive>
			) : (
				<DashboardGridSkeleton layouts={displayLayouts} />
			)}
		</div>
	)
}
