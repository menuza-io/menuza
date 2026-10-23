import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { X } from 'lucide-react'
import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type ReactNode,
} from 'react'
import { cn, motionMs } from './primitives.tsx'

/**
 * A value that changes in place (a table's "42m" becoming "43m", a party count)
 * cross-blurs into the new one where it stands (text swap soft). Nothing moves
 * on first paint; the words are read once, as the new value.
 */
export function SoftText({
	value,
	className,
}: {
	value: string
	className?: string
}) {
	const [pair, setPair] = useState<{ old: string | null; now: string }>({
		old: null,
		now: value,
	})
	if (pair.now !== value) setPair({ old: pair.now, now: value })
	const ref = useRef<HTMLSpanElement>(null)

	useLayoutEffect(() => {
		const el = ref.current
		if (!el || pair.old === null) return
		el.classList.remove('is-swapping')
		void el.offsetWidth
		el.classList.add('is-swapping')
		const timer = window.setTimeout(
			() => setPair((p) => ({ old: null, now: p.now })),
			motionMs('--text-soft-dur', 150) + 40,
		)
		return () => window.clearTimeout(timer)
	}, [pair.old, pair.now])

	if (pair.old === null)
		return <span className={cn('tnum', className)}>{pair.now}</span>
	return (
		<span ref={ref} className={cn('t-text-soft tnum', className)}>
			<span className="t-text-soft-old" aria-hidden>
				{pair.old}
			</span>
			<span className="t-text-soft-new">{pair.now}</span>
		</span>
	)
}

/**
 * Stacked lines that arrive with rhythm (texts reveal): the first line, then
 * the next a beat later. Give each child `t-stagger-line` (plus `--2`, `--3`).
 * A new `replay` key plays it again.
 */
export function Stagger({
	children,
	className,
	replay,
}: {
	children: ReactNode
	className?: string
	replay?: string | number
}) {
	const ref = useRef<HTMLDivElement>(null)
	useLayoutEffect(() => {
		const el = ref.current
		if (!el) return
		el.classList.remove('is-shown')
		void el.offsetWidth
		const frame = requestAnimationFrame(() => el.classList.add('is-shown'))
		return () => cancelAnimationFrame(frame)
	}, [replay])
	return (
		<div ref={ref} className={cn('t-stagger', className)}>
			{children}
		</div>
	)
}

export type ToastMessage = {
	id: number
	text: string
	action?: { label: string; run: () => void }
	tone?: 'neutral' | 'danger'
}

/**
 * One toast at a time, rising from the bottom edge (toast): what just happened,
 * and an undo when there is one. It goes by itself after a few seconds, and a
 * newer message replaces it. Announced politely; the action is a real button.
 *
 * It is a manual popover, so it shows in the top layer: above a sheet that is
 * open when it appears, not hidden behind it.
 */
export function Toast({
	message,
	onDone,
	durationMs = 6000,
}: {
	message: ToastMessage | null
	onDone: () => void
	durationMs?: number
}) {
	const { _ } = useLingui()
	const [shown, setShown] = useState<ToastMessage | null>(message)
	const [open, setOpen] = useState(false)
	if (message && message.id !== shown?.id) setShown(message)
	const ref = useRef<HTMLDivElement>(null)
	const layer = useRef<HTMLDivElement>(null)

	// In the top layer while there is something to show (including its way out).
	useLayoutEffect(() => {
		const el = layer.current
		if (!el || typeof el.showPopover !== 'function') return
		const isOpen = el.matches(':popover-open')
		if (shown && !isOpen) el.showPopover()
		else if (!shown && isOpen) el.hidePopover()
	}, [shown])

	useEffect(() => {
		if (!message) {
			setOpen(false)
			return
		}
		void ref.current?.offsetWidth
		const frame = requestAnimationFrame(() => setOpen(true))
		const timer = window.setTimeout(onDone, durationMs)
		return () => {
			cancelAnimationFrame(frame)
			window.clearTimeout(timer)
		}
	}, [message, durationMs, onDone])

	useEffect(() => {
		if (message || !shown) return
		const timer = window.setTimeout(
			() => setShown(null),
			motionMs('--toast-close', 350),
		)
		return () => window.clearTimeout(timer)
	}, [message, shown])

	return (
		<>
			{/* Announced from outside the popover, which is not rendered while closed. */}
			<p role="status" aria-live="polite" className="sr-only">
				{message?.text ?? ''}
			</p>
			<div
				ref={layer}
				popover="manual"
				className="pb-safe pointer-events-none fixed inset-x-0 top-auto bottom-0 z-50 m-0 flex h-auto w-full max-w-none justify-center overflow-visible border-0 bg-transparent p-0 px-4 [&:not(:popover-open)]:hidden"
			>
				{shown ? (
					<div
						ref={ref}
						className={cn(
							't-toast pointer-events-auto flex max-w-lg items-center gap-3 rounded-2xl px-4 py-3 shadow-lg',
							shown.tone === 'danger'
								? 'bg-destructive text-white'
								: 'bg-foreground text-background',
							open && message && 'is-open',
						)}
					>
						<p className="min-w-0 flex-1 text-sm font-medium">{shown.text}</p>
						{shown.action ? (
							<button
								type="button"
								onClick={() => {
									shown.action?.run()
									onDone()
								}}
								className="h-10 shrink-0 rounded-xl px-3 text-sm font-bold underline-offset-4 hover:underline"
							>
								{shown.action.label}
							</button>
						) : null}
						<button
							type="button"
							aria-label={_(t`Dismiss`)}
							onClick={onDone}
							className="-me-1 inline-flex size-10 shrink-0 items-center justify-center rounded-xl opacity-70 hover:opacity-100"
						>
							<X className="size-4" />
						</button>
					</div>
				) : null}
			</div>
		</>
	)
}

/** The till's one celebration: the disc pops and the check draws itself in (success check). */
export function SuccessMark({
	tone = 'success',
	size = 'md',
}: {
	tone?: 'success' | 'muted'
	size?: 'md' | 'lg'
}) {
	return (
		<div
			className={cn(
				't-success-disc flex items-center justify-center rounded-full',
				tone === 'success'
					? 'bg-success text-white'
					: 'bg-muted text-foreground',
				size === 'lg' ? 'size-24' : 'size-20',
			)}
		>
			<span className="t-success-check" data-state="in" aria-hidden>
				<svg
					viewBox="0 0 24 24"
					className={size === 'lg' ? 'size-12' : 'size-10'}
					fill="none"
					stroke="currentColor"
					strokeWidth={3}
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M20 6 9 17l-5-5" />
				</svg>
			</span>
		</div>
	)
}
