import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
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
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Skeleton } from '@repo/ui/skeleton'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import {
	noteSchema,
	notesSchema,
	type StaffNoteRow,
} from '#app/utils/staffing/staff-types.ts'
import { TextAreaField } from './controls.tsx'

const addedSchema = z.object({ note: noteSchema.optional() }).loose()

/** Notes only managers with staff access can read. Never shown to the person. */
export function NotesTab({ staffId }: { staffId: string }) {
	const { _, i18n } = useLingui()
	const { client, can } = useStaffClient('staff')
	const query = useStaffQuery(client, `/${staffId}/notes`, notesSchema)
	const canWrite = can(P.UPDATE_STAFF)
	const add = useStaffAction()
	const remove = useStaffAction()
	const [body, setBody] = useState('')
	const [toDelete, setToDelete] = useState<StaffNoteRow | null>(null)

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const text = body.trim()
		if (!text) return
		const result = await add.run(async () =>
			addedSchema.parse(
				await client.request(`/${staffId}/notes`, {
					method: 'POST',
					json: { body: text },
				}),
			),
		)
		if (result.ok) {
			setBody('')
			query.reload()
			toast.success(_(t`Note added.`))
		}
	}

	async function confirmDelete() {
		if (!toDelete) return
		const result = await remove.run(() =>
			client.request(`/${staffId}/notes/${toDelete.id}`, { method: 'DELETE' }),
		)
		if (result.ok) {
			setToDelete(null)
			query.reload()
			toast.success(_(t`Note deleted.`))
		}
	}

	return (
		<Frame className="w-full" stackedPanels>
			<FrameHeader>
				<FrameTitle>
					<Trans>Notes</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>Notes are only visible to managers.</Trans>
				</FrameDescription>
			</FrameHeader>
			{canWrite ? (
				<FramePanel>
					<form
						onSubmit={(event) => void submit(event)}
						className="flex flex-col gap-3"
						aria-label={_(t`Add a note`)}
					>
						<TextAreaField
							label={<Trans>New note</Trans>}
							value={body}
							onChange={(event) => setBody(event.target.value)}
							rows={3}
							maxLength={2000}
						/>
						{add.error ? (
							<Alert variant="destructive">
								<AlertDescription>{add.error}</AlertDescription>
							</Alert>
						) : null}
						<div>
							<Button type="submit" disabled={add.pending || !body.trim()}>
								{add.pending ? <Trans>Adding…</Trans> : <Trans>Add note</Trans>}
							</Button>
						</div>
					</form>
				</FramePanel>
			) : null}

			{query.loading ? (
				<FramePanel>
					<div role="status" className="flex flex-col gap-3">
						<span className="sr-only">
							<Trans>Loading notes</Trans>
						</span>
						<Skeleton className="h-12 w-full" />
						<Skeleton className="h-12 w-full" />
					</div>
				</FramePanel>
			) : query.error ? (
				<FramePanel>
					<Alert variant="destructive">
						<AlertDescription>
							{describeStaffError(query.error, _)}
						</AlertDescription>
					</Alert>
				</FramePanel>
			) : (query.data?.notes.length ?? 0) === 0 ? (
				<FramePanel>
					<p className="text-muted-foreground text-sm">
						<Trans>No notes yet.</Trans>
					</p>
				</FramePanel>
			) : (
				query.data!.notes.map((note) => (
					<FramePanel
						key={note.id}
						className="flex items-start justify-between gap-4 px-5 py-3.5"
					>
						<div className="min-w-0 space-y-0.5">
							<p className="text-sm whitespace-pre-wrap">{note.body}</p>
							<p className="text-muted-foreground text-xs">
								{new Intl.DateTimeFormat(i18n.locale, {
									dateStyle: 'medium',
									timeStyle: 'short',
								}).format(note.createdAt)}
							</p>
						</div>
						{canWrite ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="shrink-0"
								onClick={() => setToDelete(note)}
							>
								<Trans>Delete</Trans>
							</Button>
						) : null}
					</FramePanel>
				))
			)}

			<AlertDialog
				open={toDelete !== null}
				onOpenChange={(open) => {
					if (!open && !remove.pending) setToDelete(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Delete this note?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								It is removed from the list. This is recorded in the staff log.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					{remove.error ? (
						<Alert variant="destructive">
							<AlertDescription>{remove.error}</AlertDescription>
						</Alert>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={remove.pending}>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<Button
							type="button"
							variant="destructive"
							disabled={remove.pending}
							onClick={() => void confirmDelete()}
						>
							{remove.pending ? (
								<Trans>Deleting…</Trans>
							) : (
								<Trans>Delete</Trans>
							)}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Frame>
	)
}
