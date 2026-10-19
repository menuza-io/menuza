import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import { TextAreaField } from '#app/components/staff/controls.tsx'
import { type PersonNote } from '#app/utils/people/people-api.ts'
import { formatInstantDate } from '#app/utils/people/people-view.ts'

const MAX_NOTE = 2000

/**
 * Notes of one customer, pinned ones first. Pinned notes also appear in the
 * guest summary of the Book and the host stand. Edits and deletes go through
 * the screen so a failed write never leaves the list out of step.
 */
export function PersonNotesPanel({
	notes,
	canManage,
	busy,
	onAdd,
	onUpdate,
	onDelete,
}: {
	notes: PersonNote[]
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
		<Frame
			role="region"
			data-testid="guest-notes"
			aria-labelledby="guest-notes-title"
		>
			<FrameHeader>
				<FrameTitle id="guest-notes-title">
					<Trans>Notes</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>
						Pinned notes show up for hosts when this customer books.
					</Trans>
				</FrameDescription>
			</FrameHeader>

			{ordered.length === 0 ? (
				<FramePanel>
					<p
						className="text-muted-foreground text-sm"
						data-testid="guest-notes-empty"
					>
						<Trans>No notes yet.</Trans>
					</p>
				</FramePanel>
			) : (
				<FramePanel className="p-0">
					<ul className="divide-border flex flex-col divide-y">
						{ordered.map((note) => (
							<li
								key={note.id}
								className="flex flex-col gap-2 px-5 py-3"
								data-testid={`guest-note-${note.id}`}
								data-pinned={note.pinned ? 'true' : 'false'}
							>
								{editingId === note.id ? (
									<div className="flex flex-col gap-2">
										<TextAreaField
											id={`note-edit-${note.id}`}
											label={<Trans>Edit note</Trans>}
											value={editBody}
											maxLength={MAX_NOTE}
											onChange={(event) => setEditBody(event.target.value)}
											data-testid="guest-note-edit-input"
										/>
										<div className="flex gap-2">
											<Button
												type="button"
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
														size="sm"
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
														size="sm"
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
														size="sm"
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
				</FramePanel>
			)}

			{canManage ? (
				<FramePanel>
					<form
						className="flex flex-col gap-3"
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
						<TextAreaField
							id="guest-note-new"
							label={<Trans>Add a note</Trans>}
							value={draft}
							maxLength={MAX_NOTE}
							onChange={(event) => setDraft(event.target.value)}
							data-testid="guest-note-input"
						/>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<label className="flex min-h-11 items-center gap-2.5 text-sm md:min-h-8">
								<Checkbox
									checked={draftPinned}
									onCheckedChange={setDraftPinned}
									data-testid="guest-note-pin-new"
								/>
								<Trans>Pin this note so hosts see it</Trans>
							</label>
							<Button
								type="submit"
								disabled={busy || draft.trim() === ''}
								data-testid="guest-note-add"
							>
								<Trans>Add note</Trans>
							</Button>
						</div>
					</form>
				</FramePanel>
			) : null}
		</Frame>
	)
}
