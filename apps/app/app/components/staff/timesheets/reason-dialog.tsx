import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { FieldError } from '@repo/ui/field'
import { type FormEvent, type ReactNode, useState } from 'react'
import { isMeaningfulReason } from '#app/utils/staffing/timesheet-form.ts'
import { ReasonField } from './reason-field.tsx'

/**
 * A step that undoes or removes something (unlock, reopen, delete) and so asks
 * why first. The confirm button is the only way through; Escape and Cancel
 * leave everything as it was. `onConfirm` returns true when it worked, which
 * closes the dialog; on failure it stays open with the message the caller
 * shows in `error`.
 */
export function ReasonDialog({
	title,
	description,
	confirmLabel,
	pendingLabel,
	destructive,
	error,
	pending,
	onConfirm,
	onClose,
	children,
}: {
	title: ReactNode
	description: ReactNode
	confirmLabel: ReactNode
	pendingLabel: ReactNode
	destructive?: boolean
	error?: string | null
	pending: boolean
	onConfirm: (reason: string) => Promise<boolean>
	onClose: () => void
	children?: ReactNode
}) {
	const { _ } = useLingui()
	const [reason, setReason] = useState('')
	const [invalid, setInvalid] = useState<string | null>(null)

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (pending) return
		if (!isMeaningfulReason(reason)) {
			setInvalid(_(t`Say why. It is kept with the card.`))
			return
		}
		setInvalid(null)
		if (await onConfirm(reason.trim())) onClose()
	}

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !pending) onClose()
			}}
		>
			<DialogContent className="sm:max-w-md">
				<form
					onSubmit={(event) => void submit(event)}
					noValidate
					className="grid gap-4"
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</DialogHeader>
					{children}
					<ReasonField
						value={reason}
						onChange={(value) => {
							setReason(value)
							setInvalid(null)
						}}
						error={invalid}
						disabled={pending}
						autoFocus
					/>
					{error ? <FieldError>{error}</FieldError> : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={pending}
							onClick={onClose}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							variant={destructive ? 'destructive' : 'default'}
							disabled={pending}
						>
							{pending ? pendingLabel : confirmLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
