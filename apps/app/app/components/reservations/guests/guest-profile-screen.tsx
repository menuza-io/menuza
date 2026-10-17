import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
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
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { Textarea } from '@repo/ui/textarea'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { GuestProfileCard } from '#app/components/reservations/guest-profile-card.tsx'
import { GuestMergeDialog } from '#app/components/reservations/guests/guest-merge-dialog.tsx'
import { GuestNotesPanel } from '#app/components/reservations/guests/guest-notes-panel.tsx'
import {
	addGuestNote,
	assignGuestTag,
	createGuestTag,
	deleteGuestNote,
	eraseGuest,
	exportGuest,
	fetchGuestProfile,
	fetchGuestTags,
	type GuestProfile,
	type GuestProfilePatch,
	type GuestRow,
	type GuestTag,
	mergeGuests,
	removeGuestTag,
	updateGuestNote,
	updateGuestProfile,
} from '#app/utils/reservations/guests-api.ts'
import {
	guestsErrorInfo,
	guestsErrorMessage,
} from '#app/utils/reservations/guests-errors.ts'
import {
	downloadJson,
	formatBusinessDate,
	formatLocalMinutes,
	guestTagName,
} from '#app/utils/reservations/guests-view.ts'
import {
	CHANNEL_LABELS,
	enumLabel,
	RESERVATION_STATUS_LABELS,
} from '#app/utils/reservations/labels.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

type LoadState =
	'loading' | 'ready' | 'missing' | 'denied' | 'merged' | 'failed'

const FAIL_TAG = msg`The tag could not be changed. Try again.`
const FAIL_NOTE = msg`The note could not be saved. Try again.`
const FAIL_GUEST = msg`The guest details could not be saved. Try again.`
const FAIL_MERGE = msg`The guests could not be merged. Try again.`
const FAIL_ERASE = msg`The guest could not be erased. Try again.`

export function GuestProfileScreen({
	client,
	orgSlug,
	guestId,
	canManage,
}: {
	client: ReservationsScopedClient
	orgSlug: string
	guestId: string
	canManage: boolean
}) {
	const { _, i18n } = useLingui()
	const [profile, setProfile] = useState<GuestProfile | null>(null)
	const [catalog, setCatalog] = useState<GuestTag[]>([])
	const [state, setState] = useState<LoadState>('loading')
	const [busy, setBusy] = useState(false)
	const [editOpen, setEditOpen] = useState(false)
	const [mergeOpen, setMergeOpen] = useState(false)
	const [eraseOpen, setEraseOpen] = useState(false)
	const [newTagName, setNewTagName] = useState('')
	const [assignTagId, setAssignTagId] = useState('')

	const reload = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const [next, tags] = await Promise.all([
					fetchGuestProfile(client, guestId, signal),
					fetchGuestTags(client, signal),
				])
				if (signal?.aborted) return
				setProfile(next)
				setCatalog(tags)
				setState('ready')
			} catch (err) {
				if (signal?.aborted) return
				const { status, code } = guestsErrorInfo(err)
				setState(
					code === 'guest_merged'
						? 'merged'
						: status === 404
							? 'missing'
							: status === 403
								? 'denied'
								: 'failed',
				)
			}
		},
		[client, guestId],
	)

	useEffect(() => {
		const controller = new AbortController()
		setState('loading')
		void reload(controller.signal)
		return () => controller.abort()
	}, [reload])

	const write = useCallback(
		async (
			action: () => Promise<unknown>,
			messages: { success?: string; failure: MessageDescriptor },
		): Promise<boolean> => {
			setBusy(true)
			try {
				await action()
				if (messages.success) toast.success(messages.success)
				return true
			} catch (err) {
				toast.error(guestsErrorMessage(err, _, messages.failure))
				return false
			} finally {
				await reload()
				setBusy(false)
			}
		},
		[_, reload],
	)

	if (state === 'loading' && !profile) {
		return (
			<p
				className="text-muted-foreground text-sm"
				role="status"
				data-testid="guest-profile-loading"
			>
				<Trans>Loading guest...</Trans>
			</p>
		)
	}

	const backLink = (
		<Button
			variant="ghost"
			size="sm"
			render={<Link to={`/${orgSlug}/reservations/guests`} />}
			data-testid="guest-back"
		>
			<Icon name="arrow-left" className="rtl:rotate-180" />
			<Trans>All guests</Trans>
		</Button>
	)

	if (
		state === 'missing' ||
		state === 'denied' ||
		state === 'merged' ||
		state === 'failed' ||
		!profile
	) {
		return (
			<div className="flex flex-col gap-4" data-testid="guest-profile-error">
				<div>{backLink}</div>
				<Alert variant="destructive">
					<Icon name="alert-triangle" />
					<AlertDescription>
						{state === 'missing' ? (
							<Trans>This guest does not exist.</Trans>
						) : state === 'merged' ? (
							<Trans>This guest was merged into another profile.</Trans>
						) : state === 'denied' ? (
							<Trans>You do not have access to guest profiles.</Trans>
						) : (
							<Trans>The guest profile could not be loaded.</Trans>
						)}
					</AlertDescription>
				</Alert>
			</div>
		)
	}

	const { guest } = profile
	const erased = guest.erasedAt !== null
	const assignable = catalog.filter(
		(tag) => !tag.system && !guest.tags.some((own) => own.id === tag.id),
	)
	const writable = canManage && !erased

	const exportJson = async (includeSensitive: boolean) => {
		setBusy(true)
		try {
			const data = await exportGuest(client, guest.id, includeSensitive)
			const ok = downloadJson(
				`guest-${guest.id}${includeSensitive ? '-sensitive' : ''}.json`,
				data,
			)
			if (ok) toast.success(_(msg`Guest export downloaded.`))
		} catch (err) {
			toast.error(
				guestsErrorMessage(err, _, msg`The guest export failed. Try again.`),
			)
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="flex flex-col gap-4" data-testid="guest-profile-screen">
			<div>{backLink}</div>
			<PageHeader
				title={erased ? <Trans>Erased guest</Trans> : guest.name}
				description={
					<Trans>
						Visit history, tags, and notes for this guest. Details stay in your
						regional database.
					</Trans>
				}
				actions={
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={busy || erased}
							onClick={() => void exportJson(false)}
							data-testid="guest-export"
						>
							<Icon name="download" />
							<Trans>Export JSON</Trans>
						</Button>
						{canManage ? (
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busy || erased}
								onClick={() => void exportJson(true)}
								data-testid="guest-export-sensitive"
							>
								<Icon name="download" />
								<Trans>Export with sensitive data</Trans>
							</Button>
						) : null}
						{writable ? (
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() => setMergeOpen(true)}
								data-testid="guest-merge"
							>
								<Trans>Merge duplicate</Trans>
							</Button>
						) : null}
						{writable ? (
							<Button
								type="button"
								size="sm"
								variant="destructive"
								disabled={busy}
								onClick={() => setEraseOpen(true)}
								data-testid="guest-erase"
							>
								<Trans>Erase guest</Trans>
							</Button>
						) : null}
					</div>
				}
			/>

			{erased ? (
				<Alert data-testid="guest-erased-notice">
					<Icon name="info" />
					<AlertDescription>
						<Trans>
							This guest was erased. Contact details, tags, and notes are
							removed; visit counts and booking history remain.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			<GuestProfileCard
				guest={guest}
				pinnedNotes={profile.pinnedNotes}
				canManage={writable}
				busy={busy}
				onEdit={() => setEditOpen(true)}
				onRemoveTag={(tagId) =>
					void write(() => removeGuestTag(client, guest.id, tagId), {
						failure: FAIL_TAG,
					})
				}
			/>

			{writable ? (
				<section
					className="bg-card flex flex-col gap-3 rounded-xl border p-5"
					aria-labelledby="guest-tags-title"
					data-testid="guest-tag-manager"
				>
					<h3 id="guest-tags-title" className="text-sm font-semibold">
						<Trans>Tags</Trans>
					</h3>
					<div className="flex flex-wrap items-end gap-3">
						<div className="flex flex-col gap-1">
							<Label htmlFor="guest-assign-tag" className="text-xs">
								<Trans>Assign a tag</Trans>
							</Label>
							<div className="flex gap-2">
								<select
									id="guest-assign-tag"
									value={assignTagId}
									onChange={(event) => setAssignTagId(event.target.value)}
									className="border-input bg-background text-foreground h-9 rounded-md border px-2.5 text-sm"
									data-testid="guest-assign-tag"
								>
									<option value="">{_(msg`Choose a tag`)}</option>
									{assignable.map((tag) => (
										<option key={tag.id} value={tag.id}>
											{guestTagName(_, tag)}
										</option>
									))}
								</select>
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={busy || !assignTagId}
									onClick={async () => {
										if (
											await write(
												() => assignGuestTag(client, guest.id, assignTagId),
												{ failure: FAIL_TAG },
											)
										) {
											setAssignTagId('')
										}
									}}
									data-testid="guest-assign-tag-submit"
								>
									<Trans>Assign</Trans>
								</Button>
							</div>
						</div>
						<form
							className="flex flex-col gap-1"
							onSubmit={async (event) => {
								event.preventDefault()
								const name = newTagName.trim()
								if (!name) return
								const ok = await write(
									async () => {
										const tag = await createGuestTag(client, { name })
										await assignGuestTag(client, guest.id, tag.id)
									},
									{ failure: FAIL_TAG },
								)
								if (ok) setNewTagName('')
							}}
						>
							<Label htmlFor="guest-new-tag" className="text-xs">
								<Trans>Create a tag and assign it</Trans>
							</Label>
							<div className="flex gap-2">
								<Input
									id="guest-new-tag"
									value={newTagName}
									maxLength={60}
									onChange={(event) => setNewTagName(event.target.value)}
									placeholder={_(msg`Tag name`)}
									data-testid="guest-new-tag"
								/>
								<Button
									type="submit"
									size="sm"
									disabled={busy || newTagName.trim() === ''}
									data-testid="guest-new-tag-submit"
								>
									<Trans>Create</Trans>
								</Button>
							</div>
						</form>
					</div>
				</section>
			) : null}

			<GuestNotesPanel
				notes={profile.notes}
				canManage={writable}
				busy={busy}
				onAdd={(body, pinned) =>
					write(() => addGuestNote(client, guest.id, { body, pinned }), {
						failure: FAIL_NOTE,
					})
				}
				onUpdate={(noteId, patch) =>
					write(() => updateGuestNote(client, guest.id, noteId, patch), {
						failure: FAIL_NOTE,
					})
				}
				onDelete={(noteId) =>
					write(() => deleteGuestNote(client, guest.id, noteId), {
						failure: FAIL_NOTE,
					})
				}
			/>

			<section
				className="flex flex-col gap-2"
				aria-labelledby="guest-history-title"
				data-testid="guest-history"
			>
				<h3 id="guest-history-title" className="text-sm font-semibold">
					<Trans>Visit history</Trans>
				</h3>
				{profile.visits.length === 0 ? (
					<p
						className="text-muted-foreground text-sm"
						data-testid="guest-history-empty"
					>
						<Trans>No bookings yet.</Trans>
					</p>
				) : (
					<Frame>
						<Table variant="card">
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Date</Trans>
									</TableHead>
									<TableHead>
										<Trans>Time</Trans>
									</TableHead>
									<TableHead className="text-end">
										<Trans>Party</Trans>
									</TableHead>
									<TableHead>
										<Trans>Service</Trans>
									</TableHead>
									<TableHead>
										<Trans>Source</Trans>
									</TableHead>
									<TableHead>
										<Trans>Status</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{profile.visits.map((visit) => (
									<TableRow
										key={visit.id}
										data-testid={`guest-visit-${visit.id}`}
									>
										<TableCell>
											{formatBusinessDate(visit.businessDate, i18n.locale)}
										</TableCell>
										<TableCell className="tabular-nums">
											<bdi dir="ltr">
												{formatLocalMinutes(visit.localStartMin)}
											</bdi>
										</TableCell>
										<TableCell className="text-end tabular-nums">
											<bdi>{visit.partySize}</bdi>
										</TableCell>
										<TableCell>{visit.serviceName ?? '—'}</TableCell>
										<TableCell>
											{enumLabel(_, CHANNEL_LABELS, visit.channel)}
										</TableCell>
										<TableCell>
											<Badge
												variant={
													visit.status === 'finished'
														? 'success'
														: visit.status === 'no_show'
															? 'destructive'
															: visit.status === 'cancelled'
																? 'warning'
																: 'secondary'
												}
												data-testid={`guest-visit-status-${visit.id}`}
											>
												{enumLabel(_, RESERVATION_STATUS_LABELS, visit.status)}
											</Badge>
											{visit.lateCancel ? (
												<Badge variant="warning" className="ms-1">
													<Trans>Late</Trans>
												</Badge>
											) : null}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</Frame>
				)}
			</section>

			<EditGuestDialog
				open={editOpen}
				onOpenChange={setEditOpen}
				guest={guest}
				busy={busy}
				onSave={(patch) =>
					write(() => updateGuestProfile(client, guest.id, patch), {
						success: _(msg`Guest details saved.`),
						failure: FAIL_GUEST,
					})
				}
			/>

			<GuestMergeDialog
				open={mergeOpen}
				onOpenChange={setMergeOpen}
				client={client}
				current={guest}
				busy={busy}
				onMerge={(duplicate: GuestRow) =>
					write(
						() =>
							mergeGuests(client, {
								keepId: guest.id,
								mergeId: duplicate.id,
								keepVersion: guest.version,
								mergeVersion: duplicate.version,
							}),
						{
							success: _(msg`Guests merged.`),
							failure: FAIL_MERGE,
						},
					)
				}
			/>

			<AlertDialog
				open={eraseOpen}
				onOpenChange={(next) => {
					if (!busy) setEraseOpen(next)
				}}
			>
				<AlertDialogContent data-testid="guest-erase-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Erase this guest?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								The guest is told about each upcoming booking being cancelled,
								then their name, contact details, tags, and notes are removed.
								Visit counts and past bookings stay. This cannot be undone.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							type="button"
							disabled={busy}
							onClick={async () => {
								const ok = await write(() => eraseGuest(client, guest.id), {
									success: _(msg`Guest erased.`),
									failure: FAIL_ERASE,
								})
								if (ok) setEraseOpen(false)
							}}
							data-testid="guest-erase-confirm"
						>
							<Trans>Erase guest</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}

function EditGuestDialog({
	open,
	onOpenChange,
	guest,
	busy,
	onSave,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	guest: GuestRow
	busy: boolean
	onSave: (patch: GuestProfilePatch) => Promise<boolean>
}) {
	const [firstName, setFirstName] = useState(guest.firstName)
	const [lastName, setLastName] = useState(guest.lastName)
	const [phone, setPhone] = useState(guest.phone ?? '')
	const [email, setEmail] = useState(guest.email ?? '')
	const [allergy, setAllergy] = useState(guest.allergyNotes ?? '')

	useEffect(() => {
		if (!open) return
		setFirstName(guest.firstName)
		setLastName(guest.lastName)
		setPhone(guest.phone ?? '')
		setEmail(guest.email ?? '')
		setAllergy(guest.allergyNotes ?? '')
	}, [open, guest])

	return (
		<Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
			<DialogContent data-testid="guest-edit-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Edit guest details</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Changes apply to the guest profile only, not to past bookings.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-3"
					onSubmit={async (event) => {
						event.preventDefault()
						const ok = await onSave({
							expectedVersion: guest.version,
							firstName: firstName.trim(),
							lastName: lastName.trim(),
							phone: phone.trim() || null,
							email: email.trim() || null,
							allergyNotes: allergy.trim() || null,
						})
						if (ok) onOpenChange(false)
					}}
				>
					<div className="grid grid-cols-2 gap-3">
						<div className="flex flex-col gap-1">
							<Label htmlFor="guest-first-name" className="text-xs">
								<Trans>First name</Trans>
							</Label>
							<Input
								id="guest-first-name"
								value={firstName}
								maxLength={120}
								required
								onChange={(event) => setFirstName(event.target.value)}
								data-testid="guest-first-name"
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="guest-last-name" className="text-xs">
								<Trans>Last name</Trans>
							</Label>
							<Input
								id="guest-last-name"
								value={lastName}
								maxLength={120}
								onChange={(event) => setLastName(event.target.value)}
								data-testid="guest-last-name"
							/>
						</div>
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor="guest-phone-input" className="text-xs">
							<Trans>Phone</Trans>
						</Label>
						<Input
							id="guest-phone-input"
							type="tel"
							dir="ltr"
							value={phone}
							onChange={(event) => setPhone(event.target.value)}
							data-testid="guest-phone-input"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor="guest-email-input" className="text-xs">
							<Trans>Email</Trans>
						</Label>
						<Input
							id="guest-email-input"
							type="email"
							dir="ltr"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							data-testid="guest-email-input"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor="guest-allergy-input" className="text-xs">
							<Trans>Allergies and dietary needs</Trans>
						</Label>
						<Textarea
							id="guest-allergy-input"
							value={allergy}
							maxLength={1000}
							onChange={(event) => setAllergy(event.target.value)}
							data-testid="guest-allergy-input"
						/>
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							disabled={busy}
							onClick={() => onOpenChange(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							disabled={busy || firstName.trim() === ''}
							data-testid="guest-edit-save"
						>
							<Trans>Save</Trans>
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
