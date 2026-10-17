import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { GuestTagBadge } from '#app/components/reservations/guests/guest-tag-badge.tsx'
import { type GuestRow } from '#app/utils/reservations/guests-api.ts'
import { formatInstantDate } from '#app/utils/reservations/guests-view.ts'

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

/**
 * Contact details, visit counters, tags, and pinned notes of one guest. Pure
 * display: the screen owns every write, so the same card can sit in a sheet
 * or on the profile page.
 */
export function GuestProfileCard({
	guest,
	pinnedNotes,
	canManage,
	busy,
	onEdit,
	onRemoveTag,
}: {
	guest: GuestRow
	pinnedNotes: Array<{ id: string; body: string }>
	canManage: boolean
	busy?: boolean
	onEdit?: () => void
	onRemoveTag?: (tagId: string) => void
}) {
	const { _, i18n } = useLingui()
	const removeTagLabel = (name: string) => _(msg`Remove tag ${name}`)
	const erased = guest.erasedAt !== null
	return (
		<section
			className="bg-card flex flex-col gap-4 rounded-xl border p-5"
			aria-label={guest.name}
			data-testid="guest-profile-card"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-1">
					<h2
						className="text-xl font-semibold wrap-anywhere"
						data-testid="guest-profile-name"
					>
						{erased ? <Trans>Erased guest</Trans> : guest.name}
					</h2>
					<div className="text-muted-foreground flex flex-col text-sm">
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
					</div>
				</div>
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
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={onEdit}
							data-testid="guest-edit"
						>
							<Trans>Edit details</Trans>
						</Button>
					) : null}
				</div>
			</div>

			<dl className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
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
								<button
									type="button"
									className="text-muted-foreground hover:text-foreground rounded p-0.5"
									disabled={busy}
									aria-label={removeTagLabel(tag.name)}
									onClick={() => onRemoveTag(tag.id)}
									data-testid={`guest-tag-remove-${tag.id}`}
								>
									<Icon name="x" className="size-3" />
								</button>
							) : null}
						</span>
					))}
				</div>
			) : null}
		</section>
	)
}
