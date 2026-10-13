import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import './dashboard-grid.css'
import { useLingui } from '@lingui/react'
import { useDirection } from '@repo/ui'
import { useMemo, type ReactNode } from 'react'
import { Responsive, useContainerWidth } from 'react-grid-layout'
import { useMobileViewport } from '#app/hooks/use-mobile-viewport.ts'
import {
	BLOCK_DEFINITIONS,
	DASHBOARD_BREAKPOINTS,
	DASHBOARD_COLS,
	DASHBOARD_MARGIN,
	DASHBOARD_ROW_HEIGHT,
	type DashboardBlock,
	type DashboardLayouts,
} from '#app/utils/dashboards/config.ts'
import {
	breakpointForWidth,
	mirrorGridLayouts,
	sortBlocksByLayout,
	visibleGridLayouts,
} from '#app/utils/dashboards/layout.ts'
import { DashboardBlockFrame } from './dashboard-block-frame.tsx'
import { DashboardGridSkeleton } from './dashboard-grid-skeleton.tsx'

// The grid remounts on every breakpoint change (see its `key`), so width and
// viewport changes only apply once they have settled for this long.
const RESIZE_SETTLE_MS = 100
const NO_CONTAINER_PADDING = [0, 0] as const
const DRAG_DISABLED = { enabled: false } as const
const RESIZE_DISABLED = { enabled: false } as const
const NO_HIDDEN_BLOCKS: readonly string[] = []

type DashboardGridProps<Block extends DashboardBlock> = {
	blocks: readonly Block[]
	/** Saved layouts in left-to-right coordinates. */
	layouts: DashboardLayouts
	/** Blocks that stay in the config but are not shown; their space is reused. */
	hiddenBlockIds?: readonly string[]
	renderBlock: (block: Block) => ReactNode
}

export function DashboardGrid<Block extends DashboardBlock>({
	blocks,
	layouts,
	hiddenBlockIds = NO_HIDDEN_BLOCKS,
	renderBlock,
}: DashboardGridProps<Block>) {
	const { _ } = useLingui()
	const direction = useDirection()
	// False until mounted, like the measured width, so server and client agree.
	const isMobile = useMobileViewport(RESIZE_SETTLE_MS)
	const { width, containerRef, mounted } = useContainerWidth({
		measureBeforeMount: true,
		debounceTimeout: RESIZE_SETTLE_MS,
	})

	const hiddenKey = hiddenBlockIds.join(' ')
	const gridLayouts = useMemo(
		() => visibleGridLayouts(layouts, hiddenKey ? hiddenKey.split(' ') : []),
		[layouts, hiddenKey],
	)
	// The grid only positions items left to right, so right-to-left locales get
	// a mirrored copy while the reading order still follows the saved layout.
	const displayLayouts = useMemo(
		() => (direction === 'rtl' ? mirrorGridLayouts(gridLayouts) : gridLayouts),
		[direction, gridLayouts],
	)
	const breakpoint = isMobile ? 'sm' : breakpointForWidth(width)
	const activeLayout = gridLayouts[breakpoint]

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
				<DashboardBlockFrame title={_(BLOCK_DEFINITIONS[block.type].title)}>
					{renderBlock(block)}
				</DashboardBlockFrame>
			</div>
		))
	}, [_, activeLayout, blocks, direction, renderBlock])

	return (
		<div
			ref={containerRef}
			data-slot="dashboard-grid"
			dir="ltr"
			className="w-full"
		>
			{mounted ? (
				<Responsive
					// react-grid-layout keeps the layout in two components that sync
					// through effects; quick back-and-forth breakpoint changes can make
					// them swap layouts forever. A fresh grid per breakpoint avoids it.
					key={breakpoint}
					width={width}
					breakpoint={breakpoint}
					breakpoints={DASHBOARD_BREAKPOINTS}
					cols={DASHBOARD_COLS}
					layouts={displayLayouts}
					rowHeight={DASHBOARD_ROW_HEIGHT}
					margin={DASHBOARD_MARGIN}
					containerPadding={NO_CONTAINER_PADDING}
					dragConfig={DRAG_DISABLED}
					resizeConfig={RESIZE_DISABLED}
				>
					{children}
				</Responsive>
			) : (
				<DashboardGridSkeleton layouts={displayLayouts} />
			)}
		</div>
	)
}
