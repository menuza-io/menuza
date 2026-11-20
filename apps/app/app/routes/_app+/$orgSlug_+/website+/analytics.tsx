import { parseWithZod } from '@conform-to/zod/v4'
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
	ConsentBannerCard,
	consentModeActionIntent,
} from '#app/components/settings/cards/organization/consent-banner-card.tsx'
import {
	SiteAnalyticsCard,
	SiteAnalyticsSchema,
	siteAnalyticsActionIntent,
} from '#app/components/settings/cards/organization/site-analytics-card.tsx'
import { FunnelPanel } from '#app/components/website/funnel-panel.tsx'
import {
	consentBannerEnabled,
	readConsentSettings,
	saveConsentMode,
} from '#app/utils/legal/consent-settings.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { funnelEnabled } from '#app/utils/site-events/site-events.server.ts'
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

	const [consent, bannerEnabled, funnel] = await Promise.all([
		readConsentSettings(organization.id),
		consentBannerEnabled(organization.id),
		funnelEnabled(organization.id),
	])
	return { organization, consent: { ...consent, bannerEnabled }, funnel }
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
	if (formData.get('intent') === consentModeActionIntent) {
		// The banner mode (#89): Off is refused while a tracking tag is set.
		const saved = await saveConsentMode(organization.id, formData.get('mode'))
		if (!saved.ok) {
			return Response.json(
				{ status: 'error', error: saved.error },
				{ status: 400 },
			)
		}
		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)
		return Response.json({ status: 'success' })
	}
	if (formData.get('intent') !== siteAnalyticsActionIntent) {
		return Response.json({ error: 'Invalid intent' }, { status: 400 })
	}

	const submission = parseWithZod(formData, { schema: SiteAnalyticsSchema })
	if (submission.status !== 'success') {
		return Response.json({ result: submission.reply() })
	}

	const normalize = (value: string | undefined) => value?.trim() || null

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
	const { organization, consent, funnel } = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()

	return (
		<AnnotatedLayout className="max-w-4xl">
			{funnel ? (
				<AnnotatedSection>
					<FunnelPanel orgSlug={organization.slug} />
				</AnnotatedSection>
			) : null}
			<AnnotatedSection>
				<SiteAnalyticsCard
					organization={organization}
					actionData={actionData}
				/>
			</AnnotatedSection>
			<AnnotatedSection>
				<ConsentBannerCard consent={consent} />
			</AnnotatedSection>
		</AnnotatedLayout>
	)
}
