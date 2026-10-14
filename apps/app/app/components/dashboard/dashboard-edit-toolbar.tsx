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
	AlertDialogTrigger,
} from '@repo/ui/alert-dialog'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { useState, type ReactNode } from 'react'

function ResetToDefaultButton({ onReset }: { onReset: () => void }) {
	const [open, setOpen] = useState(false)
	return (
		<AlertDialog open={open} onOpenChange={setOpen}>
			<AlertDialogTrigger
				render={<Button type="button" variant="outline" size="sm" />}
			>
				<Icon name="refresh-cw" />
				<Trans>Reset to default</Trans>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						<Trans>Reset to the default layout?</Trans>
					</AlertDialogTitle>
					<AlertDialogDescription>
						<Trans>
							Your blocks and their arrangement are replaced by the default
							blocks. This cannot be undone.
						</Trans>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>
						<Trans>Cancel</Trans>
					</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						onClick={() => {
							onReset()
							setOpen(false)
						}}
					>
						<Trans>Reset</Trans>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

/**
 * "Edit layout" outside edit mode; while editing, the save status, the
 * `addBlock` control, "Reset to default" (when `onReset` is given) and "Done".
 */
export function DashboardEditToolbar({
	editing,
	saving,
	saved,
	addBlock,
	onStartEditing,
	onStopEditing,
	onReset,
}: {
	editing: boolean
	saving: boolean
	saved: boolean
	addBlock: ReactNode
	onStartEditing: () => void
	onStopEditing: () => void
	onReset?: () => void
}) {
	if (!editing) {
		return (
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={onStartEditing}
			>
				<Icon name="pencil" />
				<Trans>Edit layout</Trans>
			</Button>
		)
	}
	return (
		<div className="flex flex-wrap items-center justify-end gap-2">
			<span role="status" className="text-muted-foreground text-sm">
				{saving ? <Trans>Saving…</Trans> : saved ? <Trans>Saved</Trans> : null}
			</span>
			{addBlock}
			{onReset ? <ResetToDefaultButton onReset={onReset} /> : null}
			<Button type="button" size="sm" onClick={onStopEditing}>
				<Icon name="check" />
				<Trans>Done</Trans>
			</Button>
		</div>
	)
}
