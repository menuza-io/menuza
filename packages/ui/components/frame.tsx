import type * as React from 'react'

import { cn } from './../lib/utils'

function Frame({
	className,
	variant = 'default',
	// Kept for API compatibility: panels are always hairline-stacked now.
	stackedPanels: ignoredStackedPanels = false,
	...props
}: React.ComponentProps<'div'> & {
	/**
	 * `default`: one bordered surface with hairline-separated sections.
	 * `inset`: a tinted shell holding raised panels (e.g. flow-editor nodes).
	 */
	variant?: 'default' | 'inset'
	stackedPanels?: boolean
}) {
	return (
		<div
			className={cn(
				variant === 'inset'
					? 'bg-muted/50 relative flex flex-col rounded-lg p-1 *:[[data-slot=frame-panel]+[data-slot=frame-panel]]:mt-1'
					: 'bg-card shadow-card relative flex flex-col overflow-hidden rounded-xl border *:[[data-slot=frame-panel-header]+[data-slot=frame-panel]]:border-t *:[[data-slot=frame-panel]+[data-slot=frame-panel]]:border-t',
				className,
			)}
			data-slot="frame"
			data-frame-variant={variant}
			{...props}
		/>
	)
}

function FramePanel({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			className={cn(
				'relative p-5',
				'in-data-[frame-variant=inset]:bg-card in-data-[frame-variant=inset]:rounded-md in-data-[frame-variant=inset]:border in-data-[frame-variant=inset]:shadow-xs',
				className,
			)}
			data-slot="frame-panel"
			{...props}
		/>
	)
}

function FrameHeader({ className, ...props }: React.ComponentProps<'header'>) {
	return (
		<header
			className={cn(
				'@container/frame-header grid auto-rows-min items-start gap-1 px-5 py-4 has-data-[slot=frame-action]:grid-cols-[1fr_auto] has-data-[slot=frame-description]:grid-rows-[auto_auto]',
				className,
			)}
			data-slot="frame-panel-header"
			{...props}
		/>
	)
}

function FrameTitle({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			className={cn('text-sm', className)}
			data-slot="frame-panel-title"
			{...props}
		/>
	)
}

function FrameDescription({
	className,
	...props
}: React.ComponentProps<'div'>) {
	return (
		<div
			className={cn('text-muted-foreground text-sm', className)}
			data-slot="frame-panel-description"
			{...props}
		/>
	)
}

function FrameAction({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			className={cn(
				'col-start-2 row-span-2 row-start-1 self-start justify-self-end',
				className,
			)}
			data-slot="frame-action"
			{...props}
		/>
	)
}

function FrameFooter({ className, ...props }: React.ComponentProps<'footer'>) {
	return (
		<footer
			className={cn('flex flex-col gap-1 px-5 py-4', className)}
			data-slot="frame-panel-footer"
			{...props}
		/>
	)
}

export {
	Frame,
	FramePanel,
	FrameHeader,
	FrameTitle,
	FrameDescription,
	FrameAction,
	FrameFooter,
}
