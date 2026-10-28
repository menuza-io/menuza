import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Icon } from '@repo/ui/icon'
import { useEffect, useRef, useState } from 'react'

/**
 * Compares two images of the same shape. The after image sets the size; the
 * before image is masked on top. Both layers use the same `object-contain`
 * crop so the slider stays aligned. On mount the divider sweeps once so the
 * is visible without dragging (skipped for reduced motion).
 */
export function BeforeAfterSlider({
	beforeSrc,
	afterSrc,
	beforeLabel,
	afterLabel,
	className,
}: {
	beforeSrc: string
	afterSrc: string
	beforeLabel: string
	afterLabel: string
	className?: string
}) {
	const { _ } = useLingui()
	const [position, setPosition] = useState(50)
	const frame = useRef<number | null>(null)

	useEffect(() => {
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
		const duration = 1600
		const start = performance.now()
		const tick = (now: number) => {
			const t = Math.min(1, (now - start) / duration)
			setPosition(50 + 42 * Math.sin(Math.PI * t) ** 2)
			frame.current = t < 1 ? requestAnimationFrame(tick) : null
		}
		frame.current = requestAnimationFrame(tick)
		return () => {
			if (frame.current !== null) cancelAnimationFrame(frame.current)
		}
	}, [afterSrc])

	const mask = `linear-gradient(to right, #000 ${position}%, transparent ${position}%)`

	return (
		<div
			dir="ltr"
			className={cn(
				'bg-muted relative isolate overflow-hidden rounded-xl border select-none',
				className,
			)}
		>
			<img
				src={afterSrc}
				alt={afterLabel}
				className="block max-h-[60vh] w-full object-contain"
				draggable={false}
			/>
			<img
				src={beforeSrc}
				alt={beforeLabel}
				className="pointer-events-none absolute inset-0 size-full object-contain"
				draggable={false}
				style={{ mask, WebkitMask: mask }}
			/>
			<div
				aria-hidden
				className="bg-background pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 shadow-sm"
				style={{ left: `${position}%` }}
			>
				<span className="bg-background text-foreground absolute top-1/2 left-1/2 flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border shadow-sm">
					<Icon name="arrow-right-left" className="size-4" />
				</span>
			</div>
			<span className="bg-background/80 text-foreground pointer-events-none absolute top-3 left-3 rounded-full px-2.5 py-1 text-xs font-medium backdrop-blur-sm">
				{beforeLabel}
			</span>
			<span className="bg-background/80 text-foreground pointer-events-none absolute top-3 right-3 rounded-full px-2.5 py-1 text-xs font-medium backdrop-blur-sm">
				{afterLabel}
			</span>
			<input
				type="range"
				min={0}
				max={100}
				value={position}
				onChange={(event) => {
					if (frame.current !== null) cancelAnimationFrame(frame.current)
					frame.current = null
					setPosition(Number(event.currentTarget.value))
				}}
				aria-label={_(msg`Compare before and after`)}
				className="absolute inset-0 size-full cursor-ew-resize opacity-0"
			/>
		</div>
	)
}
