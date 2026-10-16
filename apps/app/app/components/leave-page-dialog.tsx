import { Trans } from '@lingui/macro'
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
import { useState } from 'react'
import { useLeavePrompt } from '#app/utils/navigation-guards.ts'

/** Asks before a blocked navigation leaves a page (see `useConfirmBlocker`). */
export function LeavePageDialog() {
	const prompt = useLeavePrompt()
	// Keeps the text while the dialog animates closed.
	const [lastMessage, setLastMessage] = useState('')
	if (prompt && prompt.message !== lastMessage) setLastMessage(prompt.message)

	return (
		<AlertDialog
			open={prompt !== null}
			onOpenChange={(open) => {
				if (!open) prompt?.stay()
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						<Trans>Leave this page?</Trans>
					</AlertDialogTitle>
					<AlertDialogDescription>{lastMessage}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>
						<Trans>Stay</Trans>
					</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						onClick={() => prompt?.leave()}
					>
						<Trans>Leave</Trans>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
