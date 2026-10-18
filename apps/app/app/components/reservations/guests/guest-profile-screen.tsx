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
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemTitle,
} from '@repo/ui/item'
import { PageHeader } from '@repo/ui/page-header'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { GuestProfileCard } from '#app/components/reservations/guest-profile-card.tsx'
import { GuestMergeDialog } from '#app/components/reservations/guests/guest-merge-dialog.tsx'
import { GuestNotesPanel } from '#app/components/reservations/guests/guest-notes-panel.tsx'
import { StatusLabel } from '#app/components/reservations/status-style.tsx'
import {
	SelectField,
	TextAreaField,
	TextField,
} from '#app/components/staff/controls.tsx'
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
import { CHANNEL_LABELS, enumLabel } from '#app/utils/reservations/labels.ts'
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
			<div
				className="flex flex-col gap-6"
				role="status"
				aria-busy="true"
				data-testid="guest-profile-loading"
			>
				<span className="sr-only">
					<Trans>Loading guest...</Trans>
				</span>
				<Skeleton className="h-8 w-56" />
				<Skeleton className="h-40 w-full rounded-xl" />
				<Skeleton className="h-32 w-full rounded-xl" />
			</div>
		)
	}

	const backLink = (
		<Button
			variant="outline"
			size="icon"
			render={<Link to={`/${orgSlug}/reservations/guests`} />}
			aria-label={_(msg`Back to guests`)}
			data-testid="guest-back"
		>
			<Icon name="arrow-left" className="rtl:rotate-180" />
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
			<div className="flex flex-col gap-6" data-testid="guest-profile-error">
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

	const assignOptions = assignable.map((tag) => ({
		value: tag.id,
		label: guestTagName(_, tag),
	}))

	return (
		<div className="flex flex-col gap-6" data-testid="guest-profile-screen">
			<div className="flex items-start gap-3">
				{backLink}
				<div className="min-w-0 flex-1">
					<PageHeader
						title={
							<span data-testid="guest-profile-name">
								{erased ? <Trans>Erased guest</Trans> : guest.name}
							</span>
						}
						description={<Trans>Visits, notes and tags for this guest.</Trans>}
						actions={
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											type="button"
											variant="outline"
											disabled={busy || erased}
											data-testid="guest-export-menu"
										/>
									}
								>
									<Icon name="download" />
									<Trans>Export</Trans>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem
										onClick={() => void exportJson(false)}
										data-testid="guest-export"
									>
										<Trans>Export JSON</Trans>
									</DropdownMenuItem>
									{canManage ? (
										<DropdownMenuItem
											onClick={() => void exportJson(true)}
											data-testid="guest-export-sensitive"
										>
											<Trans>Export with sensitive data</Trans>
										</DropdownMenuItem>
									) : null}
								</DropdownMenuContent>
							</DropdownMenu>
						}
					/>
				</div>
			</div>

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
			>
				{writable ? (
					<div
						className="border-border flex flex-col gap-4 border-t pt-5"
						data-testid="guest-tag-manager"
					>
						<h3 className="text-sm font-medium">
							<Trans>Tags</Trans>
						</h3>
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="flex items-end gap-2">
								<SelectField
									className="min-w-0 flex-1"
									id="guest-assign-tag"
									label={<Trans>Assign a tag</Trans>}
									options={assignOptions}
									value={assignTagId}
									placeholder={_(msg`Choose a tag`)}
									onValueChange={setAssignTagId}
								/>
								<Button
									type="button"
									variant="outline"
									className="h-11 md:h-8"
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
							<form
								className="flex items-end gap-2"
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
								<TextField
									className="min-w-0 flex-1"
									id="guest-new-tag"
									label={<Trans>Create a tag and assign it</Trans>}
									value={newTagName}
									maxLength={60}
									onChange={(event) => setNewTagName(event.target.value)}
									placeholder={_(msg`Tag name`)}
									data-testid="guest-new-tag"
								/>
								<Button
									type="submit"
									className="h-11 md:h-8"
									disabled={busy || newTagName.trim() === ''}
									data-testid="guest-new-tag-submit"
								>
									<Trans>Create</Trans>
								</Button>
							</form>
						</div>
					</div>
				) : null}
			</GuestProfileCard>

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

			<Frame
				role="region"
				aria-labelledby="guest-history-title"
				data-testid="guest-history"
			>
				<FrameHeader>
					<FrameTitle id="guest-history-title">
						<Trans>Visit history</Trans>
					</FrameTitle>
				</FrameHeader>
				{profile.visits.length === 0 ? (
					<FramePanel>
						<p
							className="text-muted-foreground text-sm"
							data-testid="guest-history-empty"
						>
							<Trans>No bookings yet.</Trans>
						</p>
					</FramePanel>
				) : (
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
										<span className="inline-flex flex-wrap items-center gap-x-2">
											<StatusLabel
												status={visit.status}
												testId={`guest-visit-status-${visit.id}`}
											/>
											{visit.lateCancel ? (
												<span className="text-warning text-xs">
													<Trans>Late</Trans>
												</span>
											) : null}
										</span>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</Frame>

			{writable ? (
				<Frame
					role="region"
					aria-labelledby="guest-data-title"
					data-testid="guest-data-section"
				>
					<FrameHeader>
						<FrameTitle id="guest-data-title">
							<Trans>Duplicates and data</Trans>
						</FrameTitle>
						<FrameDescription>
							<Trans>
								Changes here affect the whole profile and cannot be undone.
							</Trans>
						</FrameDescription>
					</FrameHeader>
					<FramePanel className="flex flex-col gap-3">
						<Item variant="muted">
							<ItemContent>
								<ItemTitle>
									<Trans>Merge a duplicate</Trans>
								</ItemTitle>
								<ItemDescription>
									<Trans>
										Move another profile's bookings, tags and notes into this
										one and close the duplicate.
									</Trans>
								</ItemDescription>
							</ItemContent>
							<ItemActions>
								<Button
									type="button"
									variant="outline"
									disabled={busy}
									onClick={() => setMergeOpen(true)}
									data-testid="guest-merge"
								>
									<Trans>Merge duplicate</Trans>
								</Button>
							</ItemActions>
						</Item>
						<Item variant="muted">
							<ItemContent>
								<ItemTitle>
									<Trans>Erase this guest</Trans>
								</ItemTitle>
								<ItemDescription>
									<Trans>
										Removes the name, contact details, tags and notes. Visit
										counts and past bookings stay.
									</Trans>
								</ItemDescription>
							</ItemContent>
							<ItemActions>
								<Button
									type="button"
									variant="destructive"
									disabled={busy}
									onClick={() => setEraseOpen(true)}
									data-testid="guest-erase"
								>
									<Trans>Erase guest</Trans>
								</Button>
							</ItemActions>
						</Item>
					</FramePanel>
				</Frame>
			) : null}

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
					className="flex flex-col gap-5"
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
						<TextField
							id="guest-first-name"
							label={<Trans>First name</Trans>}
							value={firstName}
							maxLength={120}
							required
							onChange={(event) => setFirstName(event.target.value)}
							data-testid="guest-first-name"
						/>
						<TextField
							id="guest-last-name"
							label={<Trans>Last name</Trans>}
							value={lastName}
							maxLength={120}
							onChange={(event) => setLastName(event.target.value)}
							data-testid="guest-last-name"
						/>
					</div>
					<TextField
						id="guest-phone-input"
						label={<Trans>Phone</Trans>}
						type="tel"
						dir="ltr"
						value={phone}
						onChange={(event) => setPhone(event.target.value)}
						data-testid="guest-phone-input"
					/>
					<TextField
						id="guest-email-input"
						label={<Trans>Email</Trans>}
						type="email"
						dir="ltr"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						data-testid="guest-email-input"
					/>
					<TextAreaField
						id="guest-allergy-input"
						label={<Trans>Allergies and dietary needs</Trans>}
						value={allergy}
						maxLength={1000}
						onChange={(event) => setAllergy(event.target.value)}
						data-testid="guest-allergy-input"
					/>
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
