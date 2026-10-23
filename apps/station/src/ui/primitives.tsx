import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from 'cn'
import { X } from 'lucide-react'
import {
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type ButtonHTMLAttributes,
	type InputHTMLAttributes,
	type ReactNode,
} from 'react'

/**
 * Class joining with Tailwind conflict resolution, from the `cn` package as
 * across the monorepo (`@repo/ui` re-exports the same). A caller's class wins
 * over a base class for the same property.
 *
 * The components below stay local rather than `@repo/ui`'s: Station is an
 * offline PWA for touch tills, with its own sizes (44 px+ targets), a native
 * `<dialog>` modal that keeps working with no network, and a small bundle.
 */
export { cn }

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger'
	size?: 'md' | 'lg' | 'xl'
}

const buttonBase =
	'inline-flex min-w-0 select-none items-center justify-center gap-2 rounded-xl font-semibold transition active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45'
const buttonVariants = {
	primary: 'bg-primary text-primary-foreground shadow-sm hover:brightness-110',
	secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
	ghost: 'text-foreground hover:bg-accent',
	outline: 'border border-border bg-card text-foreground hover:bg-accent',
	danger: 'bg-destructive text-white hover:brightness-110',
} as const
const buttonSizes = {
	md: 'h-11 px-4 text-sm',
	lg: 'h-14 px-6 text-base',
	xl: 'h-16 px-8 text-lg',
} as const

export function Button({
	variant = 'secondary',
	size = 'md',
	className,
	type = 'button',
	...props
}: ButtonProps) {
	return (
		<button
			type={type}
			className={cn(
				buttonBase,
				buttonVariants[variant],
				buttonSizes[size],
				className,
			)}
			{...props}
		/>
	)
}

export function IconButton({
	label,
	className,
	children,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			className={cn(
				'text-foreground hover:bg-accent inline-flex size-11 shrink-0 items-center justify-center rounded-xl transition active:scale-95 disabled:pointer-events-none disabled:opacity-45',
				className,
			)}
			{...props}
		>
			{children}
		</button>
	)
}

/** Reads a duration token (`150ms` or `0.15s`) from the root, so timers match the CSS. */
export function motionMs(name: string, fallback: number): number {
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue(name)
		.trim()
	const amount = parseFloat(value)
	if (!Number.isFinite(amount) || amount < 0) return fallback
	return /\ds$/.test(value) ? amount * 1000 : amount
}

/**
 * Segmented control used for order type, tender method and list views. The
 * active background is one pill that slides to the chosen option (tabs
 * sliding); it snaps without animating on first paint and on resize.
 */
export function Segmented<T extends string>({
	value,
	onChange,
	options,
	label,
	size = 'md',
	wrap = true,
}: {
	value: T
	onChange: (value: T) => void
	options: Array<{ value: T; label: string; icon?: ReactNode }>
	label: string
	size?: 'md' | 'lg'
	/** Compact filters stay on one line and can sit in a scrolling toolbar. */
	wrap?: boolean
}) {
	const barRef = useRef<HTMLDivElement>(null)
	const pillRef = useRef<HTMLSpanElement>(null)
	const placeRef = useRef<((animate: boolean) => void) | null>(null)
	const placed = useRef(false)

	useLayoutEffect(() => {
		const bar = barRef.current
		const pill = pillRef.current
		if (!bar || !pill) return
		const place = (animate: boolean) => {
			const tab = bar.querySelector<HTMLElement>('[aria-checked="true"]')
			pill.style.visibility = tab ? '' : 'hidden'
			if (!tab) return
			const apply = () => {
				pill.style.transform = `translateX(${tab.offsetLeft}px)`
				pill.style.width = `${tab.offsetWidth}px`
				pill.style.top = `${tab.offsetTop}px`
				pill.style.height = `${tab.offsetHeight}px`
			}
			if (animate) return apply()
			const previous = pill.style.transition
			pill.style.transition = 'none'
			apply()
			void pill.offsetWidth
			pill.style.transition = previous
		}
		placeRef.current = place
		place(placed.current)
		placed.current = true
	}, [value, options])

	useEffect(() => {
		const bar = barRef.current
		if (!bar) return
		// Labels that carry counts change width and fonts load late: follow them
		// without animating. The observer's first call is only its initial report.
		let initial = true
		const observer = new ResizeObserver(() => {
			if (initial) initial = false
			else placeRef.current?.(false)
		})
		observer.observe(bar)
		for (const tab of bar.querySelectorAll('[role="radio"]'))
			observer.observe(tab)
		return () => observer.disconnect()
	}, [options.length])

	return (
		<div
			ref={barRef}
			role="radiogroup"
			aria-label={label}
			className="bg-muted relative isolate flex min-w-0 gap-1 rounded-2xl p-1"
			onKeyDown={(event) => {
				const keys = [
					'ArrowLeft',
					'ArrowRight',
					'ArrowUp',
					'ArrowDown',
					'Home',
					'End',
				]
				if (!keys.includes(event.key)) return
				event.preventDefault()
				const radios = Array.from(
					event.currentTarget.querySelectorAll<HTMLButtonElement>(
						'[role="radio"]',
					),
				)
				const index = radios.indexOf(
					document.activeElement as HTMLButtonElement,
				)
				const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
				const backwards =
					event.key === 'ArrowUp' ||
					event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')
				const next =
					event.key === 'Home'
						? 0
						: event.key === 'End'
							? options.length - 1
							: (index + (backwards ? -1 : 1) + options.length) % options.length
				const option = options[next]
				if (option) {
					onChange(option.value)
					radios[next]?.focus()
				}
			}}
		>
			<span
				ref={pillRef}
				aria-hidden
				className="t-tabs-pill rounded-xl shadow-sm"
			/>
			{options.map((option) => {
				const active = option.value === value
				return (
					<button
						key={option.value}
						type="button"
						role="radio"
						aria-checked={active}
						tabIndex={active ? 0 : -1}
						onClick={() => onChange(option.value)}
						className={cn(
							't-tab relative z-10 inline-flex min-w-0 items-center justify-center gap-2 rounded-xl px-3 font-semibold sm:px-4',
							wrap ? 'flex-1' : 'shrink-0 whitespace-nowrap',
							size === 'lg'
								? 'min-h-14 py-2 text-sm sm:text-base'
								: 'min-h-11 py-2 text-sm',
							active
								? 'text-foreground'
								: 'text-muted-foreground hover:text-foreground',
						)}
					>
						{option.icon ? (
							<span className="shrink-0">{option.icon}</span>
						) : null}
						<span>{option.label}</span>
					</button>
				)
			})}
		</div>
	)
}

/**
 * Modal built on the native <dialog>: focus trap, Escape and top-layer
 * stacking for free, and it works with no JavaScript framework wiring.
 */
export function Modal({
	open,
	onClose,
	title,
	children,
	footer,
	size = 'md',
	dismissible = true,
	scrollable = true,
}: {
	open: boolean
	onClose: () => void
	title: string
	children: ReactNode
	footer?: ReactNode
	size?: 'md' | 'lg' | 'full'
	dismissible?: boolean
	/** Contained layouts (such as the cart) scroll their own content, not their actions. */
	scrollable?: boolean
}) {
	const ref = useRef<HTMLDialogElement>(null)
	const titleId = useId()
	const { _ } = useLingui()
	/**
	 * `entering` is mounted and about to open, `open` is shown, `closing` is
	 * already closed (the till takes taps again at once) but still fading out.
	 */
	const [phase, setPhase] = useState<'entering' | 'open' | 'closing' | 'gone'>(
		open ? 'entering' : 'gone',
	)
	if (open && (phase === 'gone' || phase === 'closing')) setPhase('entering')
	if (!open && (phase === 'entering' || phase === 'open')) setPhase('closing')

	useLayoutEffect(() => {
		const dialog = ref.current
		if (!dialog) return
		if (phase === 'entering') {
			// Reopened while still fading out: it may sit in the top layer a moment longer.
			if (!dialog.open) {
				try {
					dialog.showModal()
				} catch {
					dialog.close()
					dialog.showModal()
				}
			}
			// Paint the resting pre-open state before opening, or there is nothing to animate from.
			void dialog.offsetWidth
			setPhase('open')
		} else if (phase === 'closing') {
			if (dialog.open) dialog.close()
			const timer = window.setTimeout(
				() => setPhase('gone'),
				motionMs('--modal-close-dur', 150),
			)
			return () => window.clearTimeout(timer)
		}
	}, [phase])

	if (phase === 'gone') return null
	const sheet = size === 'full'
	const width = sheet
		? 'h-dvh max-h-none w-screen max-w-none rounded-none'
		: // Phones get a full-screen sheet; larger screens a centred card.
			`max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:max-w-none max-sm:rounded-none ${size === 'lg' ? 'sm:w-[min(56rem,96vw)]' : 'sm:w-[min(34rem,96vw)]'}`

	return (
		<dialog
			ref={ref}
			aria-labelledby={titleId}
			data-sheet={sheet}
			// While it fades out it is already closed: nothing in it can be found or reached.
			aria-hidden={phase === 'closing' || undefined}
			inert={phase === 'closing'}
			onCancel={(event) => {
				event.preventDefault()
				if (dismissible) onClose()
			}}
			onClick={(event) => {
				if (dismissible && event.target === ref.current) onClose()
			}}
			className={cn(
				// Fixed and centred by itself, not by `:modal`, so it holds its place while fading out.
				't-modal border-border bg-card text-card-foreground elevated-sheet fixed inset-0 m-auto flex-col overflow-hidden rounded-2xl border p-0 backdrop:bg-black/40 backdrop:backdrop-blur-xs open:flex',
				phase === 'open' && 'is-open',
				phase === 'closing' && 'is-closing',
				size !== 'full' && 'max-h-[94dvh]',
				!scrollable && size !== 'full' && 'h-[94dvh]',
				width,
			)}
		>
			<header className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
				<h2 id={titleId} className="min-w-0 text-lg font-semibold break-words">
					{title}
				</h2>
				{dismissible ? (
					<IconButton label={_(t`Close`)} onClick={onClose}>
						<X className="size-5" />
					</IconButton>
				) : null}
			</header>
			<div
				className={cn(
					'min-h-0 flex-1',
					scrollable ? 'overflow-y-auto' : 'flex flex-col overflow-hidden',
				)}
			>
				{children}
			</div>
			{footer ? (
				<footer className="border-border bg-card pb-safe shrink-0 border-t px-4 pt-4">
					{footer}
				</footer>
			) : null}
		</dialog>
	)
}

export function Badge({
	children,
	tone = 'muted',
	className,
}: {
	children: ReactNode
	tone?: 'muted' | 'success' | 'warning' | 'danger' | 'primary'
	className?: string
}) {
	const tones = {
		muted: 'bg-muted text-muted-foreground',
		success: 'bg-success/12 text-success',
		warning: 'bg-warning/15 text-warning',
		danger: 'bg-destructive/12 text-destructive',
		primary: 'bg-primary/10 text-primary',
	} as const
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold',
				tones[tone],
				className,
			)}
		>
			{children}
		</span>
	)
}

/** One look for every text field: height, radius, border, focus colour. */
export const fieldClass =
	'border-input bg-background placeholder:text-muted-foreground focus:border-ring h-12 w-full min-w-0 rounded-xl border px-3 text-base font-normal transition-colors'

/**
 * A pressable choice in a row of choices (categories, split, tip, reason). The
 * caller says what "selected" means to assistive technology (`aria-pressed`
 * for a toggle, `aria-current` for navigation).
 */
export function Chip({
	selected,
	size = 'md',
	className,
	type = 'button',
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	selected: boolean
	size?: 'md' | 'lg'
}) {
	return (
		<button
			type={type}
			className={cn(
				'inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border font-semibold transition active:scale-95 disabled:pointer-events-none disabled:opacity-45',
				size === 'lg' ? 'h-12 px-4' : 'h-11 px-3.5 text-sm',
				selected
					? 'border-primary bg-primary text-primary-foreground shadow-sm'
					: 'border-border bg-card hover:bg-accent',
				className,
			)}
			{...props}
		/>
	)
}

/** Strong right-to-left characters: such text is never split into pieces. */
const RTL_TEXT = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/

/**
 * A number that pops its changed digits in when it updates (number pop-in):
 * the characters the old and new value share at the start stay still, the rest
 * rise in. Nothing moves on first paint. Text with right-to-left characters
 * (an Arabic currency) moves as one piece so its bidi order is never split.
 */
export function NumberPop({
	value,
	className,
}: {
	value: string
	className?: string
}) {
	const [shown, setShown] = useState({ value, same: value.length, run: 0 })
	if (shown.value !== value) {
		let same = 0
		while (
			same < shown.value.length &&
			same < value.length &&
			shown.value[same] === value[same]
		)
			same++
		setShown({ value, same, run: shown.run + 1 })
	}
	const rtl = RTL_TEXT.test(value)
	const chars = rtl ? [value] : Array.from(value)
	const last = chars.length - 1
	// The value is one real text node (read aloud and matched as a whole); the
	// moving digits are drawn from attributes, so they add nothing to either.
	return (
		<span className={cn('relative inline-flex', className)}>
			<span className="sr-only">{value}</span>
			<span
				key={shown.run}
				aria-hidden
				dir={rtl ? undefined : 'ltr'}
				className={cn('t-digit-group', shown.run > 0 && 'is-animating')}
			>
				{chars.map((char, i) => (
					<span
						key={i}
						className="t-digit"
						data-char={char}
						data-same={!rtl && i < shown.same ? '' : undefined}
						data-stagger={i === last ? '2' : i === last - 1 ? '1' : undefined}
					/>
				))}
			</span>
		</span>
	)
}

/**
 * Shows and hides a block by growing and shrinking its height (accordion
 * expand), for banners that come and go above the till. What was showing
 * stays while it closes. Present on first paint means no animation.
 */
export function Reveal({
	open,
	children,
}: {
	open: boolean
	children: ReactNode
}) {
	const [phase, setPhase] = useState<'entering' | 'open' | 'closing' | 'gone'>(
		open ? 'open' : 'gone',
	)
	if (open && (phase === 'gone' || phase === 'closing')) setPhase('entering')
	if (!open && (phase === 'entering' || phase === 'open')) setPhase('closing')
	const [kept, setKept] = useState(children)
	if (open && kept !== children) setKept(children)
	const ref = useRef<HTMLDivElement>(null)

	useLayoutEffect(() => {
		if (phase === 'entering') {
			void ref.current?.offsetHeight
			setPhase('open')
		} else if (phase === 'closing') {
			const timer = window.setTimeout(
				() => setPhase('gone'),
				motionMs('--acc-collapse', 250),
			)
			return () => window.clearTimeout(timer)
		}
	}, [phase])

	if (phase === 'gone') return null
	return (
		<div
			ref={ref}
			className="t-acc shrink-0"
			data-open={phase === 'open'}
			aria-hidden={phase === 'closing' || undefined}
			inert={phase === 'closing'}
		>
			<div className="t-acc-panel">
				<div className="t-acc-panel-inner">{open ? children : kept}</div>
			</div>
		</div>
	)
}

/**
 * A native checkbox drawn as a box that fills, then strokes its check in
 * (checkbox check). The real input sits on top, invisible, so labels, forms,
 * keyboard and assistive technology all see an ordinary checkbox.
 */
export function Checkbox({
	className,
	checked,
	...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'checked'> & {
	checked: boolean
}) {
	return (
		<span className={cn('relative inline-flex size-6 shrink-0', className)}>
			<input
				type="checkbox"
				checked={checked}
				className="peer absolute inset-0 m-0 size-full cursor-pointer appearance-none rounded-sm opacity-0"
				{...props}
			/>
			<span
				aria-hidden
				data-checked={checked}
				className="t-check border-input bg-card text-primary-foreground peer-focus-visible:outline-ring peer-checked:border-primary peer-checked:bg-primary pointer-events-none flex size-full items-center justify-center rounded-sm border-2 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2"
			>
				<svg
					viewBox="0 0 10.1668 10.1668"
					className="size-3.5"
					fill="none"
					stroke="currentColor"
					strokeWidth={1.8}
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M1 5.52L3.92 9.17L9.17 1" />
				</svg>
			</span>
		</span>
	)
}
