'use client'

import { t } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { Textarea } from '@repo/ui/textarea'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'

import React, {
	type ComponentProps,
	type HTMLAttributes,
	type KeyboardEventHandler,
	Children,
} from 'react'

import { cn } from '@repo/ui'
type ChatStatus = 'idle' | 'submitted' | 'streaming' | 'error'

export type PromptInputProps = HTMLAttributes<HTMLFormElement>

export const PromptInput = ({ className, ...props }: PromptInputProps) => (
	<form
		className={cn(
			'bg-card w-full divide-y overflow-hidden rounded-xl border shadow-xs',
			className,
		)}
		{...props}
	/>
)

export type PromptInputTextareaProps = ComponentProps<typeof Textarea> & {
	_minHeight?: number
	_maxHeight?: number
}

export const PromptInputTextarea = ({
	onChange,
	className,
	placeholder,
	_minHeight = 48,
	_maxHeight = 164,
	...props
}: PromptInputTextareaProps) => {
	const { _ } = useLingui()
	const defaultPlaceholder = _(t`What would you like to know?`)

	const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
		if (e.key === 'Enter') {
			if (e.shiftKey) {
				// Allow newline
				return
			}

			// Submit on Enter (without Shift)
			e.preventDefault()
			const form = e.currentTarget.form
			if (form) {
				form.requestSubmit()
			}
		}
	}

	return (
		<Textarea
			className={cn(
				'w-full resize-none rounded-none border-none p-3 shadow-none ring-0 outline-none',
				'field-sizing-content max-h-[6lh] bg-transparent dark:bg-transparent',
				'focus-visible:ring-0',
				className,
			)}
			name="message"
			onChange={(e) => {
				onChange?.(e)
			}}
			onKeyDown={handleKeyDown}
			placeholder={placeholder ?? defaultPlaceholder}
			{...props}
		/>
	)
}

export type PromptInputToolbarProps = HTMLAttributes<HTMLDivElement>

export const PromptInputToolbar = ({
	className,
	...props
}: PromptInputToolbarProps) => (
	<div
		className={cn('flex items-center justify-between p-1', className)}
		{...props}
	/>
)

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>

export const PromptInputTools = ({
	className,
	...props
}: PromptInputToolsProps) => (
	<div
		className={cn(
			'flex items-center gap-1',
			'[&_button:first-child]:rounded-bl-xl',
			className,
		)}
		{...props}
	/>
)

export type PromptInputButtonProps = ComponentProps<typeof Button>

export const PromptInputButton = ({
	variant = 'ghost',
	className,
	size,
	nativeButton: _ignoredNativeButton,
	...props
}: PromptInputButtonProps) => {
	const newSize =
		(size ?? Children.count(props.children) > 1) ? 'default' : 'icon'

	return (
		<Button
			className={cn(
				'shrink-0 gap-1.5 rounded-lg',
				variant === 'ghost' && 'text-muted-foreground',
				newSize === 'default' && 'px-3',
				className,
			)}
			nativeButton
			size={newSize}
			type="button"
			variant={variant}
			{...props}
		/>
	)
}

export type PromptInputSubmitProps = ComponentProps<typeof Button> & {
	status?: ChatStatus
}

export const PromptInputSubmit = ({
	className,
	variant = 'default',
	size = 'icon',
	status,
	children,
	nativeButton: _ignoredNativeButton,
	...props
}: PromptInputSubmitProps) => {
	const { _ } = useLingui()
	let iconElement = <Icon name="send" className="size-4" />
	let ariaLabel = _(t`Send message`)

	if (status === 'submitted') {
		iconElement = <Icon name="loader" className="size-4 animate-spin" />
		ariaLabel = _(t`Sending message`)
	} else if (status === 'streaming') {
		iconElement = <Icon name="ban" className="size-4" />
		ariaLabel = _(t`Stop generation`)
	} else if (status === 'error') {
		iconElement = <Icon name="x" className="size-4" />
		ariaLabel = _(t`Retry`)
	}

	return (
		<Button
			aria-label={ariaLabel}
			className={cn('gap-1.5 rounded-lg', className)}
			nativeButton
			size={size}
			type="submit"
			variant={variant}
			{...props}
		>
			{children ?? iconElement}
		</Button>
	)
}

export type PromptInputModelSelectProps = ComponentProps<typeof Select>

export const PromptInputModelSelect = (props: PromptInputModelSelectProps) => (
	<Select {...props} />
)

export type PromptInputModelSelectTriggerProps = ComponentProps<
	typeof SelectTrigger
>

export const PromptInputModelSelectTrigger = ({
	className,
	...props
}: PromptInputModelSelectTriggerProps) => (
	<SelectTrigger
		className={cn(
			'text-muted-foreground border-none bg-transparent font-medium shadow-none transition-colors',
			'hover:bg-accent hover:text-foreground [&[aria-expanded="true"]]:bg-accent [&[aria-expanded="true"]]:text-foreground',
			className,
		)}
		{...props}
	/>
)

export type PromptInputModelSelectContentProps = ComponentProps<
	typeof SelectContent
>

export const PromptInputModelSelectContent = ({
	className,
	...props
}: PromptInputModelSelectContentProps) => (
	<SelectContent className={cn(className)} {...props} />
)

export type PromptInputModelSelectItemProps = ComponentProps<typeof SelectItem>

export const PromptInputModelSelectItem = ({
	className,
	...props
}: PromptInputModelSelectItemProps) => (
	<SelectItem className={cn(className)} {...props} />
)

export type PromptInputModelSelectValueProps = ComponentProps<
	typeof SelectValue
>

export const PromptInputModelSelectValue = ({
	className,
	...props
}: PromptInputModelSelectValueProps) => (
	<SelectValue className={cn(className)} {...props} />
)
