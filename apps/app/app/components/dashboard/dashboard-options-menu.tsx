import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Spinner } from '@repo/ui/spinner'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { useFetcher } from 'react-router'
import { toast } from 'sonner'
import { type DashboardActionResult } from '#app/utils/dashboards/actions.server.ts'
import { DashboardNameDialog } from './dashboard-name-dialog.tsx'

function DeleteDashboardDialog({
	open,
	onOpenChange,
	finalFocus,
	action,
	name,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	finalFocus: RefObject<HTMLElement | null>
	action: string
	name: string
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<DashboardActionResult>()
	const busy = fetcher.state !== 'idle'
	const handledRef = useRef(fetcher.data)

	// A successful delete redirects to Home, so only a refusal comes back.
	useEffect(() => {
		const result = fetcher.data
		if (fetcher.state !== 'idle' || !result || result === handledRef.current) {
			return
		}
		handledRef.current = result
		if (!result.ok) {
			onOpenChange(false)
			toast.error(_(msg`The dashboard could not be deleted.`))
		}
	}, [_, fetcher.data, fetcher.state, onOpenChange])

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent finalFocus={finalFocus}>
				<AlertDialogHeader>
					<AlertDialogTitle>
						<span className="wrap-anywhere">
							<Trans>Delete “{name}”?</Trans>
						</span>
					</AlertDialogTitle>
					<AlertDialogDescription>
						<Trans>
							This deletes the dashboard and its blocks for you and everyone it
							is shared with. This cannot be undone.
						</Trans>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>
						<Trans>Cancel</Trans>
					</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						disabled={busy}
						onClick={() =>
							void fetcher.submit(
								{ intent: 'delete' },
								{ method: 'POST', action },
							)
						}
					>
						{busy ? <Spinner /> : null}
						<Trans>Delete dashboard</Trans>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

/** The owner's Rename and Delete for a custom dashboard. */
export function DashboardOptionsMenu({
	action,
	name,
}: {
	/** The dashboard's URL, which takes its intents. */
	action: string
	name: string
}) {
	const { _ } = useLingui()
	const [renaming, setRenaming] = useState(false)
	const [deleting, setDeleting] = useState(false)
	const triggerRef = useRef<HTMLButtonElement>(null)

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={triggerRef}
					render={
						<Button
							type="button"
							variant="outline"
							size="icon-sm"
							aria-label={_(msg`Dashboard options`)}
						/>
					}
				>
					<Icon name="ellipsis" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={() => setRenaming(true)}>
						<Icon name="pencil" />
						<Trans>Rename</Trans>
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						variant="destructive"
						onClick={() => setDeleting(true)}
					>
						<Icon name="trash-2" />
						<Trans>Delete</Trans>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<DashboardNameDialog
				open={renaming}
				onOpenChange={setRenaming}
				finalFocus={triggerRef}
				action={action}
				intent="rename"
				defaultName={name}
				title={<Trans>Rename dashboard</Trans>}
				description={<Trans>Enter a new name for this dashboard.</Trans>}
				submitLabel={<Trans>Save</Trans>}
			/>
			<DeleteDashboardDialog
				open={deleting}
				onOpenChange={setDeleting}
				finalFocus={triggerRef}
				action={action}
				name={name}
			/>
		</>
	)
}
