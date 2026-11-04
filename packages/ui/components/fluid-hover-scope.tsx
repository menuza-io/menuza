'use client'

import * as React from 'react'

import { useFluidHover } from '../hooks/use-fluid-hover'
import { cn } from '../lib/utils'
import { FluidHoverHighlight } from './fluid-hover-highlight'

/**
 * One gliding hover highlight for a popup list (menu, select, context menu).
 *
 * Rows join through `useFluidHoverItemRef`, so a row rendered outside a scope
 * (a menu item used on its own) keeps painting its own `focus:` background.
 * Inside a scope the row turns that background off and the shared highlight
 * does the lighting, from the pointer and from the keyboard alike: Base UI
 * moves focus to the highlighted row either way, so a focus event on a row
 * lights that row.
 */

type FluidHoverScopeValue = {
	register: (element: HTMLElement) => () => void
}

const FluidHoverScopeContext = React.createContext<FluidHoverScopeValue | null>(
	null,
)

const useIsoLayoutEffect =
	typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

const isRowDisabled = (element: HTMLElement) =>
	element.matches(':disabled, [aria-disabled="true"], [data-disabled]')

function FluidHoverScope({
	className,
	children,
	highlightClassName,
	follow,
	onFocus,
	onMouseMove,
	onMouseEnter,
	onMouseLeave,
	onClick,
	...props
}: React.ComponentProps<'div'> & {
	/** Merged onto the highlight. Defaults to the popup row fill. */
	highlightClassName?: string
	/**
	 * For a list that chooses its own current row (cmdk marks it
	 * `data-selected="true"`, from the pointer and the keyboard). The highlight
	 * follows that attribute instead of the pointer, so there is one source of
	 * truth and the two never disagree.
	 */
	follow?: string
}) {
	const containerRef = React.useRef<HTMLDivElement>(null)
	const hover = useFluidHover(containerRef, {
		axis: 'y',
		isItemDisabled: isRowDisabled,
		// Popup padding and the gaps between rows stay inert.
		gapClick: false,
	})
	const { registerItem, setActiveIndex } = hover
	const freeIndexes = React.useRef<number[]>([])
	const nextIndex = React.useRef(0)
	const elements = React.useRef(new Map<number, HTMLElement>())

	const value = React.useMemo<FluidHoverScopeValue>(
		() => ({
			register: (element) => {
				const index = freeIndexes.current.pop() ?? nextIndex.current++
				elements.current.set(index, element)
				registerItem(index, element)
				return () => {
					elements.current.delete(index)
					registerItem(index, null)
					freeIndexes.current.push(index)
				}
			},
		}),
		[registerItem],
	)

	React.useEffect(() => {
		const container = containerRef.current
		if (!follow || !container) return
		const sync = () => {
			for (const [index, element] of elements.current) {
				if (element.getAttribute(follow) === 'true') {
					setActiveIndex(index)
					return
				}
			}
			setActiveIndex(null)
		}
		sync()
		const observer = new MutationObserver(sync)
		observer.observe(container, {
			attributes: true,
			attributeFilter: [follow],
			subtree: true,
		})
		return () => observer.disconnect()
	}, [follow, setActiveIndex])

	const handleFocus = (event: React.FocusEvent<HTMLDivElement>) => {
		onFocus?.(event)
		const target = event.target
		if (!(target instanceof HTMLElement)) return
		for (const [index, element] of elements.current) {
			if (element === target || element.contains(target)) {
				setActiveIndex(index)
				return
			}
		}
		// Focus moved to a row that does not join the scope (a destructive item
		// paints its own fill): do not leave the previous row lit as well.
		setActiveIndex(null)
	}

	return (
		<FluidHoverScopeContext value={value}>
			<div
				ref={containerRef}
				data-slot="fluid-hover-scope"
				// `isolate` keeps the highlight's negative z-index inside the scope,
				// so it sits above the popup's own background and behind the rows.
				className={cn('relative isolate', className)}
				onFocus={follow ? onFocus : handleFocus}
				// The caller's handlers run first, then the hook's (as with onFocus), so
				// neither replaces the other.
				onMouseMove={(event) => {
					onMouseMove?.(event)
					if (!follow) hover.handlers.onMouseMove(event)
				}}
				onMouseEnter={(event) => {
					onMouseEnter?.(event)
					if (!follow) hover.handlers.onMouseEnter()
				}}
				onMouseLeave={(event) => {
					onMouseLeave?.(event)
					if (!follow) hover.handlers.onMouseLeave()
				}}
				onClick={(event) => {
					onClick?.(event)
					if (!follow) hover.handlers.onClick(event)
				}}
				{...props}
			>
				<FluidHoverHighlight
					hover={hover}
					className={cn('bg-accent -z-10 rounded-md', highlightClassName)}
				/>
				{children}
			</div>
		</FluidHoverScopeContext>
	)
}

function assignRef<T>(ref: React.Ref<T> | undefined, node: T | null) {
	if (typeof ref === 'function') ref(node)
	else if (ref) (ref as React.RefObject<T | null>).current = node
}

/**
 * Joins a row to the nearest `FluidHoverScope`. Returns the ref to put on the
 * row (it forwards the caller's own ref) and whether the row is lit by a scope,
 * in which case it should drop its own hover or focus background.
 */
function useFluidHoverItemRef<T extends HTMLElement>(
	externalRef?: React.Ref<T>,
	enabled = true,
) {
	const scope = React.useContext(FluidHoverScopeContext)
	// Held in state, not a ref: a list that replaces a row's DOM node (cmdk does
	// when a filtered row comes back) must register the new node.
	const [element, setElement] = React.useState<T | null>(null)
	const ref = React.useCallback(
		(node: T | null) => {
			setElement(node)
			assignRef(externalRef, node)
		},
		[externalRef],
	)

	useIsoLayoutEffect(() => {
		if (!scope || !enabled || !element) return
		return scope.register(element)
	}, [scope, enabled, element])

	return { ref, inScope: Boolean(scope) && enabled }
}

export { FluidHoverScope, useFluidHoverItemRef }
