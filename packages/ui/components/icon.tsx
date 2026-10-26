import { type SVGProps } from 'react'
import { cn } from '../lib/utils'
import { type IconName } from './icons/icon-name'
import spriteUrl from './icons/sprite.svg?url'

const sizeClassName = {
	font: 'w-[1em] h-[1em]',
	xs: 'size-3',
	sm: 'size-4',
	md: 'size-6',
	lg: 'size-8',
	xl: 'size-12',
} as const

export type IconSize = keyof typeof sizeClassName

const childrenSizeClassName = {
	font: 'gap-1.5',
	xs: 'gap-1.5',
	sm: 'gap-1.5',
	md: 'gap-2',
	lg: 'gap-2',
	xl: 'gap-3',
} satisfies Record<IconSize, string>

interface IconProps extends SVGProps<SVGSVGElement> {
	name: IconName // Use generated IconName type
	size?: IconSize
	title?: string
}

/**
 * Icon component that uses the generated sprite from the UI package.
 *
 * Renders an SVG icon. The icon defaults to the size of the font. To make it
 * align vertically with neighboring text, you can pass the text as a child of
 * the icon and it will be automatically aligned.
 *
 * Pass `title` prop to the `Icon` component to get `<title>` element rendered
 * in the SVG container for accessibility.
 */
export function Icon({
	name,
	size = 'font',
	className,
	title,
	children,
	'aria-label': ariaLabel,
	'aria-labelledby': ariaLabelledBy,
	'aria-hidden': ariaHidden,
	focusable,
	...props
}: IconProps) {
	if (children) {
		return (
			<span
				className={cn('inline-flex items-center', childrenSizeClassName[size])}
			>
				<Icon
					name={name}
					size={size}
					className={className}
					title={title}
					aria-label={ariaLabel}
					aria-labelledby={ariaLabelledBy}
					aria-hidden={ariaHidden}
					focusable={focusable}
					{...props}
				/>
				{children}
			</span>
		)
	}

	const isDecorative = !title && !ariaLabel && !ariaLabelledBy
	const defaultAriaHidden = isDecorative ? 'true' : undefined
	const defaultFocusable = isDecorative ? 'false' : undefined

	return (
		<svg
			aria-hidden={ariaHidden ?? defaultAriaHidden}
			focusable={focusable ?? defaultFocusable}
			aria-label={ariaLabel}
			aria-labelledby={ariaLabelledBy}
			{...props}
			className={cn(sizeClassName[size], 'inline self-center', className)}
		>
			{title ? <title>{title}</title> : null}
			<use href={`${spriteUrl}#${name}`} />
		</svg>
	)
}

export type { IconName }
