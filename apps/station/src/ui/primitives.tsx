import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { X } from 'lucide-react'
import {
	useEffect,
	useId,
	useRef,
	type ButtonHTMLAttributes,
	type ReactNode,
} from 'react'

export const cn = (...parts: Array<string | false | null | undefined>) =>
	parts.filter(Boolean).join(' ')

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

/** Segmented control used for order type and tender method. */
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
	return (
		<div
			role="radiogroup"
			aria-label={label}
			className="bg-muted flex min-w-0 gap-1 rounded-2xl p-1"
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
							'inline-flex min-w-0 items-center justify-center gap-2 rounded-xl px-3 font-semibold transition sm:px-4',
							wrap ? 'flex-1' : 'shrink-0 whitespace-nowrap',
							size === 'lg'
								? 'min-h-14 py-2 text-sm sm:text-base'
								: 'min-h-11 py-2 text-sm',
							active
								? 'bg-card text-foreground shadow-sm'
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

	useEffect(() => {
		const dialog = ref.current
		if (!dialog) return
		if (open && !dialog.open) dialog.showModal()
		if (!open && dialog.open) dialog.close()
	}, [open])

	if (!open) return null
	const width =
		size === 'full'
			? 'h-dvh max-h-none w-screen max-w-none rounded-none'
			: // Phones get a full-screen sheet; larger screens a centred card.
				`max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:max-w-none max-sm:rounded-none ${size === 'lg' ? 'sm:w-[min(56rem,96vw)]' : 'sm:w-[min(34rem,96vw)]'}`

	return (
		<dialog
			ref={ref}
			aria-labelledby={titleId}
			onCancel={(event) => {
				event.preventDefault()
				if (dismissible) onClose()
			}}
			onClick={(event) => {
				if (dismissible && event.target === ref.current) onClose()
			}}
			className={cn(
				'anim-sheet border-border bg-card text-card-foreground elevated-sheet m-auto flex flex-col overflow-hidden rounded-2xl border p-0 backdrop:bg-black/40 backdrop:backdrop-blur-xs',
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
