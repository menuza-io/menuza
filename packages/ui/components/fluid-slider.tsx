/* eslint-disable shadcn/no-inline-styles --
   Every moving layer is positioned by a motion value, which can only drive
   layout through `style`. */
'use client'

import { Slider as SliderPrimitive } from '@base-ui/react/slider'
import {
	motion,
	useMotionValue,
	useReducedMotion,
	useTransform,
	animate,
	AnimatePresence,
	type MotionValue,
} from 'motion/react'
import * as React from 'react'

import { fontWeights } from '../lib/font-weight'
import { spring } from '../lib/springs'
import { cn } from '../lib/utils'

// ---------------------------------------------------------------------------
// FluidSlider is the Fluid Functionalism slider's default design: a 32px
// bordered row holding the label at the start and the value at the end, drawn
// as pips (one dot per step) or a scrubber. Every moving layer is positioned
// by motion values over an invisible Base UI slider that supplies ARIA and
// the arrow keys. Pointer input never reaches the primitive, so presses can
// spring instead of jump.
//
// Ported from the registry's `base/slider` (its comfortable engine). The
// theme differences are small: the row is a pill like our buttons, the fill
// is a 12% foreground wash, and the ring reads from `--ring`.
// ---------------------------------------------------------------------------

// Step dots grow 1.25x (4px -> 5px) while the slider is hovered.
const PIP_SIZE = 5

// 0..1 position of a value in the range. A slider whose min equals its max has
// no range to divide by, so it sits at the start instead of producing NaN.
function percentOf(value: number, min: number, max: number) {
	return max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)))
}

// The drag and animation handlers are omitted because rest props spread onto
// a motion.div, whose own types for those names clash with the DOM ones.
interface FluidSliderProps extends Omit<
	React.HTMLAttributes<HTMLDivElement>,
	| 'onChange'
	| 'defaultValue'
	| 'onDrag'
	| 'onDragStart'
	| 'onDragEnd'
	| 'onDragOver'
	| 'onAnimationStart'
> {
	value: number
	onChange: (value: number) => void
	min?: number
	max?: number
	step?: number
	variant?: 'pips' | 'scrubber'
	label?: string
	formatValue?: (v: number) => string
	disabled?: boolean
}

// A 32px bordered row with the label at the start and the value at the end.
// "pips" draws a dot per step and springs the fill on every snap; "scrubber"
// fills continuously, glued to the cursor. Both mark the value with a 2px
// handle line, and label and value go muted → foreground on spring.fast while
// hovered or focused.
const FluidSlider = React.forwardRef<HTMLDivElement, FluidSliderProps>(
	(
		{
			value,
			onChange,
			min = 0,
			max = 100,
			step = 1,
			variant = 'pips',
			label,
			'aria-label': ariaLabel,
			'aria-labelledby': ariaLabelledBy,
			'aria-describedby': ariaDescribedBy,
			onPointerDown,
			onPointerMove,
			onPointerUp,
			onPointerCancel,
			formatValue = String,
			disabled = false,
			className,
			...props
		},
		ref,
	) => {
		const reduceMotion = useReducedMotion() ?? false
		// Imperative animate() calls are not covered by MotionConfig, so reduced
		// motion is applied here: the fill lands at once.
		const move = React.useMemo(
			() => (reduceMotion ? { duration: 0 } : spring.fast),
			[reduceMotion],
		)
		const containerRef = React.useRef<HTMLDivElement>(null)
		const thumbRef = React.useRef<HTMLDivElement>(null)
		// The latest value, for settling the fill when a press ends.
		const valueRef = React.useRef(value)
		valueRef.current = value
		// Row presses and the scrubber's handle strip track their drags apart.
		const dragging = React.useRef(false)
		const handleDragging = React.useRef(false)
		const [isHovered, setIsHovered] = React.useState(false)
		const [isPressed, setIsPressed] = React.useState(false)
		const [isFocused, setIsFocused] = React.useState(false)
		const [hoverPreview, setHoverPreview] = React.useState<{
			left: number
			width: number
			snappedValue: number
			cursorX: number
		} | null>(null)
		// Set 100ms into a hover; reset as soon as the hover ends.
		const [hoverDelayDone, setHoverDelayDone] = React.useState(false)

		// Show hover tooltip after 100ms delay
		// The preview bar appears on the first move; only the tooltip waits, so
		// sweeping the cursor across the slider doesn't flash it.
		if (!isHovered && hoverDelayDone) setHoverDelayDone(false)
		React.useEffect(() => {
			if (!isHovered) return
			const id = setTimeout(() => setHoverDelayDone(true), 100)
			return () => clearTimeout(id)
		}, [isHovered])
		const showHoverTooltip = isHovered && hoverDelayDone

		// The forwarded ref and rest props land on the bordered row, not the outer
		// wrapper; containerRef keeps a local handle for measuring.
		const mergedRef = React.useCallback(
			(el: HTMLDivElement | null) => {
				containerRef.current = el
				if (typeof ref === 'function')
					(ref as React.RefCallback<HTMLDivElement>)(el)
				else if (ref)
					(ref as React.RefObject<HTMLDivElement | null>).current = el
			},
			[ref],
		)

		const pipSteps = React.useMemo(
			() =>
				Array.from(
					{ length: Math.round((max - min) / step) + 1 },
					(_, i) => min + i * step,
					// A step that does not divide the range would put a pip past max.
				).filter((pip) => pip <= max),
			[min, max, step],
		)
		const pipCount = pipSteps.length

		// Fill motion value
		const fillPercent = useMotionValue(
			max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min))),
		)
		// Small offset when value is at min so the handle line stays visible
		// 8px for pips, 17px for scrubber, eased in and out on spring.fast as the
		// value lands on or leaves min.
		const zeroTarget = variant === 'pips' ? 8 : 17
		const zeroOffset = useMotionValue(value === min ? zeroTarget : 0)

		const fillWidthStyle = useTransform(fillPercent, (p) => `${p * 100}%`)
		// Scrubber handle strip: 8px wide, ending at the fill edge (plus
		// zeroOffset at min).
		const handleLeftStyle = useTransform(
			[fillPercent, zeroOffset] as MotionValue<number>[],
			([p, zo]) => `calc(${(p as number) * 100}% - 8px + ${zo as number}px)`,
		)
		// Scrubber line: 9px behind the fill edge, which at min would put it past
		// the row's left edge; zeroOffset (17px) brings it back to 8px.
		const handleLineLeftStyle = useTransform(
			[fillPercent, zeroOffset] as MotionValue<number>[],
			([p, zo]) => `calc(${(p as number) * 100}% - 9px + ${zo as number}px)`,
		)
		// Pips fill: its edge runs from 20px at p = 0 to the full width at p = 1,
		// a few px past the active pip, so the mask hides that pip and the handle
		// line stands in for it. At min, zeroOffset × 2.5 (20px) cancels the 20px
		// base and the fill empties.
		const pipsFillWidthStyle = useTransform(
			[fillPercent, zeroOffset] as MotionValue<number>[],
			([p, zo]) =>
				`calc(${(p as number) * 100}% + ${20 - 20 * (p as number) - (zo as number) * 2.5}px)`,
		)
		// Pips line: centered 12px in from each edge at the extremes (the pips
		// row's px-3 inset), so it stays visible at min without zeroOffset.
		const pipsHandleLineLeftStyle = useTransform(
			fillPercent,
			(p) => `calc(${p * 100}% + ${11 - 24 * p}px)`,
		)
		// Hides pips under the fill with a 2px feather, tracking the fill edge.
		const pipsMaskStyle = useTransform(
			[fillPercent, zeroOffset] as MotionValue<number>[],
			([p, zo]) => {
				const offset = 20 - 20 * (p as number) - (zo as number) * 2.5
				return `linear-gradient(to right, transparent calc(${(p as number) * 100}% + ${offset}px), black calc(${(p as number) * 100}% + ${offset + 2}px))`
			},
		)

		// --- Hover preview computation ---
		const computeHoverPreview = React.useCallback(
			(clientX: number) => {
				const el = containerRef.current
				if (!el) return
				const rect = el.getBoundingClientRect()
				// Use clientWidth (padding box) — CSS % and absolute left/width are relative to it
				const w = el.clientWidth
				if (w <= 0 || rect.width <= 0) return
				// Normalize cursor to layout space so it matches `w` (layout, padding
				// box). offsetWidth is the layout border-box; the difference vs `w` is
				// the horizontal border contribution split across both sides.
				const scale = rect.width / el.offsetWidth
				const borderLeftLayout = (el.offsetWidth - w) / 2
				const visualX = clientX - rect.left
				const layoutX = visualX / scale - borderLeftLayout
				const clamped = Math.max(0, Math.min(w, layoutX))

				// Snap to nearest step value
				let snappedVal: number
				if (variant === 'pips') {
					if (pipCount <= 1) return
					const index = Math.max(
						0,
						Math.min(pipCount - 1, Math.round((clamped / w) * (pipCount - 1))),
					)
					snappedVal = pipSteps[index] ?? min
				} else {
					const raw = min + (clamped / w) * (max - min)
					snappedVal = Math.max(
						min,
						Math.min(max, Math.round((raw - min) / step) * step + min),
					)
				}
				const snappedPercent =
					max === min ? 0 : (snappedVal - min) / (max - min)
				const snappedX = snappedPercent * w

				// Current handle position — for pips, match the visual fill edge offset
				const currentPercent = fillPercent.get()
				let handleX: number
				if (variant === 'pips') {
					const zo = zeroOffset.get()
					handleX = currentPercent * w + (20 - 20 * currentPercent - zo * 2.5)
				} else {
					handleX = currentPercent * w
				}

				// Extend hover bar to container edges at extremes so there's no gap
				const edgeX = snappedVal === min ? 0 : snappedVal === max ? w : snappedX
				const left = Math.min(handleX, edgeX)
				const width = Math.abs(edgeX - handleX)
				setHoverPreview({
					left,
					width,
					snappedValue: snappedVal,
					cursorX: snappedX,
				})
			},
			[variant, pipSteps, pipCount, min, max, step, fillPercent, zeroOffset],
		)

		// Sync fill on programmatic value change
		// Arrow keys land here too, springing on spring.fast; skipped during
		// either drag.
		React.useEffect(() => {
			if (dragging.current || handleDragging.current) return
			const percent =
				max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)))
			animate(fillPercent, percent, move)
			animate(zeroOffset, value === min ? zeroTarget : 0, move)
		}, [value, min, max, variant, fillPercent, zeroOffset, zeroTarget, move])

		// Visual x over visual width: the ratio holds at any ancestor scale, so
		// no layout normalization is needed. Clamping maps presses in the 8px
		// gutters to min or max.
		const getValueFromX = React.useCallback(
			(clientX: number) => {
				const rect = containerRef.current?.getBoundingClientRect()
				if (!rect) return min
				const x = clientX - rect.left
				const clamped = Math.max(0, Math.min(rect.width, x))
				if (variant === 'pips') {
					if (pipCount <= 1) return min
					const index = Math.max(
						0,
						Math.min(
							pipCount - 1,
							Math.round((clamped / rect.width) * (pipCount - 1)),
						),
					)
					return pipSteps[index] ?? min
				} else {
					const raw = min + (clamped / rect.width) * (max - min)
					const snapped = Math.round((raw - min) / step) * step + min
					return Math.max(min, Math.min(max, snapped))
				}
			},
			[variant, pipSteps, pipCount, min, max, step],
		)

		// A press does not focus anything (it is default-prevented), so move
		// focus to the real slider and the arrow keys work straight after a click.
		const focusThumb = () => {
			const thumb = thumbRef.current
			const target = thumb?.querySelector('input') ?? thumb
			target?.focus({ preventScroll: true })
		}

		const handlePointerDown = React.useCallback(
			(e: React.PointerEvent<HTMLDivElement>) => {
				if (disabled) return
				if (e.pointerType === 'mouse' && e.button !== 0) return
				e.preventDefault()
				dragging.current = true
				focusThumb()
				setIsPressed(true)
				// A press anywhere jumps to the snapped value; the fill springs there
				// on spring.fast.
				const newVal = getValueFromX(e.clientX)
				onChange(newVal)
				const newPercent = percentOf(newVal, min, max)
				animate(fillPercent, newPercent, move)
				animate(zeroOffset, newVal === min ? zeroTarget : 0, move)
				try {
					;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
				} catch {}
			},
			[
				disabled,
				getValueFromX,
				onChange,
				fillPercent,
				zeroOffset,
				zeroTarget,
				min,
				max,
				move,
			],
		)

		const handlePointerMove = React.useCallback(
			(e: React.PointerEvent<HTMLDivElement>) => {
				if (!dragging.current) return
				const newVal = getValueFromX(e.clientX)
				onChange(newVal)
				const newPercent = percentOf(newVal, min, max)
				// Scrubber: set directly, so the fill stays glued to the cursor.
				// Pips: spring per snap, so each jump between pips eases.
				if (variant === 'scrubber') {
					fillPercent.set(newPercent)
				} else {
					animate(fillPercent, newPercent, move)
				}
				animate(zeroOffset, newVal === min ? zeroTarget : 0, move)
			},
			[
				getValueFromX,
				onChange,
				variant,
				fillPercent,
				zeroOffset,
				zeroTarget,
				min,
				max,
				move,
			],
		)

		// No settle step on release: every move already landed on a snapped value.
		// The parent may keep the old value (a refused or clamped change); the
		// fill must then go back to it instead of staying where the press put it.
		const settleFill = React.useCallback(() => {
			animate(fillPercent, percentOf(valueRef.current, min, max), move)
			animate(zeroOffset, valueRef.current === min ? zeroTarget : 0, move)
		}, [fillPercent, zeroOffset, zeroTarget, min, max, move])

		const handlePointerUp = React.useCallback(() => {
			dragging.current = false
			setIsPressed(false)
			setHoverPreview(null)
			settleFill()
		}, [settleFill])

		// Resize handle drag handlers (direct cursor position)
		// Unlike a row press, grabbing the handle sets the fill from the first
		// event with no spring; stopPropagation keeps the row's press handler
		// from also firing.
		const handleResizePointerDown = React.useCallback(
			(e: React.PointerEvent<HTMLDivElement>) => {
				if (disabled) return
				if (e.pointerType === 'mouse' && e.button !== 0) return
				e.preventDefault()
				e.stopPropagation()
				handleDragging.current = true
				focusThumb()
				setIsPressed(true)
				const newVal = getValueFromX(e.clientX)
				onChange(newVal)
				fillPercent.set(percentOf(newVal, min, max))
				animate(zeroOffset, newVal === min ? zeroTarget : 0, move)
				try {
					;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
				} catch {}
			},
			[
				disabled,
				getValueFromX,
				onChange,
				fillPercent,
				zeroOffset,
				zeroTarget,
				min,
				max,
				move,
			],
		)

		const handleResizePointerMove = React.useCallback(
			(e: React.PointerEvent<HTMLDivElement>) => {
				if (!handleDragging.current) return
				const newVal = getValueFromX(e.clientX)
				onChange(newVal)
				fillPercent.set(percentOf(newVal, min, max))
				animate(zeroOffset, newVal === min ? zeroTarget : 0, move)
			},
			[
				getValueFromX,
				onChange,
				fillPercent,
				zeroOffset,
				zeroTarget,
				min,
				max,
				move,
			],
		)

		const handleResizePointerUp = React.useCallback(() => {
			handleDragging.current = false
			setIsPressed(false)
			setHoverPreview(null)
			settleFill()
		}, [settleFill])

		const handleRadixChange = React.useCallback(
			(newValues: number[]) => {
				// A degenerate range gives the primitive one extra step to render; never
				// pass that on.
				onChange(Math.min(max, Math.max(min, newValues[0] ?? min)))
			},
			[onChange, min, max],
		)

		// Hover or keyboard focus brightens the label and value and grows the
		// handle line.
		const isActive = isHovered || isFocused

		// Hover state and the preview live on this wrapper, so the 8px gutters
		// count as hovering too.
		return (
			<div
				className="relative w-full touch-none"
				onPointerEnter={() => {
					if (!disabled) setIsHovered(true)
				}}
				onPointerLeave={() => {
					if (!disabled) {
						setIsHovered(false)
						setHoverPreview(null)
					}
				}}
				onMouseMove={(e) => {
					if (disabled || dragging.current || handleDragging.current) return
					computeHoverPreview(e.clientX)
				}}
			>
				{/* Extended hit area — 8px beyond each edge */}
				{/* The row paints over its middle, so this only catches the 8px
            gutters, which getValueFromX clamps to min or max. */}
				<div
					className="absolute cursor-ew-resize"
					style={{ left: -8, right: -8, top: 0, bottom: 0 }}
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerUp}
					onPointerCancel={handlePointerUp}
				/>
				{/* Hover value tooltip — outside overflow-hidden container */}
				<AnimatePresence>
					{hoverPreview && showHoverTooltip && !isPressed && (
						<motion.div
							key="hover-tooltip"
							className="pointer-events-none absolute z-20 -translate-x-1/2"
							initial={{ opacity: 0, y: 4 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: 4, transition: spring.fast.exit }}
							transition={spring.fast}
							style={{
								left: hoverPreview.cursorX,
								top: -30,
							}}
						>
							<span
								className={
									'text-background bg-foreground rounded-md px-2 py-1 text-xs leading-4 whitespace-nowrap tabular-nums'
								}
								style={{ fontVariationSettings: fontWeights.normal }}
							>
								{formatValue(hoverPreview.snappedValue)}
							</span>
						</motion.div>
					)}
				</AnimatePresence>

				{/* The focus ring is an outline 2px outside the row, which the row's
          own overflow-hidden can't clip. */}
				<motion.div
					ref={mergedRef}
					className={cn(
						'border-border relative h-8 w-full touch-none overflow-hidden border outline-offset-2 select-none',
						variant === 'scrubber'
							? 'flex cursor-ew-resize items-center gap-3 px-4'
							: 'cursor-ew-resize',
						'bg-background rounded-full',
						disabled && 'pointer-events-none opacity-50',
						className,
					)}
					initial={false}
					animate={{
						outline: isFocused
							? '1px solid var(--ring)'
							: '1px solid transparent',
					}}
					transition={spring.fast}
					onPointerDown={(event) => {
						onPointerDown?.(event)
						handlePointerDown(event)
					}}
					onPointerMove={(event) => {
						onPointerMove?.(event)
						handlePointerMove(event)
					}}
					onPointerUp={(event) => {
						onPointerUp?.(event)
						handlePointerUp()
					}}
					onPointerCancel={(event) => {
						onPointerCancel?.(event)
						handlePointerUp()
					}}
					{...props}
				>
					{/* Invisible Base UI Slider for keyboard nav + a11y */}
					{/* [&_*]:pointer-events-none keeps its thumb off the hit path too, so
            presses always reach the row. */}
					<SliderPrimitive.Root
						value={[value]}
						onValueChange={(v) => handleRadixChange(v as number[])}
						min={min}
						// The primitive warns when max is not above min; a degenerate range
						// still renders, with every position mapping to the start.
						max={max > min ? max : min + step}
						step={step}
						disabled={disabled}
						className="pointer-events-none absolute inset-0 opacity-0 [&_*]:pointer-events-none"
					>
						<SliderPrimitive.Control className="h-full w-full">
							<SliderPrimitive.Track className="h-full w-full">
								<SliderPrimitive.Indicator />
							</SliderPrimitive.Track>
							<SliderPrimitive.Thumb
								ref={thumbRef}
								index={0}
								aria-label={ariaLabel ?? label}
								aria-labelledby={ariaLabelledBy}
								aria-describedby={ariaDescribedBy}
								getAriaValueText={(_formatted, current) => formatValue(current)}
								className="block outline-none"
								onFocus={(e) => {
									if (
										(e.currentTarget as HTMLElement).matches(':focus-visible')
									)
										setIsFocused(true)
								}}
								onBlur={() => setIsFocused(false)}
							/>
						</SliderPrimitive.Control>
					</SliderPrimitive.Root>

					{/* Hover preview */}
					{/* Same 40% accent bar as the compact design, from the fill edge to
            the snapped hover value. Unrounded; at min or max the row's clip
            rounds its outer end. */}
					<motion.div
						className="pointer-events-none absolute inset-y-0 z-[3]"
						initial={false}
						animate={{
							opacity: hoverPreview && !isPressed ? 1 : 0,
						}}
						transition={{ opacity: { duration: 0.15 } }}
						style={{
							left: hoverPreview ? hoverPreview.left : 0,
							width: hoverPreview ? hoverPreview.width : 0,
							backgroundColor:
								'color-mix(in srgb, var(--accent) 40%, transparent)',
						}}
					/>

					{/* Pips: dots layer — z-[1] */}
					{variant === 'pips' && (
						<motion.div
							className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-between px-3"
							style={{
								WebkitMaskImage: pipsMaskStyle,
								maskImage: pipsMaskStyle,
							}}
						>
							{pipSteps.map((pipValue) => {
								// The active pip goes full foreground. At rest it only shows at
								// min; elsewhere the mask hides it behind the handle line.
								const isActivePip = pipValue === value
								return (
									<div
										key={pipValue}
										className="relative flex items-center justify-center"
										style={{ width: PIP_SIZE, height: PIP_SIZE }}
									>
										<motion.div
											className="rounded-full"
											initial={false}
											animate={{
												backgroundColor: isActivePip
													? 'var(--foreground)'
													: 'var(--muted-foreground)',
												opacity: isActivePip ? 1 : 0.3,
											}}
											transition={spring.fast}
											style={{ width: PIP_SIZE, height: PIP_SIZE }}
										/>
									</div>
								)
							})}
						</motion.div>
					)}

					{/* Pips: label + value BG layer — z-[2] (occludes dots behind text) */}
					{/* Transparent-text copies of the label and value on bg-background,
            sized like the visible text so pips never cross the words. */}
					{variant === 'pips' && (
						<div
							className="pointer-events-none absolute inset-0 z-[2] flex items-center px-2"
							aria-hidden
						>
							{label && (
								<span className="bg-background px-2 text-[13px] leading-5 text-transparent select-none">
									{label}
								</span>
							)}
							<span
								className="bg-background ml-auto px-2 text-[13px] leading-5 text-transparent tabular-nums select-none"
								style={{ minWidth: `${String(formatValue(max)).length}ch` }}
							>
								{formatValue(value)}
							</span>
						</div>
					)}

					{/* Pips: fill — z-[3] */}
					{variant === 'pips' && (
						<motion.div
							className="pointer-events-none absolute top-0 bottom-0 left-0 z-[3]"
							style={{
								width: pipsFillWidthStyle,
								backgroundColor:
									'color-mix(in oklab, var(--foreground) 12%, transparent)',
							}}
						/>
					)}

					{/* Pips: handle line — z-[3] */}
					{/* 2px wide. Active (hover or focus) shrinks the inset 8 → 7, 2px
            taller in all; color steps 25% → 50% → 100% foreground for rest,
            hover, focus. */}
					{variant === 'pips' && (
						<motion.div
							className="pointer-events-none absolute z-[3] rounded-full"
							initial={false}
							animate={{
								top: isActive ? 7 : 8,
								bottom: isActive ? 7 : 8,
								backgroundColor: isFocused
									? 'var(--foreground)'
									: isHovered
										? 'color-mix(in srgb, var(--foreground) 50%, transparent)'
										: 'color-mix(in srgb, var(--foreground) 25%, transparent)',
							}}
							transition={spring.fast}
							style={{
								left: pipsHandleLineLeftStyle,
								width: 2,
							}}
						/>
					)}

					{/* Pips: label + value text layer — z-[4] */}
					{variant === 'pips' && (
						<div className="pointer-events-none absolute inset-0 z-[4] flex items-center px-2">
							{label && (
								<motion.span
									className="px-2 text-[13px] leading-5"
									initial={false}
									animate={{
										color: isActive
											? 'var(--foreground)'
											: 'var(--muted-foreground)',
									}}
									transition={spring.fast}
								>
									{label}
								</motion.span>
							)}
							{/* minWidth reserves formatValue(max)'s length in ch, so the value
                slot keeps its width as the number changes. */}
							<motion.span
								className="ml-auto px-2 text-[13px] leading-5 tabular-nums"
								initial={false}
								animate={{
									color: isActive
										? 'var(--foreground)'
										: 'var(--muted-foreground)',
								}}
								transition={spring.fast}
								style={{
									minWidth: `${String(formatValue(max)).length}ch`,
									textAlign: 'right',
								}}
							>
								{formatValue(value)}
							</motion.span>
						</div>
					)}

					{/* Scrubber: fill */}
					{/* Width maps straight from fillPercent, with no offsets. */}
					{variant === 'scrubber' && (
						<motion.div
							className="pointer-events-none absolute top-0 bottom-0 left-0"
							style={{
								width: fillWidthStyle,
								backgroundColor:
									'color-mix(in oklab, var(--foreground) 12%, transparent)',
							}}
						/>
					)}

					{/* Scrubber: handle line */}
					{/* Same sizes and color steps as the pips line. */}
					{variant === 'scrubber' && (
						<motion.div
							className="pointer-events-none absolute z-10 rounded-full"
							initial={false}
							animate={{
								top: isActive ? 7 : 8,
								bottom: isActive ? 7 : 8,
								backgroundColor: isFocused
									? 'var(--foreground)'
									: isHovered
										? 'color-mix(in srgb, var(--foreground) 50%, transparent)'
										: 'color-mix(in srgb, var(--foreground) 25%, transparent)',
							}}
							transition={spring.fast}
							style={{
								left: handleLineLeftStyle,
								width: 2,
							}}
						/>
					)}

					{/* Scrubber: label */}
					{variant === 'scrubber' && label && (
						<motion.span
							className="z-10 shrink-0 text-[13px] leading-5"
							initial={false}
							animate={{
								color: isActive
									? 'var(--foreground)'
									: 'var(--muted-foreground)',
							}}
							transition={spring.fast}
						>
							{label}
						</motion.span>
					)}

					{/* Scrubber: flex-1 spacer + value */}
					{variant === 'scrubber' && (
						<>
							<div className="flex-1" />
							<motion.span
								className="z-10 shrink-0 text-right text-[13px] leading-5 tabular-nums"
								initial={false}
								animate={{
									color: isActive
										? 'var(--foreground)'
										: 'var(--muted-foreground)',
								}}
								transition={spring.fast}
								style={{ minWidth: `${String(formatValue(max)).length}ch` }}
							>
								{formatValue(value)}
							</motion.span>
						</>
					)}

					{/* Resize handle (scrubber only) */}
					{/* An 8px grab strip at the handle line, above the text (z-20). */}
					{variant === 'scrubber' && (
						<motion.div
							className="absolute top-0 bottom-0 z-20 w-2 cursor-ew-resize"
							style={{ left: handleLeftStyle }}
							onPointerDown={handleResizePointerDown}
							onPointerMove={handleResizePointerMove}
							onPointerUp={handleResizePointerUp}
							onPointerCancel={handleResizePointerUp}
						/>
					)}
				</motion.div>
			</div>
		)
	},
)

FluidSlider.displayName = 'FluidSlider'

export { FluidSlider }
export type { FluidSliderProps }
