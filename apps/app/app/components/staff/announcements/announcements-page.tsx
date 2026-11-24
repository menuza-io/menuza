import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
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
import { Icon } from '@repo/ui/icon'
import { Item, ItemGroup } from '@repo/ui/item'
import { PageHeader } from '@repo/ui/page-header'
import { Skeleton } from '@repo/ui/skeleton'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	SelectField,
	TextAreaField,
	TextField,
} from '#app/components/staff/controls.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import {
	announcementDetailSchema,
	announcementListSchema,
	announcementResultSchema,
	endOfLocalDay,
	type AnnouncementRow,
} from '#app/utils/staffing/announcement-types.ts'
import { positionsSchema } from '#app/utils/staffing/staff-types.ts'

type Props = {
	orgSlug: string
	scopes: ReadonlyArray<{ id: string; name: string }>
}

/**
 * Announcements to staff (#486): a short notice for everyone, a position or a
 * workplace. People see it on their My schedule page and on Station after their
 * next punch, and tap "Got it". Here the manager sees who did. There are no
 * replies, and an announcement stops showing on the date it expires.
 */
export function AnnouncementsPage({ orgSlug, scopes }: Props) {
	const { _, i18n } = useLingui()
	const { client, ready, can } = useStaffClient('staff')
	const canWrite = can(P.UPDATE_STAFF)
	const [showOld, setShowOld] = useState(false)
	const list = useStaffQuery(
		client,
		ready ? `/announcements?includeExpired=${showOld}` : null,
		announcementListSchema,
	)
	const positions = useStaffQuery(
		client,
		ready && canWrite ? '/positions' : null,
		positionsSchema,
	)
	const [writing, setWriting] = useState(false)
	const [openId, setOpenId] = useState<string | null>(null)
	const rows = list.data?.announcements ?? []
	const date = (ms: number) =>
		new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(ms)

	const audienceLabel = (row: AnnouncementRow) =>
		row.audience === 'everyone'
			? _(t`Everyone`)
			: row.audience === 'position'
				? (positions.data?.positions.find((p) => p.id === row.audienceId)
						?.name ?? _(t`A position`))
				: (scopes.find((s) => s.id === row.audienceId)?.name ??
					_(t`A workplace`))
	const stateLabel: Record<AnnouncementRow['state'], string> = {
		live: _(t`Showing`),
		scheduled: _(t`Scheduled`),
		expired: _(t`Expired`),
		withdrawn: _(t`Taken down`),
	}

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title={<Trans>Announcements</Trans>}
				description={
					<Trans>
						Tell your team something and see who has read it. They see it on My
						schedule and after their next punch on Station. No replies.
					</Trans>
				}
				actions={
					<>
						<Button
							variant="ghost"
							render={<Link to={`/${orgSlug}/staff/team`} />}
						>
							<Icon name="arrow-left" className="rtl:rotate-180" />
							<Trans>Team</Trans>
						</Button>
						{canWrite ? (
							<Button onClick={() => setWriting(true)}>
								<Icon name="plus" />
								<Trans>New announcement</Trans>
							</Button>
						) : null}
					</>
				}
			/>
			<label className="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					checked={showOld}
					onChange={(event) => setShowOld(event.target.checked)}
				/>
				<Trans>Show expired and taken down</Trans>
			</label>
			{list.loading ? (
				<Skeleton className="h-40 w-full" />
			) : list.error ? (
				<Alert variant="destructive">
					<AlertDescription>
						<Trans>We could not load announcements. Try again.</Trans>
					</AlertDescription>
				</Alert>
			) : rows.length === 0 ? (
				<EmptyState
					title={<Trans>No announcements</Trans>}
					description={
						<Trans>
							Write one to tell everyone, a position or a workplace something,
							and see who read it.
						</Trans>
					}
					icons={['bell', 'users', 'check']}
				/>
			) : (
				<ItemGroup className="gap-2">
					{rows.map((row) => {
						const read = row.read
						const total = row.recipients
						const until = date(row.expiresAt)
						return (
							<Item
								key={row.id}
								variant="outline"
								size="sm"
								role="listitem"
								className="cursor-pointer"
								onClick={() => setOpenId(row.id)}
							>
								<div className="flex w-full flex-col gap-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="text-sm font-medium wrap-anywhere">
											{row.title}
										</span>
										<Badge variant="secondary">{audienceLabel(row)}</Badge>
										<Badge variant={row.state === 'live' ? 'outline' : 'ghost'}>
											{stateLabel[row.state]}
										</Badge>
									</div>
									<p className="text-muted-foreground text-sm tabular-nums">
										<Trans>
											{read} of {total} have read it
										</Trans>
										{' · '}
										<Trans>Until {until}</Trans>
									</p>
								</div>
							</Item>
						)
					})}
				</ItemGroup>
			)}

			<WriteDialog
				open={writing}
				onClose={() => setWriting(false)}
				client={client}
				scopes={scopes}
				positions={positions.data?.positions ?? []}
				onSaved={list.reload}
			/>
			<DetailDialog
				id={openId}
				onClose={() => setOpenId(null)}
				client={client}
				canWrite={canWrite}
				audienceLabel={audienceLabel}
				onChanged={list.reload}
			/>
		</div>
	)
}

type Audience = 'everyone' | 'position' | 'scope'

function WriteDialog({
	open,
	onClose,
	client,
	scopes,
	positions,
	onSaved,
}: {
	open: boolean
	onClose: () => void
	client: ReturnType<typeof useStaffClient>['client']
	scopes: Props['scopes']
	positions: ReadonlyArray<{
		id: string
		name: string
		archivedAt: number | null
	}>
	onSaved: () => void
}) {
	const { _ } = useLingui()
	const action = useStaffAction()
	const [title, setTitle] = useState('')
	const [body, setBody] = useState('')
	const [audience, setAudience] = useState<Audience>('everyone')
	const [audienceId, setAudienceId] = useState('')
	const [until, setUntil] = useState('')
	const expiresAt = endOfLocalDay(until)
	const active = positions.filter((p) => p.archivedAt === null)
	const complete =
		title.trim() !== '' &&
		body.trim() !== '' &&
		expiresAt !== null &&
		expiresAt > Date.now() &&
		(audience === 'everyone' || audienceId !== '')

	function close() {
		setTitle('')
		setBody('')
		setAudience('everyone')
		setAudienceId('')
		setUntil('')
		action.reset()
		onClose()
	}

	async function save() {
		if (!complete || expiresAt === null) return
		const result = await action.run(() =>
			client.request('/announcements', {
				method: 'POST',
				json: {
					title: title.trim(),
					body: body.trim(),
					audience,
					...(audience === 'everyone' ? {} : { audienceId }),
					expiresAt,
				},
			}),
		)
		if (!result.ok) return
		toast.success(_(t`Announcement sent.`))
		onSaved()
		close()
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !next && close()}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>New announcement</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Plain text only. Do not put guest details in it. It stops showing
							on the date you choose.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<TextField
					label={<Trans>Title</Trans>}
					value={title}
					maxLength={120}
					onChange={(event) => setTitle(event.target.value)}
				/>
				<TextAreaField
					label={<Trans>Message</Trans>}
					rows={4}
					value={body}
					maxLength={2000}
					onChange={(event) => setBody(event.target.value)}
				/>
				<SelectField
					label={<Trans>Who is it for?</Trans>}
					value={audience}
					onValueChange={(value) => {
						setAudience(value as Audience)
						setAudienceId('')
					}}
					options={[
						{ value: 'everyone', label: _(t`Everyone`) },
						{ value: 'position', label: _(t`One position`) },
						...(scopes.length > 0
							? [{ value: 'scope', label: _(t`One workplace`) }]
							: []),
					]}
				/>
				{audience === 'position' ? (
					<SelectField
						label={<Trans>Position</Trans>}
						value={audienceId}
						onValueChange={setAudienceId}
						options={active.map((p) => ({ value: p.id, label: p.name }))}
					/>
				) : null}
				{audience === 'scope' ? (
					<SelectField
						label={<Trans>Workplace</Trans>}
						value={audienceId}
						onValueChange={setAudienceId}
						options={scopes.map((s) => ({ value: s.id, label: s.name }))}
					/>
				) : null}
				<TextField
					label={<Trans>Stops showing after</Trans>}
					type="date"
					value={until}
					onChange={(event) => setUntil(event.target.value)}
				/>
				{action.error ? (
					<Alert variant="destructive">
						<AlertDescription>{action.error}</AlertDescription>
					</Alert>
				) : null}
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={close}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						disabled={!complete || action.pending}
						onClick={() => void save()}
					>
						{action.pending ? <Trans>Sending…</Trans> : <Trans>Send</Trans>}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function DetailDialog({
	id,
	onClose,
	client,
	canWrite,
	audienceLabel,
	onChanged,
}: {
	id: string | null
	onClose: () => void
	client: ReturnType<typeof useStaffClient>['client']
	canWrite: boolean
	audienceLabel: (row: AnnouncementRow) => string
	onChanged: () => void
}) {
	const { _, i18n } = useLingui()
	const action = useStaffAction()
	const query = useStaffQuery(
		client,
		id ? `/announcements/${encodeURIComponent(id)}` : null,
		announcementDetailSchema,
	)
	const detail = query.data
	const time = (ms: number) =>
		new Intl.DateTimeFormat(i18n.locale, {
			dateStyle: 'medium',
			timeStyle: 'short',
		}).format(ms)
	const expires = detail ? time(detail.announcement.expiresAt) : ''
	const read = detail?.announcement.read ?? 0
	const total = detail?.announcement.recipients ?? 0

	async function withdraw() {
		if (!id) return
		const result = await action.run(async () =>
			announcementResultSchema.parse(
				await client.request(
					`/announcements/${encodeURIComponent(id)}/withdraw`,
					{
						method: 'POST',
					},
				),
			),
		)
		if (!result.ok) return
		toast.success(_(t`Announcement taken down.`))
		onChanged()
		query.reload()
	}

	return (
		<Dialog open={id !== null} onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
				{detail ? (
					<>
						<DialogHeader>
							<DialogTitle className="wrap-anywhere">
								{detail.announcement.title}
							</DialogTitle>
							<DialogDescription>
								{audienceLabel(detail.announcement)}
								{' · '}
								<Trans>Until {expires}</Trans>
							</DialogDescription>
						</DialogHeader>
						<p className="text-sm wrap-anywhere whitespace-pre-wrap">
							{detail.announcement.body}
						</p>
						<h3 className="text-sm font-medium">
							<Trans>
								{read} of {total} have read it
							</Trans>
						</h3>
						<ul className="flex flex-col gap-1 text-sm">
							{detail.recipients.map((person) => (
								<li
									key={person.staffId}
									className="flex items-center justify-between gap-3"
								>
									<span className="wrap-anywhere">
										<bdi>
											{person.firstName} {person.lastName}
										</bdi>
									</span>
									{person.readAt === null ? (
										<span className="text-muted-foreground">
											<Trans>Not yet</Trans>
										</span>
									) : (
										<span className="tabular-nums">
											<Icon name="check" className="me-1 inline size-4" />
											<bdi>{time(person.readAt)}</bdi>
										</span>
									)}
								</li>
							))}
						</ul>
						{action.error ? (
							<Alert variant="destructive">
								<AlertDescription>{action.error}</AlertDescription>
							</Alert>
						) : null}
						<DialogFooter>
							{canWrite && detail.announcement.state === 'live' ? (
								<Button
									type="button"
									variant="outline"
									disabled={action.pending}
									onClick={() => void withdraw()}
								>
									<Trans>Take it down</Trans>
								</Button>
							) : null}
							<Button type="button" onClick={onClose}>
								<Trans>Done</Trans>
							</Button>
						</DialogFooter>
					</>
				) : (
					<Skeleton className="h-40 w-full" />
				)}
			</DialogContent>
		</Dialog>
	)
}
