import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	buildEmailTemplateBlocks,
	type EmailBlock,
} from '@repo/common/email-blocks'
import { CampaignForm, EmailBlockEditor } from '@repo/marketing'
import {
	normalizeEmailBlocks,
	renderMarketingEmail,
} from '@repo/marketing/server/email-render'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import {
	Form,
	Link,
	redirect,
	useActionData,
	useNavigation,
	type ActionFunctionArgs,
} from 'react-router'
import { resolveEmailBrandingForOrg } from '#app/utils/email-branding.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

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

export async function action({ request, params }: ActionFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(request, orgSlug)

	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === 'email_preview') {
		const branding = await resolveEmailBrandingForOrg(orgId)
		const { html } = await renderMarketingEmail({
			blocks: formData.get('blocks'),
			theme: branding,
			socials: branding.socials,
			subject: String(formData.get('subject') || ''),
		})
		return { html }
	}

	const name = formData.get('name')
	const channel = formData.get('channel')
	const subject = formData.get('subject')
	const content = formData.get('content')
	const blocksRaw = formData.get('blocks')

	let resolvedContent = typeof content === 'string' ? content : ''
	let contentHtml: string | undefined
	let contentBlocks: string | undefined

	if (
		channel === 'email' &&
		typeof blocksRaw === 'string' &&
		blocksRaw.trim()
	) {
		const branding = await resolveEmailBrandingForOrg(orgId)
		const blocks = normalizeEmailBlocks(blocksRaw)
		if (blocks.length === 0) {
			return { error: i18n._(t`Add at least one email block`) }
		}
		const rendered = await renderMarketingEmail({
			blocks,
			theme: branding,
			socials: branding.socials,
			subject: typeof subject === 'string' ? subject : '',
		})
		resolvedContent = rendered.text
		contentHtml = rendered.html
		contentBlocks = JSON.stringify(blocks)
	}

	if (!resolvedContent) {
		return { error: i18n._(t`Message content is required`) }
	}

	const createRes = await fetchTenant('/operator/marketing/campaigns', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name,
			channel,
			subject,
			content: resolvedContent,
			contentHtml,
			contentBlocks,
		}),
	})

	if (!createRes.ok) {
		const err = await createRes.json().catch(() => ({}))
		return {
			error:
				(err as { error?: string }).error ||
				i18n._(t`Failed to create and dispatch campaign`),
		}
	}

	return redirect(`/${orgSlug}/marketing/campaigns`)
}

export default function NewCampaignRoute() {
	const { _ } = useLingui()
	const actionData = useActionData<typeof action>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'

	return (
		<div className="mx-auto max-w-5xl space-y-8">
			<div className="flex items-start gap-3">
				<Button
					variant="ghost"
					size="icon-xs"
					render={<Link to=".." />}
					aria-label={_(msg`Back`)}
					className="mt-0.5"
				>
					<Icon name="arrow-left" className="size-4" />
				</Button>
				<header className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">
						{_(msg`New broadcast`)}
					</h1>
					<p className="text-muted-foreground text-sm">
						{_(msg`Send a one-time email or SMS to your audience.`)}
					</p>
				</header>
			</div>

			<Form method="post">
				<CampaignForm
					error={actionData?.error}
					isSubmitting={isSubmitting}
					cancelTo=".."
					emailDesigner={<EmailDesignerField />}
				/>
			</Form>
		</div>
	)
}
