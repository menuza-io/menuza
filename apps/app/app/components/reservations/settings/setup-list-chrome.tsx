import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { type ReactNode, useState } from 'react'

/**
 * Shared chrome for the list-plus-sheet settings screens (tables, sections):
 * one place for the error, success and "changed by someone else" notices, the
 * edit sheet shell and the destructive confirmation.
 */

export function SetupNotices({
	errorMessage,
	errorTestId,
	onDismissError,
	onRetry,
	feedbackMessage,
	feedbackTestId,
	onDismissFeedback,
	conflictMessage,
	conflictTestId,
	onReload,
}: {
	errorMessage?: string | null
	errorTestId?: string
	onDismissError?: () => void
	/** Shown as a Retry button when the page's data could not be loaded. */
	onRetry?: () => void
	feedbackMessage?: string | null
	feedbackTestId?: string
	onDismissFeedback?: () => void
	conflictMessage?: string | null
	conflictTestId?: string
	onReload?: () => void
}) {
	return (
		<>
			{conflictMessage ? (
				<div
					role="alert"
					className="border-warning/40 bg-warning/10 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
					data-testid={conflictTestId}
				>
					<span>{conflictMessage}</span>
					{onReload ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={onReload}
						>
							<Trans>Reload</Trans>
						</Button>
					) : null}
				</div>
			) : null}
			{errorMessage ? (
				<Alert variant="destructive" data-testid={errorTestId}>
					<AlertDescription>
						<div className="flex items-center justify-between gap-3">
							<span>{errorMessage}</span>
							{onRetry ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={onRetry}
									data-testid="setup-retry"
								>
									<Trans>Retry</Trans>
								</Button>
							) : null}
							{onDismissError && !onRetry ? (
								<DismissButton onClick={onDismissError} />
							) : null}
						</div>
					</AlertDescription>
				</Alert>
			) : null}
			{feedbackMessage ? (
				<div
					role="status"
					className="border-success/30 bg-success/10 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
					data-testid={feedbackTestId}
				>
					<span>{feedbackMessage}</span>
					{onDismissFeedback ? (
						<DismissButton onClick={onDismissFeedback} />
					) : null}
				</div>
			) : null}
		</>
	)
}

function DismissButton({ onClick }: { onClick: () => void }) {
	const { _ } = useLingui()
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			onClick={onClick}
			aria-label={_(msg`Dismiss`)}
		>
			<Icon name="x" className="size-4" />
		</Button>
	)
}

/** Right-hand edit sheet. Content is only mounted while open. */
export function EditSheet({
	open,
	onClose,
	wide,
	children,
}: {
	open: boolean
	onClose: () => void
	wide?: boolean
	children: ReactNode
}) {
	return (
		<Sheet open={open} onOpenChange={(next) => !next && onClose()}>
			<SheetContent className={wide ? 'sm:max-w-2xl' : 'sm:max-w-md'}>
				{open ? children : null}
			</SheetContent>
		</Sheet>
	)
}

export function ConfirmDialog({
	open,
	onClose,
	title,
	description,
	confirmLabel,
	cancelLabel,
	pending,
	onConfirm,
	confirmTestId,
}: {
	open: boolean
	onClose: () => void
	title: ReactNode
	description: ReactNode
	confirmLabel: ReactNode
	cancelLabel: ReactNode
	pending?: boolean
	onConfirm: () => void
	confirmTestId?: string
}) {
	return (
		<AlertDialog open={open} onOpenChange={(next) => !next && onClose()}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						disabled={pending}
						data-testid={confirmTestId}
						onClick={(event) => {
							event.preventDefault()
							onConfirm()
						}}
					>
						{confirmLabel}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

/**
 * Closing an edit sheet with unsaved edits asks first. Use `requestClose` for
 * the sheet's own close, Escape, overlay click and Cancel button, and render
 * `discardDialog` once next to the sheet. A save closes the sheet directly.
 */
export function useDiscardGuard(dirty: boolean, close: () => void) {
	const [asking, setAsking] = useState(false)
	const requestClose = () => {
		if (dirty) setAsking(true)
		else close()
	}
	const discardDialog = (
		<ConfirmDialog
			open={asking}
			onClose={() => setAsking(false)}
			title={<Trans>Discard your changes?</Trans>}
			description={
				<Trans>
					You have unsaved edits. If you close now they are lost and nothing is
					saved.
				</Trans>
			}
			cancelLabel={<Trans>Keep editing</Trans>}
			confirmLabel={<Trans>Discard changes</Trans>}
			confirmTestId="setup-confirm-discard"
			onConfirm={() => {
				setAsking(false)
				close()
			}}
		/>
	)
	return { requestClose, discardDialog }
}
