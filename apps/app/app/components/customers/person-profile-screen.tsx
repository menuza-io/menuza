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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import {
	Frame,
	FrameAction,
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
import { WorkspacePage } from '@repo/ui/workspace'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { StatusBadge } from '#app/components/customers/people-list-screen.tsx'
import { PersonMergeDialog } from '#app/components/customers/person-merge-dialog.tsx'
import { PersonNotesPanel } from '#app/components/customers/person-notes-panel.tsx'
import { PersonTagBadge } from '#app/components/customers/person-tag-badge.tsx'
import { StatusLabel } from '#app/components/reservations/status-style.tsx'
import {
	SelectField,
	TextAreaField,
	TextField,
} from '#app/components/staff/controls.tsx'
import { customersHref } from '#app/utils/people/customers-link.ts'
import {
	addPersonNote,
	assignPersonTag,
	createPeopleTag,
	deletePersonNote,
	erasePerson,
	exportPerson,
	fetchPeopleTags,
	fetchPerson,
	mergePeople,
	type PeopleClient,
	type PersonPatch,
	type PersonProfile,
	type PersonSubscription,
	type PersonTag,
	removePersonTag,
	updatePerson,
	updatePersonNote,
} from '#app/utils/people/people-api.ts'
import {
	peopleErrorInfo,
	peopleErrorMessage,
} from '#app/utils/people/people-errors.ts'
import {
	downloadJson,
	formatBusinessDate,
	formatInstantDate,
	formatLocalMinutes,
	personTagName,
} from '#app/utils/people/people-view.ts'
import { CHANNEL_LABELS, enumLabel } from '#app/utils/reservations/labels.ts'

type LoadState = 'loading' | 'ready' | 'missing' | 'denied' | 'failed'

const FAIL_TAG = msg`The tag could not be changed. Try again.`
const FAIL_NOTE = msg`The note could not be saved. Try again.`
const FAIL_SAVE = msg`The details could not be saved. Try again.`
const FAIL_ERASE = msg`The customer could not be erased. Try again.`

const TOPIC_LABELS: Record<string, MessageDescriptor> = {
	drops: msg`Drops`,
	reservations: msg`Reservations`,
}
const CHANNEL_NAMES: Record<string, MessageDescriptor> = {
	sms: msg`SMS`,
	email: msg`Email`,
}
const SOURCE_LABELS: Record<string, MessageDescriptor> = {
	menu: msg`Menu`,
	drops_page: msg`Drops page`,
	drop_page: msg`Drop page`,
	order_success: msg`After an order`,
	profile: msg`Profile`,
	reservation_booking: msg`Booking form`,
}

function Stat({
	label,
	value,
	testId,
}: {
	label: React.ReactNode
	value: React.ReactNode
	testId: string
}) {
	return (
		<div className="flex flex-col gap-0.5" data-testid={testId}>
			<dt className="text-muted-foreground text-xs">{label}</dt>
			<dd className="text-lg font-semibold tabular-nums">
				<bdi>{value}</bdi>
			</dd>
		</div>
	)
}

export function PersonProfileScreen({
	client,
	orgSlug,
	personKey,
}: {
	client: PeopleClient
	orgSlug: string
	personKey: string
}) {
	const { _, i18n } = useLingui()
	const navigate = useNavigate()
	const [profile, setProfile] = useState<PersonProfile | null>(null)
	const [catalog, setCatalog] = useState<PersonTag[]>([])
	const [state, setState] = useState<LoadState>('loading')
	const [busy, setBusy] = useState(false)
	const [editOpen, setEditOpen] = useState(false)
	const [mergeOpen, setMergeOpen] = useState(false)
	const [eraseOpen, setEraseOpen] = useState(false)
	const [newTagName, setNewTagName] = useState('')
	const [assignTagId, setAssignTagId] = useState('')

	const reload = useCallback(
		async (signal?: AbortSignal, key = personKey) => {
			try {
				const next = await fetchPerson(client, key, signal)
				if (signal?.aborted) return
				setProfile(next)
				setState('ready')
				if (next.access.dining !== 'none') {
					fetchPeopleTags(client, signal)
						.then((tags) => {
							if (!signal?.aborted) setCatalog(tags)
						})
						.catch(() => {
							// The tag manager is optional; the profile reports its own errors.
						})
				}
				// A guest key resolves to its customer, a consent shadow to its guest,
				// a merged guest to the survivor: show the person under that key.
				if (next.canonicalKey !== key) {
					void navigate(
						customersHref(orgSlug, { personKey: next.canonicalKey }),
						{ replace: true },
					)
				}
			} catch (err) {
				if (signal?.aborted) return
				const { status } = peopleErrorInfo(err)
				setState(
					status === 404 ? 'missing' : status === 403 ? 'denied' : 'failed',
				)
			}
		},
		[client, navigate, orgSlug, personKey],
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
			reloadKey?: string,
		): Promise<boolean> => {
			setBusy(true)
			try {
				await action()
				if (messages.success) toast.success(messages.success)
				return true
			} catch (err) {
				toast.error(peopleErrorMessage(err, _, messages.failure))
				return false
			} finally {
				await reload(undefined, reloadKey ?? profile?.canonicalKey ?? personKey)
				setBusy(false)
			}
		},
		[_, personKey, profile?.canonicalKey, reload],
	)

	const backLink = (
		<Button
			variant="outline"
			size="icon"
			render={<Link to={customersHref(orgSlug)} />}
			aria-label={_(msg`Back to customers`)}
			data-testid="person-back"
		>
			<Icon name="arrow-left" className="rtl:rotate-180" />
		</Button>
	)

	if (state === 'loading' && !profile) {
		return (
			<WorkspacePage>
				<div
					className="flex flex-col gap-6"
					role="status"
					aria-busy="true"
					data-testid="person-profile-loading"
				>
					<span className="sr-only">
						<Trans>Loading customer...</Trans>
					</span>
					<Skeleton className="h-8 w-56" />
					<Skeleton className="h-40 w-full rounded-xl" />
					<Skeleton className="h-32 w-full rounded-xl" />
				</div>
			</WorkspacePage>
		)
	}

	if (state !== 'ready' || !profile) {
		return (
			<WorkspacePage>
				<div className="flex flex-col gap-6" data-testid="person-profile-error">
					<div>{backLink}</div>
					<Alert variant="destructive">
						<Icon name="alert-triangle" />
						<AlertDescription>
							{state === 'missing' ? (
								<Trans>This customer does not exist.</Trans>
							) : state === 'denied' ? (
								<Trans>You do not have access to this customer.</Trans>
							) : (
								<Trans>The customer profile could not be loaded.</Trans>
							)}
						</AlertDescription>
					</Alert>
				</div>
			</WorkspacePage>
		)
	}

	const { access, dining, customer, marketing } = profile
	const key = profile.canonicalKey
	const guest = dining?.guest ?? null
	const full = access.dining === 'full'
	const canEditContact = profile.customer
		? access.canUpdateCustomers
		: access.canUpdateDining
	const canEditAllergy = full && access.canUpdateDining && guest !== null
	const canEdit = canEditContact || canEditAllergy
	const canTag = access.canUpdateDining && guest !== null
	const assignable = catalog.filter(
		(tag) => !tag.system && !guest?.tags.some((own) => own.id === tag.id),
	)
	const hasDiningAccess = access.dining !== 'none'
	const removeTagLabel = (tagName: string) => _(msg`Remove tag ${tagName}`)

	const exportJson = async (includeSensitive: boolean) => {
		setBusy(true)
		try {
			const data = await exportPerson(client, key, includeSensitive)
			const ok = downloadJson(
				`customer-${key}${includeSensitive ? '-sensitive' : ''}.json`,
				data,
			)
			if (ok) toast.success(_(msg`Export downloaded.`))
		} catch (err) {
			toast.error(
				peopleErrorMessage(err, _, msg`The export failed. Try again.`),
			)
		} finally {
			setBusy(false)
		}
	}

	return (
		<WorkspacePage>
			<div className="flex flex-col gap-6" data-testid="person-profile-screen">
				<div className="flex items-start gap-3">
					{backLink}
					<div className="min-w-0 flex-1">
						<PageHeader
							title={
								<span data-testid="person-profile-name">{profile.name}</span>
							}
							description={
								<span className="inline-flex flex-wrap items-center gap-2">
									<StatusBadge status={profile.status} />
									{profile.walkIn ? (
										<Badge variant="outline">
											<Trans>Walk-in</Trans>
										</Badge>
									) : null}
								</span>
							}
							actions={
								guest && full ? (
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button
													type="button"
													variant="outline"
													disabled={busy}
													data-testid="person-export-menu"
												/>
											}
										>
											<Icon name="download" />
											<Trans>Export</Trans>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem
												onClick={() => void exportJson(false)}
												data-testid="person-export"
											>
												<Trans>Export JSON</Trans>
											</DropdownMenuItem>
											{access.canUpdateDining ? (
												<DropdownMenuItem
													onClick={() => void exportJson(true)}
													data-testid="person-export-sensitive"
												>
													<Trans>Export with sensitive data</Trans>
												</DropdownMenuItem>
											) : null}
										</DropdownMenuContent>
									</DropdownMenu>
								) : null
							}
						/>
					</div>
				</div>

				<Frame
					role="region"
					aria-labelledby="person-contact-title"
					data-testid="person-contact"
				>
					<FrameHeader>
						<FrameTitle id="person-contact-title">
							<Trans>Contact</Trans>
						</FrameTitle>
						<FrameDescription>
							<span className="flex flex-col">
								{profile.phone ? (
									<bdi
										dir="ltr"
										className="text-start"
										data-testid="person-phone"
									>
										{profile.phone}
									</bdi>
								) : null}
								{profile.email ? (
									<bdi
										dir="ltr"
										className="text-start wrap-anywhere"
										data-testid="person-email"
									>
										{profile.email}
									</bdi>
								) : null}
								{!profile.phone && !profile.email ? (
									<span>
										<Trans>No contact details</Trans>
									</span>
								) : null}
							</span>
						</FrameDescription>
						{canEdit ? (
							<FrameAction>
								<Button
									type="button"
									variant="outline"
									disabled={busy}
									onClick={() => setEditOpen(true)}
									data-testid="person-edit"
								>
									<Trans>Edit details</Trans>
								</Button>
							</FrameAction>
						) : null}
					</FrameHeader>
					{customer ? (
						<FramePanel>
							<dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
								<Stat
									testId="person-stat-joined"
									label={<Trans>Customer since</Trans>}
									value={
										formatInstantDate(customer.createdAt, i18n.locale) ?? '—'
									}
								/>
								<Stat
									testId="person-stat-orders"
									label={<Trans>Orders</Trans>}
									value={customer.orders.count}
								/>
								<Stat
									testId="person-stat-last-order"
									label={<Trans>Last order</Trans>}
									value={
										formatInstantDate(
											customer.orders.lastOrderAt,
											i18n.locale,
										) ?? '—'
									}
								/>
							</dl>
						</FramePanel>
					) : null}
				</Frame>

				{hasDiningAccess ? (
					<Frame
						role="region"
						aria-labelledby="person-dining-title"
						data-testid="person-dining"
					>
						<FrameHeader>
							<FrameTitle id="person-dining-title">
								<Trans>Dining</Trans>
							</FrameTitle>
							<FrameDescription>
								<Trans>
									Reservation history, tags and notes. These are counted from
									bookings and are not the same as orders.
								</Trans>
							</FrameDescription>
						</FrameHeader>
						{guest ? (
							<FramePanel className="flex flex-col gap-5">
								<dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
									<Stat
										testId="person-stat-visits"
										label={<Trans>Visits</Trans>}
										value={guest.visits}
									/>
									<Stat
										testId="person-stat-covers"
										label={<Trans>Covers</Trans>}
										value={guest.covers}
									/>
									<Stat
										testId="person-stat-no-shows"
										label={<Trans>No-shows</Trans>}
										value={guest.noShows}
									/>
									<Stat
										testId="person-stat-late-cancels"
										label={<Trans>Late cancels</Trans>}
										value={guest.lateCancels}
									/>
									<Stat
										testId="person-stat-last-visit"
										label={<Trans>Last visit</Trans>}
										value={
											formatInstantDate(guest.lastVisitAt, i18n.locale) ?? '—'
										}
									/>
									<Stat
										testId="person-stat-next-booking"
										label={<Trans>Next booking</Trans>}
										value={
											formatInstantDate(dining!.nextBookingAt, i18n.locale) ??
											'—'
										}
									/>
								</dl>

								{guest.allergyNotes ? (
									<div
										className="bg-warning/12 text-warning rounded-md px-3 py-2 text-sm"
										data-testid="person-allergy"
									>
										<span className="font-medium">
											<Trans>Allergies and dietary needs:</Trans>
										</span>{' '}
										<span className="wrap-anywhere">{guest.allergyNotes}</span>
									</div>
								) : null}

								{dining!.pinnedNotes.length > 0 ? (
									<ul
										className="flex flex-col gap-1.5"
										aria-label={_(msg`Pinned notes`)}
										data-testid="person-pinned-notes"
									>
										{dining!.pinnedNotes.map((note) => (
											<li
												key={note.id}
												className="bg-muted flex items-start gap-2 rounded-md px-3 py-2 text-sm"
											>
												<Icon
													name="star"
													className="mt-0.5 size-3.5 shrink-0"
												/>
												<span className="wrap-anywhere">{note.body}</span>
											</li>
										))}
									</ul>
								) : null}

								{guest.tags.length > 0 ? (
									<div
										className="flex flex-wrap gap-1.5"
										data-testid="person-tags"
									>
										{guest.tags.map((tag) => (
											<span
												key={tag.id}
												className="inline-flex items-center gap-0.5"
											>
												<PersonTagBadge tag={tag} />
												{canTag && !tag.system ? (
													<Button
														type="button"
														variant="ghost"
														size="icon-xs"
														className="text-muted-foreground"
														disabled={busy}
														aria-label={removeTagLabel(tag.name)}
														onClick={() =>
															void write(
																() => removePersonTag(client, key, tag.id),
																{
																	failure: FAIL_TAG,
																},
															)
														}
														data-testid={`person-tag-remove-${tag.id}`}
													>
														<Icon name="x" />
													</Button>
												) : null}
											</span>
										))}
									</div>
								) : null}

								{canTag ? (
									<div
										className="border-border flex flex-col gap-4 border-t pt-5"
										data-testid="person-tag-manager"
									>
										<h3 className="text-sm font-medium">
											<Trans>Tags</Trans>
										</h3>
										<div className="grid gap-4 sm:grid-cols-2">
											<div className="flex items-end gap-2">
												<SelectField
													className="min-w-0 flex-1"
													id="person-assign-tag"
													label={<Trans>Assign a tag</Trans>}
													options={assignable.map((tag) => ({
														value: tag.id,
														label: personTagName(_, tag),
													}))}
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
																() => assignPersonTag(client, key, assignTagId),
																{ failure: FAIL_TAG },
															)
														) {
															setAssignTagId('')
														}
													}}
													data-testid="person-assign-tag-submit"
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
															const tag = await createPeopleTag(client, {
																name,
															})
															await assignPersonTag(client, key, tag.id)
														},
														{ failure: FAIL_TAG },
													)
													if (ok) setNewTagName('')
												}}
											>
												<TextField
													className="min-w-0 flex-1"
													id="person-new-tag"
													label={<Trans>Create a tag and assign it</Trans>}
													value={newTagName}
													maxLength={60}
													onChange={(event) =>
														setNewTagName(event.target.value)
													}
													placeholder={_(msg`Tag name`)}
													data-testid="person-new-tag"
												/>
												<Button
													type="submit"
													className="h-11 md:h-8"
													disabled={busy || newTagName.trim() === ''}
													data-testid="person-new-tag-submit"
												>
													<Trans>Create</Trans>
												</Button>
											</form>
										</div>
									</div>
								) : null}
							</FramePanel>
						) : (
							<FramePanel>
								<p
									className="text-muted-foreground text-sm"
									data-testid="person-dining-empty"
								>
									<Trans>No reservations yet.</Trans>
								</p>
							</FramePanel>
						)}
					</Frame>
				) : null}

				{guest && full ? (
					<PersonNotesPanel
						notes={dining!.notes}
						canManage={access.canUpdateDining}
						busy={busy}
						onAdd={(body, pinned) =>
							write(() => addPersonNote(client, key, { body, pinned }), {
								failure: FAIL_NOTE,
							})
						}
						onUpdate={(noteId, patch) =>
							write(() => updatePersonNote(client, key, noteId, patch), {
								failure: FAIL_NOTE,
							})
						}
						onDelete={(noteId) =>
							write(() => deletePersonNote(client, key, noteId), {
								failure: FAIL_NOTE,
							})
						}
					/>
				) : null}

				{guest ? (
					<Frame
						role="region"
						aria-labelledby="person-history-title"
						data-testid="person-history"
					>
						<FrameHeader>
							<FrameTitle id="person-history-title">
								<Trans>Reservation history</Trans>
							</FrameTitle>
						</FrameHeader>
						{dining!.reservations.length === 0 ? (
							<FramePanel>
								<p
									className="text-muted-foreground text-sm"
									data-testid="person-history-empty"
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
									{dining!.reservations.map((visit) => (
										<TableRow
											key={visit.id}
											data-testid={`person-visit-${visit.id}`}
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
														testId={`person-visit-status-${visit.id}`}
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
				) : null}

				{customer || marketing ? (
					<MarketingSection marketing={marketing?.subscriptions ?? null} />
				) : null}

				{canEdit || access.canDelete || (guest && access.canUpdateDining) ? (
					<Frame
						role="region"
						aria-labelledby="person-data-title"
						data-testid="person-data-section"
					>
						<FrameHeader>
							<FrameTitle id="person-data-title">
								<Trans>Duplicates and data</Trans>
							</FrameTitle>
							<FrameDescription>
								<Trans>
									Changes here affect the whole profile and cannot be undone.
								</Trans>
							</FrameDescription>
						</FrameHeader>
						<FramePanel className="flex flex-col gap-3">
							{guest && access.canUpdateDining ? (
								<Item variant="muted">
									<ItemContent>
										<ItemTitle>
											<Trans>Merge a duplicate</Trans>
										</ItemTitle>
										<ItemDescription>
											<Trans>
												Move another person's bookings, tags and notes into this
												profile and close the duplicate. Orders and sign-in are
												not changed.
											</Trans>
										</ItemDescription>
									</ItemContent>
									<ItemActions>
										<Button
											type="button"
											variant="outline"
											disabled={busy}
											onClick={() => setMergeOpen(true)}
											data-testid="person-merge"
										>
											<Trans>Merge duplicate</Trans>
										</Button>
									</ItemActions>
								</Item>
							) : null}
							{access.canDelete ? (
								<Item variant="muted">
									<ItemContent>
										<ItemTitle>
											<Trans>Erase this customer</Trans>
										</ItemTitle>
										<ItemDescription>
											<Trans>
												Removes the name and contact details everywhere they are
												kept: reservations, orders, marketing choices and
												messages.
											</Trans>
										</ItemDescription>
									</ItemContent>
									<ItemActions>
										<Button
											type="button"
											variant="destructive"
											disabled={busy}
											onClick={() => setEraseOpen(true)}
											data-testid="person-erase"
										>
											<Trans>Erase customer</Trans>
										</Button>
									</ItemActions>
								</Item>
							) : null}
						</FramePanel>
					</Frame>
				) : null}

				<EditPersonDialog
					open={editOpen}
					onOpenChange={setEditOpen}
					profile={profile}
					canEditContact={canEditContact}
					canEditAllergy={canEditAllergy}
					busy={busy}
					onSave={(patch) =>
						write(() => updatePerson(client, key, patch), {
							success: _(msg`Details saved.`),
							failure: FAIL_SAVE,
						})
					}
				/>

				{guest ? (
					<PersonMergeDialog
						open={mergeOpen}
						onOpenChange={setMergeOpen}
						client={client}
						currentKey={key}
						currentName={profile.name}
						busy={busy}
						onMerge={async (duplicate) => {
							setBusy(true)
							try {
								const merged = await mergePeople(client, {
									keepKey: key,
									mergeKey: duplicate.key,
									keepVersion: guest.version,
								})
								toast.success(_(msg`Customers merged.`))
								await reload(undefined, merged.key)
							} finally {
								setBusy(false)
							}
						}}
					/>
				) : null}

				<ErasePersonDialog
					open={eraseOpen}
					onOpenChange={(next) => {
						if (!busy) setEraseOpen(next)
					}}
					name={profile.name}
					busy={busy}
					onConfirm={async () => {
						setBusy(true)
						try {
							await erasePerson(client, key)
							toast.success(_(msg`Customer erased.`))
							setEraseOpen(false)
							void navigate(customersHref(orgSlug))
						} catch (err) {
							toast.error(peopleErrorMessage(err, _, FAIL_ERASE))
						} finally {
							setBusy(false)
						}
					}}
				/>
			</div>
		</WorkspacePage>
	)
}

function MarketingSection({
	marketing,
}: {
	marketing: PersonSubscription[] | null
}) {
	const { _, i18n } = useLingui()
	return (
		<Frame
			role="region"
			aria-labelledby="person-marketing-title"
			data-testid="person-marketing"
		>
			<FrameHeader>
				<FrameTitle id="person-marketing-title">
					<Trans>Marketing messages</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>
						What this person agreed to receive. This is the only place consent
						is recorded; broadcasts and automations follow it.
					</Trans>
				</FrameDescription>
			</FrameHeader>
			{marketing && marketing.length > 0 ? (
				<Table variant="card">
					<TableHeader>
						<TableRow>
							<TableHead>
								<Trans>Topic</Trans>
							</TableHead>
							<TableHead>
								<Trans>Channel</Trans>
							</TableHead>
							<TableHead>
								<Trans>Status</Trans>
							</TableHead>
							<TableHead>
								<Trans>Since</Trans>
							</TableHead>
							<TableHead>
								<Trans>Source</Trans>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{marketing.map((row) => (
							<TableRow
								key={`${row.topic}:${row.channel}`}
								data-testid={`person-subscription-${row.topic}-${row.channel}`}
							>
								<TableCell>
									{TOPIC_LABELS[row.topic]
										? _(TOPIC_LABELS[row.topic]!)
										: row.topic}
								</TableCell>
								<TableCell>
									{CHANNEL_NAMES[row.channel]
										? _(CHANNEL_NAMES[row.channel]!)
										: row.channel}
								</TableCell>
								<TableCell>
									{row.subscribed ? (
										<Badge variant="success">
											<Trans>Subscribed</Trans>
										</Badge>
									) : (
										<Badge variant="outline">
											<Trans>Unsubscribed</Trans>
										</Badge>
									)}
								</TableCell>
								<TableCell className="text-muted-foreground text-sm">
									{formatInstantDate(
										row.unsubscribedAt ?? row.subscribedAt,
										i18n.locale,
									) ?? '—'}
								</TableCell>
								<TableCell className="text-muted-foreground text-sm">
									{SOURCE_LABELS[row.source]
										? _(SOURCE_LABELS[row.source]!)
										: row.source}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			) : (
				<FramePanel>
					<p
						className="text-muted-foreground text-sm"
						data-testid="person-marketing-empty"
					>
						<Trans>No marketing choices recorded.</Trans>
					</p>
				</FramePanel>
			)}
		</Frame>
	)
}

function EditPersonDialog({
	open,
	onOpenChange,
	profile,
	canEditContact,
	canEditAllergy,
	busy,
	onSave,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	profile: PersonProfile
	canEditContact: boolean
	canEditAllergy: boolean
	busy: boolean
	onSave: (patch: PersonPatch) => Promise<boolean>
}) {
	const guest = profile.dining?.guest ?? null
	const [name, setName] = useState(profile.name)
	const [phone, setPhone] = useState(profile.phone ?? '')
	const [email, setEmail] = useState(profile.email ?? '')
	const [allergy, setAllergy] = useState(guest?.allergyNotes ?? '')
	// A customer's phone is managed through sign-in; a guest-only phone is editable.
	const phoneEditable = canEditContact && profile.customer === null

	useEffect(() => {
		if (!open) return
		setName(profile.name)
		setPhone(profile.phone ?? '')
		setEmail(profile.email ?? '')
		setAllergy(guest?.allergyNotes ?? '')
	}, [open, profile, guest?.allergyNotes])

	return (
		<Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
			<DialogContent data-testid="person-edit-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Edit details</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Changes apply to the profile only, not to past bookings or orders.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-5"
					onSubmit={async (event) => {
						event.preventDefault()
						const patch: PersonPatch = {}
						if (canEditContact) {
							patch.name = name.trim()
							patch.email = email.trim() || null
							if (phoneEditable) patch.phone = phone.trim() || null
						}
						if (canEditAllergy) patch.allergyNotes = allergy.trim() || null
						if (guest) patch.expectedVersion = guest.version
						const ok = await onSave(patch)
						if (ok) onOpenChange(false)
					}}
				>
					{canEditContact ? (
						<>
							<TextField
								id="person-name-input"
								label={<Trans>Name</Trans>}
								value={name}
								maxLength={100}
								required
								onChange={(event) => setName(event.target.value)}
								data-testid="person-name-input"
							/>
							{phoneEditable ? (
								<TextField
									id="person-phone-input"
									label={<Trans>Phone</Trans>}
									type="tel"
									dir="ltr"
									value={phone}
									onChange={(event) => setPhone(event.target.value)}
									data-testid="person-phone-input"
								/>
							) : profile.phone ? (
								<div className="space-y-1">
									<p className="text-muted-foreground text-sm">
										<Trans>Phone</Trans>
									</p>
									<p className="text-sm">
										<bdi dir="ltr">{profile.phone}</bdi>
									</p>
									<p className="text-muted-foreground text-xs">
										<Trans>The phone number is managed through sign-in.</Trans>
									</p>
								</div>
							) : null}
							<TextField
								id="person-email-input"
								label={<Trans>Email</Trans>}
								type="email"
								dir="ltr"
								value={email}
								onChange={(event) => setEmail(event.target.value)}
								data-testid="person-email-input"
							/>
						</>
					) : null}
					{canEditAllergy ? (
						<TextAreaField
							id="person-allergy-input"
							label={<Trans>Allergies and dietary needs</Trans>}
							value={allergy}
							maxLength={1000}
							onChange={(event) => setAllergy(event.target.value)}
							data-testid="person-allergy-input"
						/>
					) : null}
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
							disabled={busy || (canEditContact && name.trim() === '')}
							data-testid="person-edit-save"
						>
							<Trans>Save</Trans>
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

/**
 * The one erase flow. It states exactly what goes, and asks for the person's
 * name before the destructive button works.
 */
export function ErasePersonDialog({
	open,
	onOpenChange,
	name,
	busy,
	onConfirm,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	name: string
	busy: boolean
	onConfirm: () => Promise<void>
}) {
	const [typed, setTyped] = useState('')
	useEffect(() => {
		if (!open) setTyped('')
	}, [open])
	const matches =
		typed.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase() &&
		name.trim() !== ''
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent data-testid="person-erase-dialog">
				<AlertDialogHeader>
					<AlertDialogTitle>
						<Trans>Erase {name}?</Trans>
					</AlertDialogTitle>
					<AlertDialogDescription>
						<Trans>This permanently erases, for this person:</Trans>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<ul
					className="text-muted-foreground list-disc ps-5 text-sm"
					data-testid="person-erase-list"
				>
					<li>
						<Trans>
							Reservations: name, phone, email, allergy and notes. Upcoming
							bookings are cancelled and the guest is told first.
						</Trans>
					</li>
					<li>
						<Trans>
							Orders: the name, phone and email saved on each order.
						</Trans>
					</li>
					<li>
						<Trans>Marketing choices and the customer's sign-in.</Trans>
					</li>
					<li>
						<Trans>Messages and call records tied to this phone number.</Trans>
					</li>
				</ul>
				<p className="text-sm">
					<Trans>
						Visit counts and order totals stay, without a name. This cannot be
						undone.
					</Trans>
				</p>
				<TextField
					id="person-erase-confirm-input"
					label={<Trans>Type the name to confirm</Trans>}
					hint={<bdi>{name}</bdi>}
					value={typed}
					onChange={(event) => setTyped(event.target.value)}
					autoComplete="off"
					data-testid="person-erase-confirm-input"
				/>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={busy}>
						<Trans>Cancel</Trans>
					</AlertDialogCancel>
					<AlertDialogAction
						type="button"
						variant="destructive"
						disabled={busy || !matches}
						onClick={(event) => {
							event.preventDefault()
							void onConfirm()
						}}
						data-testid="person-erase-confirm"
					>
						<Trans>Erase customer</Trans>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
