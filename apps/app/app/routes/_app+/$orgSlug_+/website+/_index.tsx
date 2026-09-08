import { parseWithZod } from '@conform-to/zod'
import { requireUserId } from '@repo/auth'
import { invalidateUserOrganizationsCache } from '@repo/cache'
import {
	parseSiteLocalesConfig,
	serializeSiteLocales,
	type SiteContentLocale,
} from '@repo/common/site-locales'
import { redirectWithToast } from '@repo/common/toast'
import { and, db, eq, ne, Organization } from '@repo/database'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useLoaderData,
	useActionData,
} from 'react-router'
import { z } from 'zod'

import {
	SiteCard,
	SitePublishSchema,
	SiteDataRegionSchema,
	CustomDomainSchema,
	sitePublishActionIntent,
	siteDataRegionActionIntent,
	addCustomDomainActionIntent,
	removeCustomDomainActionIntent,
	refreshCustomDomainActionIntent,
} from '#app/components/settings/cards/organization/site-card.tsx'
import {
	SiteLocalesCard,
	SiteLocalesSchema,
	siteLocalesActionIntent,
} from '#app/components/settings/cards/organization/site-locales-card.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'
import {
	createCustomHostname,
	deleteCustomHostname,
	getCustomHostname,
	getCustomHostnameCnameTarget,
	isCloudflareCustomHostnamesConfigured,
	isValidCustomDomain,
	normalizeCustomDomain,
} from '#app/utils/sites/cloudflare-custom-hostnames.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import {
	deprovisionTenantDatabase,
	provisionTenantDatabase,
} from '#app/utils/sites/tenant-api.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)

	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
		sitePublished: true,
		customDomain: true,
		customDomainStatus: true,
		cloudflareHostnameId: true,
		siteLocales: true,
		siteDefaultLocale: true,
		dataRegion: true,
		hasProvisionedDb: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)

	return {
		organization,
		localesConfig: parseSiteLocalesConfig(
			organization.siteLocales,
			organization.siteDefaultLocale,
		),
		cnameTarget: getCustomHostnameCnameTarget(),
		cloudflareConfigured: isCloudflareCustomHostnamesConfigured(),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		customDomain: true,
		customDomainStatus: true,
		cloudflareHostnameId: true,
		dataRegion: true,
		hasProvisionedDb: true,
		sitePublished: true,
	})

	const formData = await request.formData()
	const intent = formData.get('intent')

	const requirePermission = async (
		permission: Parameters<typeof requireUserWithOrganizationPermission>[2],
	) => {
		await requireUserWithOrganizationPermission(
			request,
			organization.id,
			permission,
		)
	}

	if (intent === sitePublishActionIntent) {
		await requirePermission(ORG_PERMISSIONS.UPDATE_WEBSITE_ANY)

		const submission = parseWithZod(formData, {
			schema: SitePublishSchema,
		})

		if (submission.status !== 'success') {
			return Response.json({ result: submission.reply() })
		}

		const { sitePublished } = submission.value
		const published = sitePublished === 'true'

		try {
			if (published) {
				await provisionTenantDatabase({
					orgId: organization.id,
					dataRegion: organization.dataRegion,
					slug: organization.slug,
					customDomain: organization.customDomain,
				})
			}

			await db
				.update(Organization)
				.set({
					sitePublished: published,
					...(published ? { hasProvisionedDb: true } : {}),
				})
				.where(eq(Organization.id, organization.id))

			await invalidateUserOrganizationsCache(userId)
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)

			return Response.json({
				status: 'success',
				sitePublished: published,
			})
		} catch (error) {
			console.error('Failed to update site publish settings:', error)
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: 'Failed to update site publish settings',
				},
				{ status: 500 },
			)
		}
	}

	if (intent === addCustomDomainActionIntent) {
		await requirePermission(ORG_PERMISSIONS.UPDATE_SETTINGS_ANY)

		const submission = parseWithZod(formData, {
			schema: CustomDomainSchema.superRefine((data, ctx) => {
				const normalized = normalizeCustomDomain(data.customDomain)
				if (!isValidCustomDomain(normalized)) {
					ctx.addIssue({
						path: ['customDomain'],
						code: z.ZodIssueCode.custom,
						message: 'Enter a valid domain like www.example.com',
					})
				}
			}),
		})

		if (submission.status !== 'success') {
			return Response.json({ result: submission.reply() })
		}

		const customDomain = normalizeCustomDomain(submission.value.customDomain)

		const [existing] = await db
			.select({ id: Organization.id })
			.from(Organization)
			.where(
				and(
					eq(Organization.customDomain, customDomain),
					ne(Organization.id, organization.id),
				),
			)
			.limit(1)
		if (existing) {
			return Response.json({
				result: submission.reply({
					fieldErrors: {
						customDomain: [
							'This domain is already connected to another organization.',
						],
					},
				}),
			})
		}

		try {
			const hostname = await createCustomHostname(customDomain)
			await db
				.update(Organization)
				.set({
					customDomain,
					customDomainStatus: hostname.status,
					cloudflareHostnameId: hostname.id,
					sitePublished: true,
				})
				.where(eq(Organization.id, organization.id))

			await invalidateUserOrganizationsCache(userId)
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)

			return redirectWithToast(`/${organization.slug}/website`, {
				title: 'Custom domain added',
				description: `Point ${customDomain} to ${getCustomHostnameCnameTarget()} via CNAME.`,
				type: 'success',
			})
		} catch (error) {
			return Response.json({
				result: submission.reply({
					formErrors: [
						error instanceof Error
							? error.message
							: 'Failed to connect custom domain. Please try again.',
					],
				}),
			})
		}
	}

	if (intent === removeCustomDomainActionIntent) {
		await requirePermission(ORG_PERMISSIONS.UPDATE_SETTINGS_ANY)

		try {
			if (organization.cloudflareHostnameId) {
				await deleteCustomHostname(organization.cloudflareHostnameId)
			}
			await db
				.update(Organization)
				.set({
					customDomain: null,
					customDomainStatus: null,
					cloudflareHostnameId: null,
				})
				.where(eq(Organization.id, organization.id))
			await invalidateUserOrganizationsCache(userId)
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)

			return redirectWithToast(`/${organization.slug}/website`, {
				title: 'Custom domain removed',
				description: 'Your custom domain has been disconnected.',
				type: 'success',
			})
		} catch {
			return Response.json(
				{ error: 'Failed to remove custom domain' },
				{ status: 500 },
			)
		}
	}

	if (intent === refreshCustomDomainActionIntent) {
		await requirePermission(ORG_PERMISSIONS.UPDATE_SETTINGS_ANY)

		try {
			if (!organization.cloudflareHostnameId || !organization.customDomain) {
				return Response.json(
					{ error: 'No custom domain configured' },
					{ status: 400 },
				)
			}

			const hostname = await getCustomHostname(
				organization.cloudflareHostnameId,
			)
			const status =
				hostname?.status || organization.customDomainStatus || 'pending'

			await db
				.update(Organization)
				.set({ customDomainStatus: status })
				.where(eq(Organization.id, organization.id))
			await invalidateUserOrganizationsCache(userId)
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)

			return redirectWithToast(`/${organization.slug}/website`, {
				title: 'Domain status updated',
				description: `Status is now “${status}”.`,
				type: 'success',
			})
		} catch {
			return Response.json(
				{ error: 'Failed to refresh custom domain status' },
				{ status: 500 },
			)
		}
	}

	if (intent === siteDataRegionActionIntent) {
		await requirePermission(ORG_PERMISSIONS.UPDATE_SETTINGS_ANY)

		const submission = parseWithZod(formData, {
			schema: SiteDataRegionSchema,
		})

		if (submission.status !== 'success') {
			return Response.json({ result: submission.reply() })
		}

		const { dataRegion } = submission.value
		const currentRegion = organization.dataRegion === 'ksa' ? 'ksa' : 'us'

		if (dataRegion === currentRegion) {
			return redirectWithToast(`/${organization.slug}/website`, {
				title: 'Data region unchanged',
				description: 'Customer data is already stored in this region.',
				type: 'message',
			})
		}

		if (
			organization.hasProvisionedDb &&
			submission.value.confirmWipe !== 'true'
		) {
			return Response.json(
				{
					error:
						'Changing region deletes existing customer data. Confirm the wipe and try again.',
				},
				{ status: 400 },
			)
		}

		try {
			if (organization.hasProvisionedDb) {
				await deprovisionTenantDatabase({
					orgId: organization.id,
					dataRegion: currentRegion,
					slug: organization.slug,
					customDomain: organization.customDomain,
				})
			}

			await db
				.update(Organization)
				.set({
					dataRegion,
					hasProvisionedDb: false,
				})
				.where(eq(Organization.id, organization.id))

			if (organization.sitePublished) {
				await provisionTenantDatabase({
					orgId: organization.id,
					dataRegion,
					slug: organization.slug,
					customDomain: organization.customDomain,
				})
				await db
					.update(Organization)
					.set({ hasProvisionedDb: true })
					.where(eq(Organization.id, organization.id))
			}

			await invalidateUserOrganizationsCache(userId)
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)

			return redirectWithToast(`/${organization.slug}/website`, {
				title: 'Data region updated',
				description: organization.hasProvisionedDb
					? dataRegion === 'ksa'
						? 'Previous customer data was deleted. New sign-ins will stay in Saudi Arabia.'
						: 'Previous customer data was deleted. New sign-ins will be stored in the US.'
					: dataRegion === 'ksa'
						? 'Customer data will stay in Saudi Arabia when you publish.'
						: 'Customer data will be stored in the US region when you publish.',
				type: 'success',
			})
		} catch (error) {
			console.error('Failed to update data region:', error)
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: 'Failed to update data region',
				},
				{ status: 500 },
			)
		}
	}

	if (intent === siteLocalesActionIntent) {
		await requirePermission(ORG_PERMISSIONS.UPDATE_WEBSITE_ANY)

		const submission = parseWithZod(formData, {
			schema: SiteLocalesSchema,
		})

		if (submission.status !== 'success') {
			return Response.json({ result: submission.reply() })
		}

		const { locales, defaultLocale } = submission.value

		try {
			await db
				.update(Organization)
				.set({
					siteLocales: serializeSiteLocales(locales as SiteContentLocale[]),
					siteDefaultLocale: defaultLocale,
				})
				.where(eq(Organization.id, organization.id))

			await invalidateUserOrganizationsCache(userId)
			await purgeOrganizationSiteCache(
				organization.id,
				organization.slug,
				organization.customDomain,
			)

			return redirectWithToast(`/${organization.slug}/website`, {
				title: 'Languages updated',
				description: 'Your website languages have been saved.',
				type: 'success',
			})
		} catch {
			return Response.json({
				result: submission.reply({
					formErrors: ['Failed to update languages. Please try again.'],
				}),
			})
		}
	}

	return Response.json({ error: `Invalid intent: ${intent}` }, { status: 400 })
}

export default function WebsiteGeneralSettings() {
	const { organization, localesConfig, cnameTarget, cloudflareConfigured } =
		useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()

	return (
		<AnnotatedLayout className="max-w-4xl">
			<AnnotatedSection>
				<SiteCard
					organization={organization}
					cnameTarget={cnameTarget}
					cloudflareConfigured={cloudflareConfigured}
					actionData={actionData}
				/>
			</AnnotatedSection>

			<AnnotatedSection>
				<SiteLocalesCard
					organization={organization}
					localesConfig={localesConfig}
					actionData={actionData}
				/>
			</AnnotatedSection>
		</AnnotatedLayout>
	)
}
