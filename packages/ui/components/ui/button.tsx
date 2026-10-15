import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '../../lib/utils'

const buttonVariants = cva(
	"focus-visible:border-ring focus-visible:ring-ring aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 group/button ease-out-quint inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding text-[13px] font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] duration-150 outline-none select-none focus-visible:ring-[3px] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 in-data-[slot=button-group]:rounded-md aria-invalid:ring-[3px] motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default:
					'bg-primary text-primary-foreground shadow-[inset_0_-1px_0_oklch(0_0_0/12%)] hover:bg-[color-mix(in_oklab,var(--primary)_88%,var(--foreground))] active:bg-[color-mix(in_oklab,var(--primary)_78%,var(--foreground))]',
				outline:
					'border-border-strong bg-card text-foreground hover:bg-muted active:bg-accent aria-expanded:bg-muted dark:bg-card dark:hover:bg-muted shadow-xs',
				secondary:
					'bg-secondary text-secondary-foreground hover:bg-accent aria-expanded:bg-accent',
				ghost:
					'hover:bg-muted hover:text-foreground active:bg-accent aria-expanded:bg-accent aria-expanded:text-foreground dark:hover:bg-accent',
				destructive:
					'bg-destructive/10 text-destructive hover:bg-destructive/15 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/15 dark:hover:bg-destructive/25 dark:focus-visible:ring-destructive/40',
				link: 'text-primary underline-offset-4 hover:underline active:scale-100',
			},
			size: {
				default:
					'relative h-8 gap-1.5 px-3 after:absolute after:-inset-1.5 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5 md:after:hidden',
				xs: "relative h-6 gap-1 px-2 text-xs after:absolute after:-inset-2.5 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 md:after:hidden [&_svg:not([class*='size-'])]:size-3.5",
				sm: "relative h-7 gap-1.5 px-2.5 after:absolute after:-inset-2 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 md:after:hidden [&_svg:not([class*='size-'])]:size-4",
				lg: 'h-9 gap-2 px-3.5 text-sm has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3',
				icon: 'relative size-8 after:absolute after:-inset-1.5 md:after:hidden',
				'icon-xs':
					"relative size-6 after:absolute after:-inset-2.5 md:after:hidden [&_svg:not([class*='size-'])]:size-3.5",
				'icon-sm':
					'relative size-7 after:absolute after:-inset-2 md:after:hidden',
				'icon-lg': 'size-9',
			},
		},
		defaultVariants: {
			variant: 'default',
			size: 'default',
		},
	},
)

function Button({
	className,
	variant = 'default',
	size = 'default',
	nativeButton,
	...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
	let resolvedNativeButton = nativeButton
	if (
		resolvedNativeButton === undefined &&
		React.isValidElement(props.render)
	) {
		resolvedNativeButton = props.render.type === 'button'
	}
	return (
		<ButtonPrimitive
			data-slot="button"
			className={cn(buttonVariants({ variant, size, className }))}
			nativeButton={resolvedNativeButton}
			{...props}
		/>
	)
}

export { Button, buttonVariants }
