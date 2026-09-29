import * as React from 'react'

import { cn } from '../../lib/utils'

type TableVariant = 'default' | 'card'

function Table({
	className,
	variant = 'default',
	...props
}: React.ComponentProps<'table'> & { variant?: TableVariant }) {
	return (
		<div
			data-slot="table-container"
			data-variant={variant}
			className="relative w-full overflow-x-auto"
		>
			<table
				data-slot="table"
				className={cn(
					'w-full caption-bottom text-sm',
					'in-data-[variant=card]:border-separate in-data-[variant=card]:border-spacing-0',
					className,
				)}
				{...props}
			/>
		</div>
	)
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
	return (
		<thead
			data-slot="table-header"
			className={cn('[&_tr]:border-b', className)}
			{...props}
		/>
	)
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
	return (
		<tbody
			data-slot="table-body"
			className={cn(
				'relative [&_tr:last-child]:border-0',
				'in-data-[variant=card]:rounded-sm in-data-[variant=card]:shadow-xs/5',
				'before:pointer-events-none before:absolute before:inset-px not-in-data-[variant=card]:before:hidden',
				'before:rounded-sm before:shadow-[0_1px_--theme(--color-black/4%)]',
				'dark:before:shadow-[0_-1px_--theme(--color-white/8%)]',
				'in-data-[variant=card]:*:[tr]:border-0',
				'in-data-[variant=card]:*:[tr]:*:[td]:border-b',
				'in-data-[variant=card]:*:[tr]:*:[td]:bg-background',
				'in-data-[variant=card]:*:[tr]:first:*:[td]:first:rounded-ss-sm',
				'in-data-[variant=card]:*:[tr]:*:[td]:first:border-s',
				'in-data-[variant=card]:*:[tr]:first:*:[td]:border-t',
				'in-data-[variant=card]:*:[tr]:last:*:[td]:last:rounded-ee-sm',
				'in-data-[variant=card]:*:[tr]:*:[td]:last:border-e',
				'in-data-[variant=card]:*:[tr]:first:*:[td]:last:rounded-se-sm',
				'in-data-[variant=card]:*:[tr]:last:*:[td]:first:rounded-es-sm',
				'in-data-[variant=card]:*:[tr]:hover:*:[td]:bg-[color-mix(in_srgb,var(--card),var(--color-black)_2%)]',
				'in-data-[variant=card]:*:[tr]:data-[state=selected]:*:[td]:bg-[color-mix(in_srgb,var(--card),var(--color-black)_4%)]',
				'dark:in-data-[variant=card]:*:[tr]:data-[state=selected]:*:[td]:bg-[color-mix(in_srgb,var(--card),var(--color-white)_4%)]',
				'dark:in-data-[variant=card]:*:[tr]:hover:*:[td]:bg-[color-mix(in_srgb,var(--card),var(--color-white)_2%)]',
				className,
			)}
			{...props}
		/>
	)
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
	return (
		<tfoot
			data-slot="table-footer"
			className={cn(
				'border-t font-medium [&>tr]:last:border-b-0',
				'not-in-data-[variant=card]:bg-muted/50',
				'in-data-[variant=card]:border-none in-data-[variant=card]:bg-transparent',
				className,
			)}
			{...props}
		/>
	)
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
	return (
		<tr
			data-slot="table-row"
			className={cn(
				'border-b',
				'not-in-data-[variant=card]:hover:bg-muted/50',
				'not-in-data-[variant=card]:data-[state=selected]:bg-muted',
				'not-in-data-[variant=card]:transition-colors',
				className,
			)}
			{...props}
		/>
	)
}

function TableHead({
	className,
	scope = 'col',
	...props
}: React.ComponentProps<'th'>) {
	return (
		<th
			data-slot="table-head"
			scope={scope}
			className={cn(
				'h-10 px-2 text-left align-middle font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0',
				'not-in-data-[variant=card]:text-foreground',
				'in-data-[variant=card]:text-muted-foreground in-data-[variant=card]:px-2.5 in-data-[variant=card]:leading-none',
				className,
			)}
			{...props}
		/>
	)
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
	return (
		<td
			data-slot="table-cell"
			className={cn(
				'p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0',
				'in-data-[variant=card]:bg-clip-padding in-data-[variant=card]:p-2.5 in-data-[variant=card]:leading-none',
				'in-data-[slot=table-footer]:py-3.5',
				'in-data-[variant=card]:first:ps-[calc(--spacing(2.5)-1px)]',
				'in-data-[variant=card]:last:pe-[calc(--spacing(2.5)-1px)]',
				className,
			)}
			{...props}
		/>
	)
}

function TableCaption({
	className,
	...props
}: React.ComponentProps<'caption'>) {
	return (
		<caption
			data-slot="table-caption"
			className={cn(
				'text-muted-foreground mt-4 text-sm',
				'in-data-[variant=card]:my-4',
				className,
			)}
			{...props}
		/>
	)
}

function TableSpacer({ colSpan = 1 }: { colSpan?: number }) {
	return (
		<tbody aria-hidden="true" data-slot="table-spacer">
			<tr className="h-3">
				<td colSpan={colSpan} className="h-3 border-0 bg-transparent p-0" />
			</tr>
		</tbody>
	)
}

export {
	Table,
	TableHeader,
	TableBody,
	TableFooter,
	TableHead,
	TableRow,
	TableCell,
	TableCaption,
	TableSpacer,
}
