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
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { eraseApplicant } from '#app/utils/hiring/applicant-api.ts'
import { describeApplicantError } from '#app/utils/hiring/applicant-errors.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'

/**
 * Permanently delete an applicant: the application, answers, notes and
 * interviews. For a person who asks to be forgotten. It cannot be undone, so it
 * is a confirmation of its own and says exactly what goes.
 */
export function EraseDialog({
	client,
	applicationId,
	name,
	wasHired,
	onErased,
	onClose,
}: {
	client: StaffClient
	applicationId: string
	name: string
	wasHired: boolean
	onErased: () => void
	onClose: () => void
}) {
	const action = useStaffAction(describeApplicantError)

	async function confirm() {
		const result = await action.run(() => eraseApplicant(client, applicationId))
		if (result.ok) {
			onErased()
			onClose()
		}
	}

	return (
		<AlertDialog
			open
			onOpenChange={(open) => {
				if (!open && !action.pending) onClose()
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						<Trans>Delete {name}'s application?</Trans>
					</AlertDialogTitle>
					<AlertDialogDescription>
						<Trans>
							This permanently deletes their application, answers, notes and
							interviews. It cannot be undone.
						</Trans>
						{wasHired ? (
							<>
								{' '}
								<Trans>
									They stay on your team; this removes only the application.
								</Trans>
							</>
						) : null}
					</AlertDialogDescription>
				</AlertDialogHeader>
				{action.error ? (
					<Alert variant="destructive">
						<AlertDescription>{action.error}</AlertDescription>
					</Alert>
				) : null}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={action.pending}>
						<Trans>Keep</Trans>
					</AlertDialogCancel>
					<Button
						variant="destructive"
						disabled={action.pending}
						onClick={() => void confirm()}
					>
						{action.pending ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
