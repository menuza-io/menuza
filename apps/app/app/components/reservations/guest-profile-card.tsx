import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameAction,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { type ReactNode } from 'react'
import { GuestTagBadge } from '#app/components/reservations/guests/guest-tag-badge.tsx'
import { type GuestRow } from '#app/utils/reservations/guests-api.ts'
import { formatInstantDate } from '#app/utils/reservations/guests-view.ts'

function Stat({
	label,
	value,
	testId,
}: {
	label: ReactNode
	value: ReactNode
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

/**
 * The Overview section of a guest profile: contact details, visit counters,
 * allergies, pinned notes and tags. Pure display: the screen owns every write,
 * so the same card can sit in a sheet or on the profile page. `children` render
 * under the tags (the tag manager).
 */
export function GuestProfileCard({
	guest,
	pinnedNotes,
	canManage,
	busy,
	onEdit,
	onRemoveTag,
	children,
}: {
	guest: GuestRow
	pinnedNotes: Array<{ id: string; body: string }>
	canManage: boolean
	busy?: boolean
	onEdit?: () => void
	onRemoveTag?: (tagId: string) => void
	children?: ReactNode
}) {
	const { _, i18n } = useLingui()
	const removeTagLabel = (name: string) => _(msg`Remove tag ${name}`)
	const erased = guest.erasedAt !== null
	return (
		<Frame
			role="region"
			aria-labelledby="guest-overview-title"
			data-testid="guest-profile-card"
		>
			<FrameHeader>
				<FrameTitle id="guest-overview-title">
					<Trans>Overview</Trans>
				</FrameTitle>
				<FrameDescription>
					<span className="flex flex-col">
						{guest.phone ? (
							<bdi dir="ltr" className="text-start" data-testid="guest-phone">
								{guest.phone}
							</bdi>
						) : null}
						{guest.email ? (
							<bdi
								dir="ltr"
								className="text-start wrap-anywhere"
								data-testid="guest-email"
							>
								{guest.email}
							</bdi>
						) : null}
						{!guest.phone && !guest.email ? (
							<span>
								<Trans>No contact details</Trans>
							</span>
						) : null}
					</span>
				</FrameDescription>
				<FrameAction>
					<div className="flex flex-wrap items-center gap-2">
						{guest.customerLinked ? (
							<Badge variant="secondary" data-testid="guest-customer-linked">
								<Icon name="link-2" />
								<Trans>Linked customer</Trans>
							</Badge>
						) : null}
						{canManage && !erased && onEdit ? (
							<Button
								type="button"
								variant="outline"
								disabled={busy}
								onClick={onEdit}
								data-testid="guest-edit"
							>
								<Trans>Edit details</Trans>
							</Button>
						) : null}
					</div>
				</FrameAction>
			</FrameHeader>

			<FramePanel className="flex flex-col gap-5">
				<dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
					<Stat
						testId="guest-stat-visits"
						label={<Trans>Visits</Trans>}
						value={guest.visits}
					/>
					<Stat
						testId="guest-stat-covers"
						label={<Trans>Covers</Trans>}
						value={guest.covers}
					/>
					<Stat
						testId="guest-stat-no-shows"
						label={<Trans>No-shows</Trans>}
						value={guest.noShows}
					/>
					<Stat
						testId="guest-stat-late-cancels"
						label={<Trans>Late cancels</Trans>}
						value={guest.lateCancels}
					/>
					<Stat
						testId="guest-stat-cancels"
						label={<Trans>Cancellations</Trans>}
						value={guest.cancels}
					/>
					<Stat
						testId="guest-stat-last-visit"
						label={<Trans>Last visit</Trans>}
						value={formatInstantDate(guest.lastVisitAt, i18n.locale) ?? '—'}
					/>
				</dl>

				{guest.allergyNotes ? (
					<div
						className="bg-warning/12 text-warning rounded-md px-3 py-2 text-sm"
						data-testid="guest-allergy"
					>
						<span className="font-medium">
							<Trans>Allergies and dietary needs:</Trans>
						</span>{' '}
						<span className="wrap-anywhere">{guest.allergyNotes}</span>
					</div>
				) : null}

				{pinnedNotes.length > 0 ? (
					<ul
						className="flex flex-col gap-1.5"
						aria-label={_(msg`Pinned notes`)}
						data-testid="guest-pinned-notes"
					>
						{pinnedNotes.map((note) => (
							<li
								key={note.id}
								className="bg-muted flex items-start gap-2 rounded-md px-3 py-2 text-sm"
							>
								<Icon name="star" className="mt-0.5 size-3.5 shrink-0" />
								<span className="wrap-anywhere">{note.body}</span>
							</li>
						))}
					</ul>
				) : null}

				{guest.tags.length > 0 ? (
					<div className="flex flex-wrap gap-1.5" data-testid="guest-tags">
						{guest.tags.map((tag) => (
							<span key={tag.id} className="inline-flex items-center gap-0.5">
								<GuestTagBadge tag={tag} />
								{canManage && !erased && !tag.system && onRemoveTag ? (
									<Button
										type="button"
										variant="ghost"
										size="icon-xs"
										className="text-muted-foreground"
										disabled={busy}
										aria-label={removeTagLabel(tag.name)}
										onClick={() => onRemoveTag(tag.id)}
										data-testid={`guest-tag-remove-${tag.id}`}
									>
										<Icon name="x" />
									</Button>
								) : null}
							</span>
						))}
					</div>
				) : null}

				{children}
			</FramePanel>
		</Frame>
	)
}
