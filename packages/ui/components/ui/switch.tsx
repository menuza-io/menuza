'use client'

import { Switch as SwitchPrimitive } from '@base-ui/react/switch'
import { animate, motion, useMotionValue, useReducedMotion } from 'motion/react'
import * as React from 'react'

import { spring } from '../../lib/springs'
import { cn } from '../../lib/utils'

// ---------------------------------------------------------------------------
// Fluid switch. The thumb's x lives in a motion value: the pointer writes it
// directly while dragging, and it springs to its resting spot otherwise.
// Hover stretches the thumb into a pill, press stretches it further and
// squashes it. Past the track midpoint on release the switch toggles, short
// of it the thumb springs back. The API stays Base UI's (`checked`,
// `onCheckedChange`, `name`, ...); the component only owns the motion.
// ---------------------------------------------------------------------------

// Track and thumb geometry per size. Each track is its thumb plus 4px, so a
// resting thumb sits centered with 2px to every edge.
const METRICS = {
	default: {
		trackWidth: 34,
		thumbSize: 16,
		pillExtend: 2,
		pressExtend: 4,
		pressShrink: 4,
	},
	sm: {
		trackWidth: 28,
		thumbSize: 12,
		pillExtend: 2,
		pressExtend: 3,
		pressShrink: 3,
	},
} as const

const THUMB_OFFSET = 2

type PointerEventOf<
	K extends
		'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel',
> = Parameters<NonNullable<SwitchPrimitive.Root.Props[K]>>[0]
// Pointer travel (px) before a press becomes a drag. Under it the gesture
// stays a click, so a tap that wobbles a pixel still toggles.
const DRAG_DEAD_ZONE = 2

function Switch({
	className,
	size = 'default',
	checked: checkedProp,
	defaultChecked,
	onCheckedChange,
	onPointerEnter,
	onPointerLeave,
	onPointerDown,
	onPointerMove,
	onPointerUp,
	onPointerCancel,
	ref,
	...props
}: SwitchPrimitive.Root.Props & {
	size?: 'sm' | 'default'
}) {
	const m = METRICS[size ?? 'default']
	const reduceMotion = useReducedMotion() ?? false
	const rootRef = React.useRef<HTMLElement | null>(null)

	// Always controlled underneath, so a drag that ends short of the midpoint
	// can refuse the click that follows it.
	const [internalChecked, setInternalChecked] = React.useState(
		defaultChecked ?? false,
	)
	const checked = checkedProp ?? internalChecked

	const [hovered, setHovered] = React.useState(false)
	// Bumped when a drag ends, so the thumb re-settles on `checked` even when
	// the release changed nothing (a refused or cancelled toggle).
	const [settle, setSettle] = React.useState(0)
	const [pressed, setPressed] = React.useState(false)
	const [rtl, setRtl] = React.useState(false)
	const hasMounted = React.useRef(false)
	const dragging = React.useRef(false)
	// Outlives the pointerup by one frame so the click fired by the same
	// release can be swallowed.
	const swallowClick = React.useRef(false)
	const pointerStart = React.useRef<{
		clientX: number
		originX: number
	} | null>(null)

	const thumbTravel = m.trackWidth - m.thumbSize - THUMB_OFFSET * 2
	const restingX = checked ? THUMB_OFFSET + thumbTravel : THUMB_OFFSET
	const motionX = useMotionValue(restingX)

	React.useEffect(() => {
		const element = rootRef.current
		if (element) setRtl(getComputedStyle(element).direction === 'rtl')
		hasMounted.current = true
	}, [])

	const thumbTransition = React.useMemo(
		() => (reduceMotion ? { duration: 0 } : spring.moderate),
		[reduceMotion],
	)

	// Press wins over hover. When checked the extra width grows toward the
	// start (x backs off by it), so the outer edge stays pinned to the track end.
	const thumbWidth = pressed
		? m.thumbSize + m.pressExtend
		: hovered
			? m.thumbSize + m.pillExtend
			: m.thumbSize
	const thumbHeight = pressed ? m.thumbSize - m.pressShrink : m.thumbSize
	const thumbY = pressed ? THUMB_OFFSET + m.pressShrink / 2 : THUMB_OFFSET
	const extraWidth = thumbWidth - m.thumbSize
	const thumbX = checked ? restingX - extraWidth : THUMB_OFFSET

	React.useEffect(() => {
		if (dragging.current) return
		if (!hasMounted.current) {
			motionX.set(thumbX)
		} else {
			animate(motionX, thumbX, thumbTransition)
		}
	}, [thumbX, motionX, thumbTransition, settle])

	const dragBounds = () => {
		const min = THUMB_OFFSET
		const max = m.trackWidth - THUMB_OFFSET - (m.thumbSize + m.pressExtend)
		return { min, max, midpoint: (min + max) / 2 }
	}

	const handlePointerDown = (event: PointerEventOf<'onPointerDown'>) => {
		onPointerDown?.(event)
		if (props.disabled || props.readOnly) return
		if (event.pointerType === 'mouse' && event.button !== 0) return
		setPressed(true)
		dragging.current = false
		swallowClick.current = false
		pointerStart.current = { clientX: event.clientX, originX: motionX.get() }
		// Keeps move and up events on the track after the pointer leaves it, so
		// a drag can overshoot and still release.
		// Capture can be unavailable or refuse a synthetic pointer; the drag then
		// just ends when the pointer leaves the track.
		try {
			event.currentTarget.setPointerCapture(event.pointerId)
		} catch {}
	}

	const handlePointerMove = (event: PointerEventOf<'onPointerMove'>) => {
		onPointerMove?.(event)
		const start = pointerStart.current
		if (!start) return
		const delta = (event.clientX - start.clientX) * (rtl ? -1 : 1)
		if (!dragging.current) {
			if (Math.abs(delta) < DRAG_DEAD_ZONE) return
			dragging.current = true
			// Stop any spring still running from the press, or it would overwrite
			// the pointer on every frame.
			motionX.stop()
		}
		const { min, max } = dragBounds()
		motionX.set(Math.max(min, Math.min(max, start.originX + delta)))
	}

	const handlePointerUp = (event: PointerEventOf<'onPointerUp'>) => {
		onPointerUp?.(event)
		if (!pointerStart.current) return
		setPressed(false)

		if (dragging.current) {
			dragging.current = false
			const shouldBeOn = motionX.get() > dragBounds().midpoint
			// Release the swallow after the toggle click so only the natural click
			// that ends this drag is refused.
			swallowClick.current = false
			if (shouldBeOn !== checked) {
				rootRef.current?.click()
			} else {
				animate(motionX, restingX, thumbTransition)
			}
			swallowClick.current = true
			setSettle((count) => count + 1)
			requestAnimationFrame(() => {
				swallowClick.current = false
			})
		}
		pointerStart.current = null
	}

	const handlePointerCancel = (event: PointerEventOf<'onPointerCancel'>) => {
		onPointerCancel?.(event)
		if (!pointerStart.current) return
		setPressed(false)
		if (dragging.current) {
			dragging.current = false
			animate(motionX, restingX, thumbTransition)
		}
		pointerStart.current = null
	}

	return (
		<SwitchPrimitive.Root
			ref={(node) => {
				rootRef.current = node
				if (typeof ref === 'function') ref(node)
				else if (ref)
					(ref as React.RefObject<HTMLElement | null>).current = node
			}}
			data-slot="switch"
			data-size={size}
			checked={checked}
			onCheckedChange={(next, details) => {
				if (swallowClick.current) return
				// The consumer may cancel the change, and a cancelled change must
				// not flip an uncontrolled switch either.
				onCheckedChange?.(next, details)
				if (details.isCanceled) return
				setInternalChecked(next)
			}}
			onPointerEnter={(event) => {
				onPointerEnter?.(event)
				// Mouse only: a finger has no hover, so touch never leaves the
				// thumb stuck in its pill shape.
				if (event.pointerType === 'mouse' && !props.disabled) setHovered(true)
			}}
			onPointerLeave={(event) => {
				onPointerLeave?.(event)
				setHovered(false)
			}}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerCancel}
			className={cn(
				// touch-none stops the browser claiming a horizontal drag as a scroll.
				'data-checked:bg-primary data-unchecked:bg-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 dark:data-unchecked:bg-input/80 peer group/switch relative inline-flex shrink-0 touch-none items-center rounded-full border border-transparent transition-[color,background-color,border-color,box-shadow] duration-80 outline-none after:absolute after:-inset-x-3 after:-inset-y-4 focus-visible:ring-[3px] aria-invalid:ring-[3px] data-checked:hover:bg-[color-mix(in_oklab,var(--primary),black_8%)] data-disabled:cursor-not-allowed data-disabled:opacity-50 data-unchecked:hover:bg-[color-mix(in_oklab,var(--input),var(--foreground)_10%)] data-[size=default]:h-5 data-[size=default]:w-[34px] data-[size=sm]:h-4 data-[size=sm]:w-[28px] motion-reduce:transition-none dark:data-unchecked:hover:bg-[color-mix(in_oklab,var(--input),var(--foreground)_10%)]',
				className,
			)}
			{...props}
		>
			{/* Covers the border box, and mirrors in RTL, so the thumb's x and its
			    stretch always count from the start edge. */}
			<span
				aria-hidden
				className="pointer-events-none absolute -inset-px rtl:-scale-x-100"
			>
				<motion.span
					data-slot="switch-thumb"
					// Pinned to the top-left and placed only by the x and y transforms;
					// width and height carry the hover and press shapes.
					className="absolute top-0 left-0 block rounded-full bg-white shadow-[0_1px_2px_oklch(0_0_0/20%)]"
					initial={false}
					// A motion value can only drive a transform through `style`.
					// eslint-disable-next-line shadcn/no-inline-styles
					style={{ x: motionX }}
					animate={{ y: thumbY, width: thumbWidth, height: thumbHeight }}
					transition={hasMounted.current ? thumbTransition : { duration: 0 }}
				/>
			</span>
		</SwitchPrimitive.Root>
	)
}

export { Switch }
