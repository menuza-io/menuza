import { parseWithZod } from '@conform-to/zod'
import { requireUserId } from '@repo/auth'
import { invalidateUserOrganizationsCache } from '@repo/cache'
import { redirectWithToast } from '@repo/common/toast'
import { db, eq, Organization } from '@repo/database'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useActionData,
	useLoaderData,
} from 'react-router'

import {
	SiteAnalyticsCard,
	SiteAnalyticsSchema,
	siteAnalyticsActionIntent,
} from '#app/components/settings/cards/organization/site-analytics-card.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		customDomain: true,
		facebookPixelId: true,
		googleTagManagerId: true,
		googleAnalyticsId: true,
		tiktokPixelId: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)

	return { organization }
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		customDomain: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)

	const formData = await request.formData()
	if (formData.get('intent') !== siteAnalyticsActionIntent) {
		return Response.json({ error: 'Invalid intent' }, { status: 400 })
	}

	const submission = parseWithZod(formData, { schema: SiteAnalyticsSchema })
	if (submission.status !== 'success') {
		return Response.json({ result: submission.reply() })
	}

	const normalize = (value: string) => value.trim() || null

	try {
		await db
			.update(Organization)
			.set({
				facebookPixelId: normalize(submission.value.facebookPixelId),
				googleTagManagerId: normalize(submission.value.googleTagManagerId),
				googleAnalyticsId: normalize(submission.value.googleAnalyticsId),
				tiktokPixelId: normalize(submission.value.tiktokPixelId),
			})
			.where(eq(Organization.id, organization.id))

		await invalidateUserOrganizationsCache(userId)
		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)

		return redirectWithToast(`/${organization.slug}/website/analytics`, {
			title: 'Analytics settings updated',
			description: 'Your website tracking integrations have been saved.',
			type: 'success',
		})
	} catch (error) {
		console.error('Failed to update analytics settings', error)
		return Response.json(
			{
				result: submission.reply({
					formErrors: ['Failed to update analytics settings'],
				}),
			},
			{ status: 500 },
		)
	}
}

export default function WebsiteAnalyticsRoute() {
	const { organization } = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()

	return (
		<AnnotatedLayout className="max-w-4xl">
			<AnnotatedSection>
				<SiteAnalyticsCard
					organization={organization}
					actionData={actionData}
				/>
			</AnnotatedSection>
		</AnnotatedLayout>
	)
}
