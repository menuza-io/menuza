import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import type * as React from 'react'
import { Link } from 'react-router'
import { LocaleSwitcher } from '#app/components/website/locale-fields.tsx'

export interface MenuFormHeaderProps {
	pageTitle: React.ReactNode
	backHref: string
	backLabel: string
	saveButtonText: React.ReactNode
	isSubmitting?: boolean
	titleAccessory?: React.ReactNode
	headerControls?: React.ReactNode
	secondaryAction?: React.ReactNode
	showCancel?: boolean
	submitName?: string
	submitValue?: string
}

export function MenuFormHeader({
	pageTitle,
	backHref,
	backLabel,
	saveButtonText,
	isSubmitting = false,
	titleAccessory,
	headerControls,
	secondaryAction,
	showCancel = true,
	submitName,
	submitValue,
}: MenuFormHeaderProps) {
	return (
		<header className="border-border bg-background/95 sticky top-0 z-20 w-full border-b backdrop-blur-sm">
			<div
				className={
					headerControls
						? 'mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-2.5 sm:py-3.5 md:px-6 lg:px-8'
						: 'mx-auto flex w-full max-w-6xl flex-col gap-2.5 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:py-3.5 md:px-6 lg:px-8'
				}
			>
				<div
					className={
						headerControls
							? 'mr-auto flex min-w-0 items-center gap-2.5'
							: 'flex min-w-0 items-center gap-2.5'
					}
				>
					<Button
						type="button"
						variant="secondary"
						size="icon-sm"
						render={<Link to={backHref} />}
						aria-label={backLabel}
						className="size-8 shrink-0"
					>
						<Icon name="arrow-left" className="size-4" />
					</Button>
					<h1 className="text-foreground truncate text-lg tracking-tight">
						{pageTitle}
					</h1>
					{titleAccessory}
				</div>

				{headerControls}

				<div className="flex items-center justify-end gap-2 sm:gap-3">
					<LocaleSwitcher className="mr-auto sm:mr-0" />
					{showCancel ? (
						<Button
							type="button"
							variant="outline"
							render={<Link to={backHref} />}
						>
							<Trans>Cancel</Trans>
						</Button>
					) : null}
					<Button
						type="submit"
						name={submitName}
						value={submitValue}
						disabled={isSubmitting}
						className={secondaryAction ? 'order-2' : undefined}
					>
						{isSubmitting ? (
							<Icon name="loader" className="mr-1.5 size-4 animate-spin" />
						) : null}
						<span>{saveButtonText}</span>
					</Button>
					{secondaryAction}
				</div>
			</div>
		</header>
	)
}
