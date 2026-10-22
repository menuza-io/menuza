'use client'

import { cva, type VariantProps } from 'class-variance-authority'
import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react'

/**
 * The pill or underline that slides to the selected item of a row. Tabs get
 * it through Base UI's `Tabs.Indicator`; rows that are not tabs (route links,
 * toggle groups) render `SlidingIndicator`, so they keep their own roles and
 * still move the same way.
 *
 * Both write the item's box to `--active-tab-{left,top,width,height}` and stay
 * `hidden` until that box is measured. Items rely on this contract: while the
 * indicator is hidden (server HTML, before hydration, a row measured while it
 * was not displayed) the selected item paints its own pill or underline, so
 * the selection never flashes away. The indicator sits under the items (-z-10
 * inside the row's isolated stacking context) and settles without overshoot.
 */
export const slidingIndicatorVariants = cva(
	'ease-out-quint pointer-events-none absolute top-0 left-0 -z-10 transition-[translate,width,height] duration-300 motion-reduce:transition-none',
	{
		variants: {
			variant: {
				pill: 'bg-card shadow-raised dark:bg-muted h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) translate-y-(--active-tab-top) rounded-sm',
				line: 'bg-foreground rounded-full data-[orientation=horizontal]:top-auto data-[orientation=horizontal]:bottom-0 data-[orientation=horizontal]:h-0.5 data-[orientation=horizontal]:w-[calc(var(--active-tab-width)-1rem)] data-[orientation=horizontal]:translate-x-[calc(var(--active-tab-left)+0.5rem)] data-[orientation=vertical]:-right-1 data-[orientation=vertical]:left-auto data-[orientation=vertical]:h-(--active-tab-height) data-[orientation=vertical]:w-0.5 data-[orientation=vertical]:translate-y-(--active-tab-top)',
			},
		},
		defaultVariants: {
			variant: 'pill',
		},
	},
)

type Box = { left: number; top: number; width: number; height: number }

/**
 * Render as the last child of a `relative isolate` row. It finds the selected
 * item with `selector` and follows it as the selection or the layout changes.
 */
export function SlidingIndicator({
	selector,
	variant,
	orientation = 'horizontal',
}: {
	/** Matches the selected item, for example `[aria-current="page"]`. */
	selector: string
	orientation?: 'horizontal' | 'vertical'
} & VariantProps<typeof slidingIndicatorVariants>) {
	const ref = useRef<HTMLSpanElement>(null)
	const [box, setBox] = useState<Box | null>(null)

	useLayoutEffect(() => {
		const row = ref.current?.parentElement
		if (!row) return
		const measure = () => {
			const item = row.querySelector<HTMLElement>(selector)
			let next: Box | null = null
			if (item && item.offsetWidth > 0 && item.offsetHeight > 0) {
				const itemRect = item.getBoundingClientRect()
				const rowRect = row.getBoundingClientRect()
				// Undo ancestor transforms, such as a dialog that scales in.
				const scaleX = row.offsetWidth > 0 ? rowRect.width / row.offsetWidth : 1
				const scaleY =
					row.offsetHeight > 0 ? rowRect.height / row.offsetHeight : 1
				next = {
					left:
						(itemRect.left - rowRect.left) / scaleX +
						row.scrollLeft -
						row.clientLeft,
					top:
						(itemRect.top - rowRect.top) / scaleY +
						row.scrollTop -
						row.clientTop,
					width: item.offsetWidth,
					height: item.offsetHeight,
				}
			}
			setBox((previous) =>
				previous &&
				next &&
				previous.left === next.left &&
				previous.top === next.top &&
				previous.width === next.width &&
				previous.height === next.height
					? previous
					: next,
			)
		}
		// Missing in some test environments; the selection then only moves on
		// attribute changes.
		const resize =
			typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
		const observeItems = () => {
			resize?.observe(row)
			for (const child of row.children) resize?.observe(child)
		}
		// The selection arrives as an attribute change, whether the row is
		// controlled or not; added or removed items also move the selection.
		const mutation = new MutationObserver(() => {
			observeItems()
			measure()
		})
		mutation.observe(row, {
			subtree: true,
			childList: true,
			attributeFilter: ['aria-current', 'aria-pressed', 'aria-selected'],
		})
		observeItems()
		measure()
		return () => {
			resize?.disconnect()
			mutation.disconnect()
		}
	}, [selector])

	return (
		<span
			ref={ref}
			aria-hidden="true"
			data-slot="sliding-indicator"
			data-orientation={orientation}
			hidden={!box}
			style={
				{
					'--active-tab-left': `${box?.left ?? 0}px`,
					'--active-tab-top': `${box?.top ?? 0}px`,
					'--active-tab-width': `${box?.width ?? 0}px`,
					'--active-tab-height': `${box?.height ?? 0}px`,
				} as CSSProperties
			}
			className={slidingIndicatorVariants({ variant })}
		/>
	)
}
