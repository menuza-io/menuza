import { Trans } from '@lingui/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Button } from '@repo/ui/button'
import { type ReactNode } from 'react'

/** A small "remove this?" confirmation shared by tasks and certificates. */
export function RemoveDialog({
	open,
	title,
	description,
	pending,
	error,
	onConfirm,
	onClose,
}: {
	open: boolean
	title: ReactNode
	description: ReactNode
	pending: boolean
	error: string | null
	onConfirm: () => void
	onClose: () => void
}) {
	return (
		<AlertDialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !pending) onClose()
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				{error ? (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={pending}>
						<Trans>Cancel</Trans>
					</AlertDialogCancel>
					<Button
						type="button"
						variant="destructive"
						disabled={pending}
						onClick={onConfirm}
					>
						{pending ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
