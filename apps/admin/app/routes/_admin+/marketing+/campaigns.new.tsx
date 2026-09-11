import { i18n } from '@lingui/core'
import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserWithRole } from '@repo/auth'
import {
	buildEmailTemplateBlocks,
	type EmailBlock,
} from '@repo/common/email-blocks'
import { db, Organization } from '@repo/database'
import { CampaignForm, EmailBlockEditor } from '@repo/marketing'
import {
	normalizeEmailBlocks,
	renderMarketingEmail,
} from '@repo/marketing/server/email-render'
import { createPlatformCampaign } from '@repo/marketing/server/platform-campaigns'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useState } from 'react'
import {
	Form,
	Link,
	redirect,
	useActionData,
	useLoaderData,
	useNavigation,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { resolvePlatformEmailBranding } from '#app/utils/email-branding.server.ts'

function EmailDesignerField() {
	const [blocks, setBlocks] = useState<EmailBlock[]>(() =>
		buildEmailTemplateBlocks('welcome'),
	)

	return (
		<div className="space-y-3">
			<input type="hidden" name="blocks" value={JSON.stringify(blocks)} />
			<EmailBlockEditor blocks={blocks} onChange={setBlocks} />
		</div>
	)
}

export async function loader({ request }: LoaderFunctionArgs) {
	await requireUserWithRole(request, 'admin')
	const organizations = await db
		.select({ id: Organization.id, name: Organization.name })
		.from(Organization)
		.orderBy(Organization.name)

	return { organizations }
}

export async function action({ request }: ActionFunctionArgs) {
	const adminUserId = await requireUserWithRole(request, 'admin')
	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === 'email_preview') {
		const branding = resolvePlatformEmailBranding()
		const { html } = await renderMarketingEmail({
			blocks: formData.get('blocks'),
			theme: branding,
			subject: String(formData.get('subject') || ''),
		})
		return { html }
	}

	const channel = (formData.get('channel') as 'email' | 'sms') || 'email'
	const subject = String(formData.get('subject') || '')
	const blocksRaw = formData.get('blocks')

	let content = String(formData.get('content') || '')
	let contentHtml: string | undefined
	let contentBlocks: string | undefined

	if (
		channel === 'email' &&
		typeof blocksRaw === 'string' &&
		blocksRaw.trim()
	) {
		const branding = resolvePlatformEmailBranding()
		const blocks = normalizeEmailBlocks(blocksRaw)
		const rendered = await renderMarketingEmail({
			blocks,
			theme: branding,
			subject,
		})
		content = rendered.text
		contentHtml = rendered.html
		contentBlocks = JSON.stringify(blocks)
	}

	if (!content) {
		return { error: i18n._(t`Message content is required`) }
	}

	try {
		await createPlatformCampaign(
			{
				name: String(formData.get('name') || ''),
				channel,
				subject,
				content,
				contentHtml,
				contentBlocks,
				audience:
					(formData.get('audience') as 'all_operators' | 'organization') ||
					'all_operators',
				targetOrganizationId:
					String(formData.get('targetOrganizationId') || '') || undefined,
			},
			adminUserId,
		)
	} catch (error) {
		return {
			error:
				error instanceof Error
					? error.message
					: i18n._(t`Failed to create campaign`),
		}
	}

	return redirect('/marketing/campaigns')
}

export default function AdminNewCampaignRoute() {
	const { _ } = useLingui()
	const { organizations } = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'

	return (
		<div className="mx-auto max-w-5xl space-y-8">
			<div className="flex items-start gap-3">
				<Button
					variant="ghost"
					size="icon-xs"
					render={<Link to="/marketing/campaigns" />}
					aria-label={_(msg`Back`)}
					className="mt-0.5"
				>
					<Icon name="arrow-left" className="size-4" />
				</Button>
				<header className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">
						<Trans>New broadcast</Trans>
					</h1>
					<p className="text-muted-foreground text-sm">
						<Trans>Send a one-time message to tenant operators.</Trans>
					</p>
				</header>
			</div>

			<Form method="post">
				<CampaignForm
					error={actionData?.error}
					isSubmitting={isSubmitting}
					cancelTo="/marketing/campaigns"
					showSmsProBadge={false}
					emailDesigner={<EmailDesignerField />}
					audienceField={
						<div className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="audience">
									<Trans>Target Audience</Trans>
								</Label>
								<Select name="audience" defaultValue="all_operators">
									<SelectTrigger id="audience">
										<SelectValue placeholder={_(msg`Select audience`)} />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all_operators">
											<Trans>All Tenant Operators</Trans>
										</SelectItem>
										<SelectItem value="organization">
											<Trans>Specific Organization</Trans>
										</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-2">
								<Label htmlFor="targetOrganizationId">
									<Trans>Organization (optional)</Trans>
								</Label>
								<Select name="targetOrganizationId">
									<SelectTrigger id="targetOrganizationId">
										<SelectValue placeholder={_(msg`All organizations`)} />
									</SelectTrigger>
									<SelectContent>
										{organizations.map((org) => (
											<SelectItem key={org.id} value={org.id}>
												{org.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
					}
				/>
			</Form>
		</div>
	)
}
