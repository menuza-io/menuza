import { Trans, useLingui } from '@lingui/react/macro'
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
import { useState } from 'react'

/**
 * Archiving takes a discount off every channel and releases its codes for
 * good, so it asks first. `onConfirm` submits the status change.
 */
export function ArchiveDiscountButton({
	name,
	hasCodes,
	disabled,
	describedBy,
	variant = 'ghost',
	size = 'sm',
	onConfirm,
}: {
	name: string
	hasCodes: boolean
	disabled?: boolean
	/**
	 * The id of visible text that says why the button is off. A tooltip alone
	 * can't be reached by keyboard or touch.
	 */
	describedBy?: string
	variant?: 'ghost' | 'outline'
	size?: 'sm' | 'default'
	onConfirm: () => void
}) {
	const { t } = useLingui()
	const [open, setOpen] = useState(false)
	return (
		<>
			<Button
				type="button"
				variant={variant}
				size={size}
				disabled={disabled}
				aria-describedby={describedBy}
				// The same button sits on every row, so it says which discount.
				aria-label={t`Archive ${name}`}
				onClick={() => setOpen(true)}
			>
				<Trans>Archive</Trans>
			</Button>
			<AlertDialog open={open} onOpenChange={setOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Archive {name}?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							{hasCodes ? (
								<Trans>
									It stops applying everywhere and its codes stop working. If
									you restore it later, its codes are not brought back and their
									use counts start again.
								</Trans>
							) : (
								<Trans>
									It stops applying everywhere. You can restore it later.
								</Trans>
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Keep it</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							type="button"
							variant="destructive"
							onClick={() => {
								setOpen(false)
								onConfirm()
							}}
						>
							<Trans>Archive</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
