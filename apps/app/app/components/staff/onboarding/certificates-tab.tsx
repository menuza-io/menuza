import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
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
import { Item, ItemGroup } from '@repo/ui/item'
import { Skeleton } from '@repo/ui/skeleton'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { removeCertificate } from '#app/utils/staffing/onboarding-api.ts'
import { describeOnboardingError } from '#app/utils/staffing/onboarding-errors.ts'
import {
	certificatesSchema,
	type StaffCertificate,
} from '#app/utils/staffing/onboarding-types.ts'
import {
	certificateView,
	formatDay,
	localToday,
	sortCertificates,
} from '#app/utils/staffing/onboarding-view.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import { CertificateForm } from './certificate-form.tsx'
import { useOnboardingLabels } from './onboarding-labels.ts'
import { RemoveDialog } from './remove-dialog.tsx'

/**
 * Certificates with an expiry (food handler cards and the like) on a person's
 * profile. The ones that need attention come first, and each says in words
 * whether it is fine, expiring or expired. Managers are also told by the
 * regional daily check when one is about to lapse.
 */
export function CertificatesTab({
	staffId,
	terminated,
}: {
	staffId: string
	terminated: boolean
}) {
	const { _ } = useLingui()
	const { client, can, ready } = useStaffClient('hiring')
	const canWrite = can(P.UPDATE_HIRING) && !terminated
	const query = useStaffQuery(
		client,
		ready ? `/certificates/staff/${staffId}` : null,
		certificatesSchema,
	)
	const today = useMemo(() => localToday(), [])
	const certificates = useMemo(
		() => sortCertificates(query.data?.certificates ?? [], today),
		[query.data, today],
	)
	const [editing, setEditing] = useState<StaffCertificate | 'new' | null>(null)
	const [toRemove, setToRemove] = useState<StaffCertificate | null>(null)
	const remove = useStaffAction(describeOnboardingError)

	async function confirmRemoval() {
		if (!toRemove) return
		const result = await remove.run(() =>
			removeCertificate(client, staffId, toRemove.id),
		)
		if (result.ok) {
			setToRemove(null)
			query.reload()
			toast.success(_(t`Certificate removed.`))
		}
	}

	if (query.loading || !ready) {
		return (
			<div role="status" className="flex flex-col gap-3">
				<span className="sr-only">
					<Trans>Loading certificates</Trans>
				</span>
				<Skeleton className="h-12 w-full" />
				<Skeleton className="h-12 w-full" />
			</div>
		)
	}
	if (query.error && !query.data) {
		return (
			<Alert variant="destructive">
				<AlertDescription>
					{describeStaffError(query.error, _)}
				</AlertDescription>
				<Button
					variant="outline"
					className="mt-2 h-11 justify-self-start"
					onClick={query.reload}
				>
					<Trans>Try again</Trans>
				</Button>
			</Alert>
		)
	}

	return (
		<Frame className="w-full">
			<FrameHeader>
				<FrameTitle>
					<Trans>Certificates</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>Licences and cards, and when they expire.</Trans>
				</FrameDescription>
			</FrameHeader>
			<FramePanel className="flex flex-col gap-4">
				{certificates.length === 0 ? (
					<div className="flex flex-col gap-2">
						<p className="text-sm font-medium">
							<Trans>No certificates yet</Trans>
						</p>
						<p className="text-muted-foreground max-w-prose text-sm text-pretty">
							{canWrite ? (
								<Trans>
									Keep track of food handler cards and other certificates, and
									get a reminder before one expires.
								</Trans>
							) : (
								<Trans>No certificates are recorded for this person.</Trans>
							)}
						</p>
					</div>
				) : (
					<ItemGroup>
						{certificates.map((certificate) => (
							<CertificateRow
								key={certificate.id}
								certificate={certificate}
								today={today}
								canWrite={canWrite}
								onEdit={() => setEditing(certificate)}
								onRemove={() => setToRemove(certificate)}
							/>
						))}
					</ItemGroup>
				)}

				{canWrite && editing === null ? (
					<div>
						<Button variant="outline" onClick={() => setEditing('new')}>
							<Icon name="plus" />
							<Trans>Add certificate</Trans>
						</Button>
					</div>
				) : null}

				{editing !== null ? (
					<CertificateForm
						key={editing === 'new' ? 'new' : editing.id}
						client={client}
						staffId={staffId}
						existing={editing === 'new' ? null : editing}
						onSaved={() => {
							setEditing(null)
							query.reload()
							toast.success(_(t`Certificate saved.`))
						}}
						onCancel={() => setEditing(null)}
					/>
				) : null}

				<RemoveDialog
					open={toRemove !== null}
					title={<Trans>Remove this certificate?</Trans>}
					description={
						<Trans>
							It is taken off their profile. This is recorded in the staff log.
						</Trans>
					}
					pending={remove.pending}
					error={remove.error}
					onConfirm={() => void confirmRemoval()}
					onClose={() => setToRemove(null)}
				/>
			</FramePanel>
		</Frame>
	)
}

function CertificateRow({
	certificate,
	today,
	canWrite,
	onEdit,
	onRemove,
}: {
	certificate: StaffCertificate
	today: string
	canWrite: boolean
	onEdit: () => void
	onRemove: () => void
}) {
	const { _, i18n } = useLingui()
	const labels = useOnboardingLabels()
	const standing = certificateView(certificate, today)
	const title = labels.certificateTitle(certificate)
	const expires = certificate.expiresOn
		? formatDay(certificate.expiresOn, i18n.locale)
		: null

	return (
		<Item variant="outline" render={<li />}>
			<div className="flex w-full items-start gap-3">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="text-sm font-medium text-pretty">{title}</span>
					<span className="text-xs">
						{standing.status === 'expired' ? (
							<span className="text-destructive inline-flex items-center gap-1 font-medium">
								<Icon name="alert-triangle" className="size-3.5" />
								{plural(Math.abs(standing.daysLeft ?? 0), {
									one: 'Expired # day ago',
									other: 'Expired # days ago',
								})}
							</span>
						) : standing.status === 'expiring' ? (
							<span className="text-foreground inline-flex items-center gap-1 font-medium">
								<Icon name="alert-triangle" className="size-3.5" />
								{standing.daysLeft === 0 ? (
									<Trans>Expires today</Trans>
								) : (
									plural(standing.daysLeft ?? 0, {
										one: 'Expires in # day',
										other: 'Expires in # days',
									})
								)}
							</span>
						) : standing.status === 'valid' ? (
							<span className="text-muted-foreground">
								<Trans>Valid until {expires}</Trans>
							</span>
						) : (
							<span className="text-muted-foreground">
								<Trans>Does not expire</Trans>
							</span>
						)}
					</span>
					{certificate.note ? (
						<span className="text-muted-foreground text-xs text-pretty">
							{certificate.note}
						</span>
					) : null}
				</div>
				{canWrite ? (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="icon"
									className="-me-2"
									aria-label={_(t`More actions for ${title}`)}
								>
									<Icon name="more-horizontal" />
								</Button>
							}
						/>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={onEdit}>
								<Icon name="pencil" />
								<Trans>Edit</Trans>
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem variant="destructive" onClick={onRemove}>
								<Icon name="trash-2" />
								<Trans>Remove</Trans>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				) : null}
			</div>
		</Item>
	)
}
