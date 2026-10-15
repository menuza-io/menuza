import * as React from 'react'

import { cn } from '../../lib/utils'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				'bg-card border-input focus-visible:border-primary focus-visible:ring-primary/12 dark:focus-visible:ring-primary/20 aria-invalid:ring-destructive/15 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 disabled:bg-muted placeholder:text-muted-foreground flex field-sizing-content min-h-20 w-full rounded-md border px-2.5 py-1.5 text-base transition-[border-color,box-shadow] duration-150 outline-none hover:border-[color-mix(in_oklab,var(--input)_60%,var(--muted-foreground))] focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-[3px] md:text-sm',
				className,
			)}
			{...props}
		/>
	)
}

export { Textarea }
