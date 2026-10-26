import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge as SharedBadge } from '@repo/ui/badge'
import { Button as SharedButton } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input as SharedInput } from '@repo/ui/input'
import { cn } from 'cn'
import {
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type ButtonHTMLAttributes,
	type InputHTMLAttributes,
	type HTMLAttributes,
	type ReactNode,
	type Ref,
	type SelectHTMLAttributes,
} from 'react'

/**
 * Class joining with Tailwind conflict resolution, from the `cn` package as
 * across the monorepo (`@repo/ui` re-exports the same). A caller's class wins
 * over a base class for the same property.
 *
 * Shared controls carry the design-system behavior; these thin adapters keep
 * Station's 44px+ touch targets. Dialog and select remain native controls.
 */
export { cn }

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger'
	size?: 'md' | 'lg' | 'xl'
}

const buttonVariants = {
	primary: 'default',
	secondary: 'secondary',
	ghost: 'ghost',
	outline: 'outline',
	danger: 'destructive',
} as const

export function Button({
	variant = 'secondary',
	size = 'md',
	className,
	type = 'button',
	...props
}: ButtonProps) {
	return (
		<SharedButton
			type={type}
			variant={buttonVariants[variant]}
			size="lg"
			data-autofocus={props.autoFocus ? '' : undefined}
			className={cn(
				'min-w-0 gap-2 rounded-(--station-control-radius) whitespace-normal shadow-none after:hidden',
				size === 'xl'
					? 'h-16 px-6 text-base'
					: size === 'lg'
						? 'h-14 px-6 text-base'
						: 'h-11 px-4 text-sm',
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
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	label: string
	ref?: Ref<HTMLButtonElement>
}) {
	return (
		<SharedButton
			type="button"
			variant="ghost"
			size="icon-lg"
			aria-label={label}
			title={label}
			className={cn(
				'text-muted-foreground size-11 rounded-(--station-control-radius) after:hidden',
				className,
			)}
			{...props}
		>
			{children}
		</SharedButton>
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
	iconsOnPhone = false,
}: {
	value: T
	onChange: (value: T) => void
	options: Array<{ value: T; label: string; icon?: ReactNode }>
	label: string
	size?: 'md' | 'lg'
	/** Compact filters stay on one line and can sit in a scrolling toolbar. */
	wrap?: boolean
	/** On a phone, options with an icon show only the icon (the name is still read out). */
	iconsOnPhone?: boolean
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
			className="bg-muted relative isolate flex min-w-0 gap-1 rounded-(--station-group-radius) px-1"
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
				className="t-tabs-pill rounded-(--station-control-radius)"
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
							't-tab relative z-10 inline-flex min-w-11 items-center justify-center gap-2 rounded-(--station-control-radius) px-3 font-semibold sm:px-4',
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
						<span
							className={cn(iconsOnPhone && option.icon && 'max-md:sr-only')}
						>
							{option.label}
						</span>
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
	const returnFocus = useRef<HTMLElement | null>(null)
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
				const active = document.activeElement
				if (active instanceof HTMLElement && !dialog.contains(active))
					returnFocus.current = active
				try {
					dialog.showModal()
				} catch {
					dialog.close()
					dialog.showModal()
				}
				// React focuses `autoFocus` before the dialog is open; opening then moves
				// focus to its first control (Close). Put it back where the sheet asked.
				dialog
					.querySelector<HTMLElement>('[data-autofocus]')
					?.focus({ preventScroll: true })
			}
			// Paint the resting pre-open state before opening, or there is nothing to animate from.
			void dialog.offsetWidth
			setPhase('open')
		} else if (phase === 'closing') {
			if (dialog.open) dialog.close()
			if (returnFocus.current?.isConnected)
				returnFocus.current.focus({ preventScroll: true })
			const timer = window.setTimeout(
				() => setPhase('gone'),
				motionMs('--modal-close-dur', 150),
			)
			return () => window.clearTimeout(timer)
		}
	}, [phase])

	// Many task sheets unmount immediately after closing. Close before removal,
	// while the native dialog can still return focus to its opening control.
	const mounted = phase !== 'gone'
	useLayoutEffect(() => {
		const dialog = ref.current
		return () => {
			if (!dialog?.open) return
			dialog.close()
			if (returnFocus.current?.isConnected)
				returnFocus.current.focus({ preventScroll: true })
		}
	}, [mounted])

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
				't-modal bg-card text-card-foreground elevated-sheet fixed inset-0 m-auto flex-col overflow-hidden rounded-(--station-panel-radius) p-0 backdrop:bg-black/40 open:flex',
				phase === 'open' && 'is-open',
				phase === 'closing' && 'is-closing',
				size !== 'full' && 'max-h-[94dvh]',
				!scrollable && size !== 'full' && 'h-[94dvh]',
				width,
			)}
		>
			<header className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
				<h2 id={titleId} className="min-w-0 text-xl font-semibold break-words">
					{title}
				</h2>
				{dismissible ? (
					<IconButton label={_(t`Close`)} onClick={onClose}>
						<Icon name="x" className="size-5" />
					</IconButton>
				) : null}
			</header>
			<div
				className={cn(
					'min-h-0 flex-1',
					scrollable
						? 'overflow-y-auto overscroll-contain'
						: 'flex flex-col overflow-hidden',
				)}
			>
				{children}
			</div>
			{footer ? (
				<footer className="border-border bg-card pb-safe shrink-0 border-t px-4 pt-4 sm:px-5">
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
	...props
}: HTMLAttributes<HTMLSpanElement> & {
	tone?: 'muted' | 'success' | 'warning' | 'danger' | 'primary'
}) {
	const tones = {
		muted: 'secondary',
		success: 'success',
		warning: 'warning',
		danger: 'destructive',
		primary: 'default',
	} as const
	return (
		<SharedBadge
			variant={tones[tone]}
			className={cn(
				'h-auto min-h-5 rounded-(--station-control-radius) px-2 py-0.5 whitespace-normal',
				className,
			)}
			{...props}
		>
			{children}
		</SharedBadge>
	)
}

/** One look for every text field: height, radius, border, focus colour. */
export const fieldClass =
	'border-input bg-card placeholder:text-muted-foreground focus:border-ring h-12 w-full min-w-0 rounded-(--station-control-radius) border px-3 text-base font-normal transition-colors'

export function Input({
	className,
	...props
}: InputHTMLAttributes<HTMLInputElement>) {
	return (
		<SharedInput
			data-autofocus={props.autoFocus ? '' : undefined}
			className={cn(
				'h-12 rounded-(--station-control-radius) px-3 text-base font-normal md:text-base',
				className,
			)}
			{...props}
		/>
	)
}

/** Native choices and keyboard behavior, with the same chevron as every other control. */
export function Select({
	className,
	containerClassName,
	ref,
	...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
	ref?: Ref<HTMLSelectElement>
	containerClassName?: string
}) {
	const listbox = props.multiple || (props.size !== undefined && props.size > 1)
	return (
		<span
			dir={props.dir}
			className={cn('relative inline-grid w-full min-w-0', containerClassName)}
		>
			<select
				ref={ref}
				className={cn(
					fieldClass,
					'peer disabled:opacity-60',
					!listbox && 'appearance-none pe-10',
					className,
				)}
				{...props}
			/>
			{!listbox ? (
				<Icon
					name="chevron-down"
					className="text-muted-foreground pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 peer-disabled:opacity-45"
				/>
			) : null}
		</span>
	)
}

/**
 * A pressable choice in a row of choices (categories, split, tip, reason). The
 * caller says what "selected" means to assistive technology (`aria-pressed`
 * for a toggle, `aria-current` for navigation).
 */
export function Chip({
	selected,
	size = 'md',
	look = 'quiet',
	className,
	type = 'button',
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	selected: boolean
	size?: 'md' | 'lg'
	/**
	 * `quiet` is borderless and navigates (categories, filters). `outlined` is
	 * for choosing a value in a form (tip, split, quick cash): the same outline
	 * as a secondary button, and the brand-tinted selection of a readout.
	 * `filled` is the register's menu categories: a card that turns solid brand
	 * when chosen, so the section in view reads from across the counter.
	 */
	look?: 'quiet' | 'outlined' | 'filled'
}) {
	return (
		<Button
			type={type}
			variant={look === 'quiet' ? 'ghost' : 'outline'}
			className={cn(
				size === 'lg' ? 'h-11 px-4' : 'h-11 px-3.5 text-sm',
				look === 'filled'
					? selected
						? 'border-primary bg-primary text-primary-foreground hover:bg-primary font-semibold shadow-sm'
						: 'border-border bg-card text-foreground hover:bg-accent font-semibold'
					: look === 'outlined'
						? selected
							? 'border-primary bg-primary/5 text-foreground'
							: 'text-foreground'
						: selected
							? 'bg-secondary text-secondary-foreground'
							: 'text-muted-foreground',
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
 * A native checkbox drawn as a box that fills, then reveals its shared check
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
				className="peer absolute inset-0 m-0 size-full cursor-pointer appearance-none rounded-xs opacity-0"
				{...props}
			/>
			<span
				aria-hidden
				data-checked={checked}
				className="t-check border-input bg-card text-primary-foreground peer-focus-visible:outline-ring peer-checked:border-primary peer-checked:bg-primary pointer-events-none flex size-full items-center justify-center rounded-xs border-2 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2"
			>
				<Icon name="check" className="size-3.5" />
			</span>
		</span>
	)
}
