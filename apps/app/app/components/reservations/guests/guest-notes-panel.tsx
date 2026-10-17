import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import { Textarea } from '@repo/ui/textarea'
import { useState } from 'react'
import { type GuestNote } from '#app/utils/reservations/guests-api.ts'
import { formatInstantDate } from '#app/utils/reservations/guests-view.ts'

const MAX_NOTE = 2000

/**
 * Notes of one guest, pinned ones first. Pinned notes also appear in the
 * guest summary of the Book and the host stand. Edits and deletes go through
 * the screen so a failed write never leaves the list out of step.
 */
export function GuestNotesPanel({
	notes,
	canManage,
	busy,
	onAdd,
	onUpdate,
	onDelete,
}: {
	notes: GuestNote[]
	canManage: boolean
	busy: boolean
	onAdd: (body: string, pinned: boolean) => Promise<boolean>
	onUpdate: (
		noteId: string,
		patch: { body?: string; pinned?: boolean },
	) => Promise<boolean>
	onDelete: (noteId: string) => Promise<boolean>
}) {
	const { _, i18n } = useLingui()
	const [draft, setDraft] = useState('')
	const [draftPinned, setDraftPinned] = useState(false)
	const [editingId, setEditingId] = useState<string | null>(null)
	const [editBody, setEditBody] = useState('')

	const ordered = [...notes].sort(
		(a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt,
	)

	return (
		<section
			className="bg-card flex flex-col gap-3 rounded-xl border p-5"
			aria-labelledby="guest-notes-title"
			data-testid="guest-notes"
		>
			<h3 id="guest-notes-title" className="text-sm font-semibold">
				<Trans>Notes</Trans>
			</h3>

			{ordered.length === 0 ? (
				<p
					className="text-muted-foreground text-sm"
					data-testid="guest-notes-empty"
				>
					<Trans>No notes yet.</Trans>
				</p>
			) : (
				<ul className="flex flex-col gap-2">
					{ordered.map((note) => (
						<li
							key={note.id}
							className="border-border flex flex-col gap-2 rounded-md border p-3"
							data-testid={`guest-note-${note.id}`}
							data-pinned={note.pinned ? 'true' : 'false'}
						>
							{editingId === note.id ? (
								<div className="flex flex-col gap-2">
									<Label htmlFor={`note-edit-${note.id}`} className="sr-only">
										<Trans>Edit note</Trans>
									</Label>
									<Textarea
										id={`note-edit-${note.id}`}
										value={editBody}
										maxLength={MAX_NOTE}
										onChange={(event) => setEditBody(event.target.value)}
										data-testid="guest-note-edit-input"
									/>
									<div className="flex gap-2">
										<Button
											type="button"
											size="sm"
											disabled={busy || editBody.trim() === ''}
											onClick={async () => {
												if (
													await onUpdate(note.id, { body: editBody.trim() })
												) {
													setEditingId(null)
												}
											}}
											data-testid="guest-note-edit-save"
										>
											<Trans>Save</Trans>
										</Button>
										<Button
											type="button"
											size="sm"
											variant="ghost"
											onClick={() => setEditingId(null)}
										>
											<Trans>Cancel</Trans>
										</Button>
									</div>
								</div>
							) : (
								<>
									<div className="flex items-start gap-2">
										{note.pinned ? (
											<Icon
												name="star"
												className="mt-0.5 size-3.5 shrink-0"
												aria-label={_(msg`Pinned`)}
											/>
										) : null}
										<p className="text-sm wrap-anywhere whitespace-pre-wrap">
											{note.body}
										</p>
									</div>
									<div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
										<span>
											{formatInstantDate(note.createdAt, i18n.locale) ?? ''}
										</span>
										{canManage ? (
											<span className="flex flex-wrap gap-1">
												<Button
													type="button"
													size="xs"
													variant="ghost"
													disabled={busy}
													onClick={() =>
														void onUpdate(note.id, { pinned: !note.pinned })
													}
													data-testid={`guest-note-pin-${note.id}`}
												>
													{note.pinned ? (
														<Trans>Unpin</Trans>
													) : (
														<Trans>Pin</Trans>
													)}
												</Button>
												<Button
													type="button"
													size="xs"
													variant="ghost"
													disabled={busy}
													onClick={() => {
														setEditingId(note.id)
														setEditBody(note.body)
													}}
													data-testid={`guest-note-edit-${note.id}`}
												>
													<Trans>Edit</Trans>
												</Button>
												<Button
													type="button"
													size="xs"
													variant="ghost"
													disabled={busy}
													onClick={() => void onDelete(note.id)}
													data-testid={`guest-note-delete-${note.id}`}
												>
													<Trans>Delete</Trans>
												</Button>
											</span>
										) : null}
									</div>
								</>
							)}
						</li>
					))}
				</ul>
			)}

			{canManage ? (
				<form
					className="flex flex-col gap-2"
					onSubmit={async (event) => {
						event.preventDefault()
						const body = draft.trim()
						if (!body) return
						if (await onAdd(body, draftPinned)) {
							setDraft('')
							setDraftPinned(false)
						}
					}}
				>
					<Label htmlFor="guest-note-new" className="text-xs">
						<Trans>Add a note</Trans>
					</Label>
					<Textarea
						id="guest-note-new"
						value={draft}
						maxLength={MAX_NOTE}
						onChange={(event) => setDraft(event.target.value)}
						data-testid="guest-note-input"
					/>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={draftPinned}
								onChange={(event) => setDraftPinned(event.target.checked)}
								data-testid="guest-note-pin-new"
							/>
							<Trans>Pin this note so hosts see it</Trans>
						</label>
						<Button
							type="submit"
							size="sm"
							disabled={busy || draft.trim() === ''}
							data-testid="guest-note-add"
						>
							<Trans>Add note</Trans>
						</Button>
					</div>
				</form>
			) : null}
		</section>
	)
}
