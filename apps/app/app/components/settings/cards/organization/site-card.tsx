import { t, Trans } from '@lingui/macro'
import { getOrgSiteUrl } from '@repo/common/url'
import { staffSummarySchema, type StaffSummary } from '@repo/staffing'
import { cn } from '@repo/ui'
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
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Switch } from '@repo/ui/switch'
import { useEffect, useMemo, useState } from 'react'
import { Link, useFetcher } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import {
	RegionReservationsGuard,
	type RegionReservationsGuardState,
} from '#app/components/reservations/region-reservations-guard.tsx'
import {
	RegionStaffGuard,
	type RegionStaffGuardState,
} from '#app/components/staff/region-staff-guard.tsx'
import {
	requiresReservationsConfirmation,
	reservationsConfirmationMatches,
	reservationsSummarySchema,
	summaryHasUnsettledPayments,
	type ReservationsSummary,
} from '#app/utils/reservations/region-confirmation.ts'
import {
	requiresStaffConfirmation,
	staffConfirmationMatches,
} from '#app/utils/staffing/region-confirmation.ts'

export const SitePublishSchema = z.object({
	sitePublished: z.enum(['true', 'false']),
	organizationId: z.string(),
})

export const SiteDataRegionSchema = z.object({
	dataRegion: z.enum(['us', 'ksa']),
	organizationId: z.string(),
	confirmWipe: z.enum(['true']).optional(),
	// Typed organization slug; required when the old region holds staff records.
	confirmText: z.string().max(200).optional(),
})

export const sitePublishActionIntent = 'update-site-publish'
export const siteDataRegionActionIntent = 'update-site-data-region'

export function SiteCard({
	organization,
}: {
	organization: {
		id: string
		slug: string
		sitePublished: boolean
		customDomain: string | null
		customDomainStatus: string | null
		dataRegion?: string | null
		hasProvisionedDb?: boolean
	}
}) {
	const [isPublished, setIsPublished] = useState(organization.sitePublished)
	const publishFetcher = useFetcher<{ error?: string; status?: string }>()

	useEffect(() => {
		setIsPublished(Boolean(organization.sitePublished))
	}, [organization.sitePublished])

	useEffect(() => {
		const data = publishFetcher.data
		if (data?.error) {
			setIsPublished(Boolean(organization.sitePublished))
			toast.error(data.error)
		}
	}, [publishFetcher.data, organization.sitePublished])
	const siteUrl = getOrgSiteUrl(organization.slug)
	const customDomain = organization.customDomain
	const domainStatus = organization.customDomainStatus
	const dataRegion = organization.dataRegion === 'ksa' ? 'ksa' : 'us'
	const [pendingRegion, setPendingRegion] = useState<'us' | 'ksa' | null>(null)
	const hasCustomerData = Boolean(organization.hasProvisionedDb)
	const regionFetcher = useFetcher<{ error?: string }>()
	const regionOptions = [
		{ value: 'us', label: t`United States` },
		{ value: 'ksa', label: t`Saudi Arabia (KSA)` },
	]
	const pendingRegionLabel = regionOptions.find(
		(option) => option.value === pendingRegion,
	)?.label
	const currentRegionLabel = regionOptions.find(
		(option) => option.value === dataRegion,
	)?.label

	const submitDataRegion = (
		nextRegion: 'us' | 'ksa',
		confirmWipe = false,
		confirmText = '',
	) => {
		void regionFetcher.submit(
			{
				intent: siteDataRegionActionIntent,
				organizationId: organization.id,
				dataRegion: nextRegion,
				...(confirmWipe ? { confirmWipe: 'true' } : {}),
				...(confirmText ? { confirmText } : {}),
			},
			{ method: 'POST' },
		)
	}

	// Staff and reservation records live in the same regional database and are
	// deleted with it: ask the current region how much there is while the dialog is open.
	const guardFetcher = useFetcher<{
		summary: unknown
		requiresConfirmation: boolean
	}>()
	const reservationsGuardFetcher = useFetcher<{
		summary: unknown
		requiresConfirmation: boolean
	}>()
	const [typedConfirmation, setTypedConfirmation] = useState('')
	const guardLoad = guardFetcher.load
	const reservationsGuardLoad = reservationsGuardFetcher.load
	useEffect(() => {
		if (pendingRegion === null) {
			setTypedConfirmation('')
			return
		}
		void guardLoad(
			`/resources/staffing/region-summary?orgSlug=${encodeURIComponent(organization.slug)}`,
		)
		void reservationsGuardLoad(
			`/resources/reservations/region-summary?orgSlug=${encodeURIComponent(organization.slug)}&orgId=${encodeURIComponent(organization.id)}`,
		)
	}, [
		pendingRegion,
		guardLoad,
		reservationsGuardLoad,
		organization.slug,
		organization.id,
	])
	const guardState = useMemo<RegionStaffGuardState>(() => {
		if (guardFetcher.data === undefined) {
			return { status: 'loading', summary: null, requiresConfirmation: false }
		}
		const parsed = staffSummarySchema.safeParse(guardFetcher.data.summary)
		const summary: StaffSummary | null = parsed.success ? parsed.data : null
		return {
			status: 'ready',
			summary,
			// The server decides too; this only keeps the button honest.
			requiresConfirmation:
				guardFetcher.data.requiresConfirmation ||
				requiresStaffConfirmation(summary),
		}
	}, [guardFetcher.data])
	const reservationsGuardState = useMemo<RegionReservationsGuardState>(() => {
		if (reservationsGuardFetcher.data === undefined) {
			return { status: 'loading', summary: null, requiresConfirmation: false }
		}
		const parsed = reservationsSummarySchema.safeParse(
			reservationsGuardFetcher.data.summary,
		)
		const summary: ReservationsSummary | null = parsed.success
			? parsed.data
			: null
		return {
			status: 'ready',
			summary,
			requiresConfirmation:
				reservationsGuardFetcher.data.requiresConfirmation ||
				requiresReservationsConfirmation(summary),
		}
	}, [reservationsGuardFetcher.data])
	const staffGuardBlocks =
		guardState.status === 'loading' ||
		(guardState.requiresConfirmation &&
			!staffConfirmationMatches(typedConfirmation, organization.slug))
	const reservationsGuardBlocks =
		reservationsGuardState.status === 'loading' ||
		summaryHasUnsettledPayments(reservationsGuardState.summary) ||
		(reservationsGuardState.requiresConfirmation &&
			!reservationsConfirmationMatches(typedConfirmation, organization.slug))
	const regionGuardBlocks = staffGuardBlocks || reservationsGuardBlocks

	const handleSwitchChange = (checked: boolean) => {
		setIsPublished(checked)
		void publishFetcher.submit(
			{
				intent: sitePublishActionIntent,
				organizationId: organization.id,
				sitePublished: checked ? 'true' : 'false',
			},
			{ method: 'POST' },
		)
	}

	const busy = publishFetcher.state !== 'idle' || regionFetcher.state !== 'idle'

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Organization site</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Publish a public website for your organization. Visitors can reach
						it at your org subdomain, or a custom domain you connect.
					</Trans>
				</CardDescription>
				<CardAction>
					<Switch
						checked={isPublished}
						onCheckedChange={handleSwitchChange}
						disabled={busy}
					/>
				</CardAction>
			</CardHeader>

			<CardContent className="pt-2 pb-4">
				<div className="space-y-3">
					<div>
						<label htmlFor="site-data-region" className="text-sm font-medium">
							<Trans>Customer data region</Trans>
						</label>
						<p className="text-muted-foreground mt-1 text-sm">
							<Trans>
								Visitor names, phone numbers, and emails are stored in this
								region. Changing it after customers have signed in permanently
								deletes that data — it is not moved.
							</Trans>
						</p>
					</div>
					<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
						<Select
							value={pendingRegion ?? dataRegion}
							disabled={regionFetcher.state !== 'idle'}
							items={regionOptions}
							onValueChange={(value) => {
								if (
									(value !== 'us' && value !== 'ksa') ||
									value === dataRegion
								) {
									return
								}
								if (hasCustomerData) {
									setPendingRegion(value)
									return
								}
								submitDataRegion(value)
							}}
						>
							<SelectTrigger id="site-data-region" className="w-full sm:w-72">
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="start" alignItemWithTrigger={false}>
								{regionOptions.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{regionFetcher.data?.error ? (
						<p className="text-destructive text-sm">
							{regionFetcher.data.error}
						</p>
					) : null}

					<AlertDialog
						open={pendingRegion !== null}
						onOpenChange={(open) => {
							if (!open) setPendingRegion(null)
						}}
					>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>
									<Trans>Delete customer data and switch region?</Trans>
								</AlertDialogTitle>
								<AlertDialogDescription>
									<Trans>
										Switching from {currentRegionLabel} to {pendingRegionLabel}{' '}
										permanently deletes every visitor account in the current
										region — names, phone numbers, emails, and login sessions.
										This cannot be undone. New sign-ins will start from an empty
										database in the new region.
									</Trans>
								</AlertDialogDescription>
							</AlertDialogHeader>
							<RegionStaffGuard
								orgSlug={organization.slug}
								state={guardState}
								typed={typedConfirmation}
								onTypedChange={setTypedConfirmation}
							/>
							<RegionReservationsGuard
								orgSlug={organization.slug}
								state={reservationsGuardState}
								typed={typedConfirmation}
								onTypedChange={setTypedConfirmation}
								showConfirmInput={!guardState.requiresConfirmation}
							/>
							<AlertDialogFooter>
								<AlertDialogCancel>
									<Trans>Keep current region</Trans>
								</AlertDialogCancel>
								<AlertDialogAction
									variant="destructive"
									disabled={regionGuardBlocks}
									onClick={() => {
										if (!pendingRegion || regionGuardBlocks) return
										const nextRegion = pendingRegion
										const typed = typedConfirmation
										setPendingRegion(null)
										submitDataRegion(nextRegion, true, typed)
									}}
								>
									<Trans>Delete data and switch</Trans>
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</div>
			</CardContent>

			<CardContent
				className={cn(
					'grid transition-[grid-template-rows,opacity] duration-180 ease-out motion-reduce:transition-none',
					isPublished
						? 'grid-rows-[1fr] opacity-100'
						: 'grid-rows-[0fr] opacity-0',
				)}
			>
				<div className="overflow-hidden">
					<div className="flex flex-col gap-6 pt-2 pb-4">
						<div className="bg-muted flex items-start gap-3 rounded-xl p-4">
							<div className="bg-background text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg border shadow-xs">
								<Icon name="link-2" className="size-4" />
							</div>
							<div className="min-w-0">
								<p className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
									<Trans>Subdomain URL</Trans>
								</p>
								<a
									href={siteUrl}
									target="_blank"
									rel="noreferrer"
									className="text-primary text-sm font-medium break-all underline-offset-2 hover:underline"
								>
									{siteUrl}
								</a>
							</div>
						</div>

						<div className="space-y-3">
							<div>
								<p className="text-sm font-medium">
									<Trans>Custom domain</Trans>
								</p>
								<p className="text-muted-foreground mt-1 text-sm">
									<Trans>
										Connect your own domain, buy one, or set up email forwarding
										on the Domain tab.
									</Trans>
								</p>
							</div>
							{customDomain ? (
								<div className="bg-muted flex items-center justify-between gap-4 rounded-xl p-4">
									<div className="min-w-0">
										<p className="text-muted-foreground mb-0.5 text-xs font-medium tracking-wide uppercase">
											<Trans>Primary domain</Trans>
										</p>
										<a
											href={`https://${customDomain}`}
											target="_blank"
											rel="noreferrer"
											className="text-primary block text-sm font-medium break-all underline-offset-2 hover:underline"
										>
											{customDomain}
										</a>
									</div>
									<span
										className={cn(
											'inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
											domainStatus === 'active'
												? 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400'
												: 'bg-muted-foreground/10 text-muted-foreground',
										)}
									>
										{domainStatus || 'pending'}
									</span>
								</div>
							) : null}
							<Button
								render={<Link to={`/${organization.slug}/website/domain`} />}
								variant="outline"
							>
								<Trans>Manage domain</Trans>
							</Button>
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	)
}
