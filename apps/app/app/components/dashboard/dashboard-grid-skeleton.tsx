import { Skeleton } from '@repo/ui/skeleton'
import {
	DASHBOARD_COLS,
	DASHBOARD_MARGIN,
	DASHBOARD_ROW_HEIGHT,
	type GridItem,
} from '#app/utils/dashboards/config.ts'
import { layoutBottom, type GridLayouts } from '#app/utils/dashboards/layout.ts'

const [GAP_X, GAP_Y] = DASHBOARD_MARGIN

function rowsHeight(rows: number) {
	return rows * DASHBOARD_ROW_HEIGHT + Math.max(0, rows - 1) * GAP_Y
}

/**
 * The grid's own geometry, expressed in percentages so it can be rendered on
 * the server before the container width is known.
 */
function itemBox(item: GridItem, cols: number) {
	return {
		left: `calc(${(item.x / cols) * 100}% + ${(item.x * GAP_X) / cols}px)`,
		width: `calc(${(item.w / cols) * 100}% - ${((cols - item.w) * GAP_X) / cols}px)`,
		top: item.y * (DASHBOARD_ROW_HEIGHT + GAP_Y),
		height: rowsHeight(item.h),
	}
}

/** Placeholder shown until the grid has measured its container. */
export function DashboardGridSkeleton({ layouts }: { layouts: GridLayouts }) {
	return (
		<div data-slot="dashboard-grid-skeleton" aria-hidden="true">
			<div
				className="relative hidden md:block"
				style={{ height: rowsHeight(layoutBottom(layouts.lg)) }}
			>
				{layouts.lg.map((item) => {
					const box = itemBox(item, DASHBOARD_COLS.lg)
					return (
						<Skeleton
							key={item.i}
							className="absolute rounded-xl"
							style={{
								left: box.left,
								width: box.width,
								top: box.top,
								height: box.height,
							}}
						/>
					)
				})}
			</div>
			<div className="flex flex-col gap-4 md:hidden">
				{layouts.sm.map((item) => (
					<Skeleton
						key={item.i}
						className="rounded-xl"
						style={{ height: rowsHeight(item.h) }}
					/>
				))}
			</div>
		</div>
	)
}
