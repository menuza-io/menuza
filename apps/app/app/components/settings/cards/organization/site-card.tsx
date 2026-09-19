import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { t, Trans } from '@lingui/macro'
import { getOrgSiteUrl } from '@repo/common/url'
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
import { FieldGroup } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Switch } from '@repo/ui/switch'
import { useEffect, useState } from 'react'
import { Form, useFetcher } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import { ErrorList, Field } from '#app/components/forms.tsx'

export const SitePublishSchema = z.object({
	sitePublished: z.enum(['true', 'false']),
	organizationId: z.string(),
})

export const SiteDataRegionSchema = z.object({
	dataRegion: z.enum(['us', 'ksa']),
	organizationId: z.string(),
	confirmWipe: z.enum(['true']).optional(),
})

export const CustomDomainSchema = z.object({
	customDomain: z.string().min(1, 'Domain is required'),
	organizationId: z.string(),
})

export const sitePublishActionIntent = 'update-site-publish'
export const siteDataRegionActionIntent = 'update-site-data-region'
export const addCustomDomainActionIntent = 'add-custom-domain'
export const removeCustomDomainActionIntent = 'remove-custom-domain'
export const refreshCustomDomainActionIntent = 'refresh-custom-domain'

export function SiteCard({
	organization,
	cnameTarget,
	cloudflareConfigured,
	actionData,
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
	cnameTarget: string
	cloudflareConfigured: boolean
	actionData?: { result?: unknown }
}) {
	const [isPublished, setIsPublished] = useState(organization.sitePublished)
	const publishFetcher = useFetcher<{
		error?: string
		status?: string
		sitePublished?: boolean
	}>()

	useEffect(() => {
		setIsPublished(Boolean(organization.sitePublished))
	}, [organization.sitePublished])

	useEffect(() => {
		if (publishFetcher.state !== 'idle') return

		const data = publishFetcher.data
		if (!data) return

		if (data.error) {
			setIsPublished(Boolean(organization.sitePublished))
			toast.error(data.error)
			return
		}

		if (data.status === 'success' && typeof data.sitePublished === 'boolean') {
			setIsPublished(data.sitePublished)
		}
	}, [publishFetcher.state, publishFetcher.data, organization.sitePublished])
	const domainFetcher = useFetcher()
	const DomainForm = domainFetcher.Form
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

	const submitDataRegion = (nextRegion: 'us' | 'ksa', confirmWipe = false) => {
		void regionFetcher.submit(
			{
				intent: siteDataRegionActionIntent,
				organizationId: organization.id,
				dataRegion: nextRegion,
				...(confirmWipe ? { confirmWipe: 'true' } : {}),
			},
			{ method: 'POST' },
		)
	}

	const [form, fields] = useForm({
		id: 'custom-domain',
		constraint: getZodConstraint(CustomDomainSchema),
		lastResult: actionData?.result as never,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: CustomDomainSchema })
		},
		defaultValue: {
			customDomain: customDomain || '',
			organizationId: organization.id,
		},
	})

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

	const busy =
		publishFetcher.state !== 'idle' ||
		domainFetcher.state !== 'idle' ||
		regionFetcher.state !== 'idle'

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
							<AlertDialogFooter>
								<AlertDialogCancel>
									<Trans>Keep current region</Trans>
								</AlertDialogCancel>
								<AlertDialogAction
									variant="destructive"
									onClick={() => {
										if (!pendingRegion) return
										const nextRegion = pendingRegion
										setPendingRegion(null)
										submitDataRegion(nextRegion, true)
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
					'grid transition-all duration-200 ease-out',
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

						<div className="space-y-5">
							<div>
								<p className="text-sm font-medium">
									<Trans>Custom domain</Trans>
								</p>
								<p className="text-muted-foreground mt-1 text-sm">
									<Trans>
										Point your own domain at Sites with a CNAME record. SSL is
										provisioned automatically when Cloudflare for SaaS is
										configured.
									</Trans>
								</p>
							</div>

							{customDomain ? (
								<div className="space-y-4">
									<div className="bg-muted grid gap-2 rounded-xl p-4">
										<div className="flex items-center justify-between gap-4">
											<div className="min-w-0">
												<p className="text-muted-foreground mb-0.5 text-xs font-medium tracking-wide uppercase">
													<Trans>Connected domain</Trans>
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
									</div>

									<div className="space-y-3 rounded-xl border p-4">
										<div className="flex items-start gap-3">
											<Icon
												name="external-link"
												className="text-muted-foreground mt-0.5 size-4 shrink-0"
											/>
											<div className="min-w-0 space-y-2">
												<p className="text-sm font-medium">
													<Trans>DNS setup</Trans>
												</p>
												<p className="text-muted-foreground text-xs">
													<Trans>
														Add a CNAME record for your domain (or subdomain)
														pointing to:
													</Trans>
												</p>
												<code className="bg-muted block rounded-md px-3 py-2.5 font-mono text-xs break-all">
													{cnameTarget}
												</code>
												{!cloudflareConfigured ? (
													<p className="text-muted-foreground pt-1 text-xs">
														<Trans>
															Cloudflare is not configured in this environment.
															Domain is stored for local testing; SSL automation
															requires CLOUDFLARE_API_TOKEN and
															CLOUDFLARE_ZONE_ID.
														</Trans>
													</p>
												) : null}
											</div>
										</div>
									</div>

									<div className="flex flex-wrap gap-2">
										<DomainForm method="POST">
											<input
												type="hidden"
												name="intent"
												value={refreshCustomDomainActionIntent}
											/>
											<input
												type="hidden"
												name="organizationId"
												value={organization.id}
											/>
											<Button type="submit" variant="outline" disabled={busy}>
												<Icon name="refresh-cw" className="mr-1.5 size-3.5" />
												<Trans>Refresh status</Trans>
											</Button>
										</DomainForm>
										<DomainForm method="POST">
											<input
												type="hidden"
												name="intent"
												value={removeCustomDomainActionIntent}
											/>
											<input
												type="hidden"
												name="organizationId"
												value={organization.id}
											/>
											<Button
												type="submit"
												variant="destructive"
												disabled={busy}
											>
												<Trans>Remove domain</Trans>
											</Button>
										</DomainForm>
									</div>
								</div>
							) : (
								<Form
									method="POST"
									{...getFormProps(form)}
									className="space-y-4"
								>
									<input
										type="hidden"
										name="intent"
										value={addCustomDomainActionIntent}
									/>
									<input
										{...getInputProps(fields.organizationId, {
											type: 'hidden',
										})}
									/>
									<FieldGroup>
										<Field
											labelProps={{
												children: <Trans>Domain</Trans>,
											}}
											inputProps={{
												...getInputProps(fields.customDomain, {
													type: 'text',
												}),
												placeholder: 'www.example.com',
											}}
											className="w-full"
											errors={fields.customDomain.errors}
										/>
									</FieldGroup>
									<ErrorList id={form.errorId} errors={form.errors} />
									<div className="flex justify-end">
										<Button type="submit" disabled={busy}>
											<Trans>Connect domain</Trans>
										</Button>
									</div>
								</Form>
							)}
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	)
}
