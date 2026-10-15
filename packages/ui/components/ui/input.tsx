import { Input as InputPrimitive } from '@base-ui/react/input'
import * as React from 'react'

import { cn } from '../../lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
	return (
		<InputPrimitive
			type={type}
			data-slot="input"
			className={cn(
				'bg-card border-input focus-visible:border-primary focus-visible:ring-primary/12 dark:focus-visible:ring-primary/20 aria-invalid:ring-destructive/15 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 disabled:bg-muted file:text-foreground placeholder:text-muted-foreground h-8 w-full min-w-0 rounded-md border px-2.5 py-1 text-base [color-scheme:light] transition-[border-color,box-shadow] duration-150 outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium hover:border-[color-mix(in_oklab,var(--input)_60%,var(--muted-foreground))] focus-visible:ring-[3px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-[3px] md:text-sm dark:[color-scheme:dark] [&::-webkit-calendar-picker-indicator]:cursor-pointer',
				className,
			)}
			{...props}
		/>
	)
}

export { Input }
