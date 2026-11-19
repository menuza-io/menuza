/**
 * Website, Area pages (#137, flag `website.area_pages`): one page per named
 * delivery zone at `/delivery/<slug>`. Pages without an introduction stay out
 * of search results (noindex) until one is written; at most 50 pages. The
 * operator can switch single areas off. 404 while the flag is off.
 */
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { slugifyTitle } from '@repo/common/site-events'
import {
	buildAreaPages,
	isValidLandingSlug,
	MAX_AREA_PAGES,
} from '@repo/common/site-landing-pages'
import {
	getSiteLocaleNativeLabel,
	parseSiteLocalesConfig,
	serializeLocalizedString,
} from '@repo/common/site-locales'
import {
	and,
	db,
	eq,
	ne,
	OrganizationLocation,
	SiteAreaPage,
} from '@repo/database'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import { Switch } from '@repo/ui/switch'
import { Textarea } from '@repo/ui/textarea'
import { useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { localizedRecord } from '#app/utils/seo/cuisine-form.server.ts'
import { getLandingFeatures } from '#app/utils/seo/landing-pages.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

async function requireAreaPages(
	request: Request,
	orgSlug: string | undefined,
	permission: 'read' | 'update',
) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		slug: true,
		customDomain: true,
		siteLocales: true,
		siteDefaultLocale: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		permission === 'read'
			? ORG_PERMISSIONS.READ_WEBSITE_ANY
			: ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)
	if (!(await getLandingFeatures(organization.id)).areaPages) {
		throw new Response('Not Found', { status: 404 })
	}
	return organization
}

async function loadZones(organizationId: string) {
	const [locations, rows] = await Promise.all([
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				isActive: OrganizationLocation.isActive,
				deliveryZones: OrganizationLocation.deliveryZones,
			})
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, organizationId)),
		db
			.select()
			.from(SiteAreaPage)
			.where(eq(SiteAreaPage.organizationId, organizationId)),
	])
	return { locations, rows }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireAreaPages(request, params.orgSlug, 'read')
	const { locales, defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const { locations, rows } = await loadZones(organization.id)
	// Every zone that could have a page, switched on or not.
	const all = buildAreaPages(
		locations,
		rows.map((row) => ({ ...row, enabled: true })),
	)
	const live = new Set(
		buildAreaPages(locations, rows).map(
			(page) => `${page.locationId}:${page.zoneId}`,
		),
	)
	const rowByZone = new Map(
		rows.map((row) => [`${row.organizationLocationId}:${row.zoneId}`, row]),
	)
	const locationName = new Map(
		locations.map((location) => [location.id, location.name]),
	)
	return {
		locales,
		defaultLocale,
		max: MAX_AREA_PAGES,
		areas: all.map((page) => {
			const row = rowByZone.get(`${page.locationId}:${page.zoneId}`)
			return {
				locationId: page.locationId,
				locationName: locationName.get(page.locationId) ?? '',
				zoneId: page.zoneId,
				name: page.name,
				slug: page.slug,
				enabled: row ? row.enabled : true,
				live: live.has(`${page.locationId}:${page.zoneId}`),
				noIndex: page.noIndex,
				intro: localizedRecord(row?.intro ?? null, defaultLocale),
			}
		}),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireAreaPages(request, params.orgSlug, 'update')
	const formData = await request.formData()
	if (formData.get('intent') !== 'save-area') {
		return Response.json(
			{ ok: false, error: 'invalid_intent' },
			{ status: 400 },
		)
	}
	const locationId = String(formData.get('locationId') ?? '')
	const zoneId = String(formData.get('zoneId') ?? '')
	const { locations } = await loadZones(organization.id)
	const zone = buildAreaPages(locations, []).find(
		(page) => page.locationId === locationId && page.zoneId === zoneId,
	)
	if (!zone)
		return Response.json(
			{ ok: false, error: 'area_not_found' },
			{ status: 404 },
		)
	const slugInput = String(formData.get('slug') ?? '')
		.trim()
		.toLowerCase()
	const slug = slugInput || slugifyTitle(zone.name, 'area')
	if (!isValidLandingSlug(slug)) {
		return Response.json({ ok: false, error: 'invalid_slug' }, { status: 400 })
	}
	const [taken] = await db
		.select({ id: SiteAreaPage.id })
		.from(SiteAreaPage)
		.where(
			and(
				eq(SiteAreaPage.organizationId, organization.id),
				eq(SiteAreaPage.slug, slug),
				ne(SiteAreaPage.zoneId, zoneId),
			),
		)
		.limit(1)
	if (taken)
		return Response.json({ ok: false, error: 'slug_taken' }, { status: 400 })
	const { locales } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const intro: Record<string, string> = {}
	for (const locale of locales) {
		const value = String(formData.get(`intro.${locale}`) ?? '').slice(0, 2000)
		if (value.trim()) intro[locale] = value
	}
	const values = {
		slug,
		intro: Object.keys(intro).length ? serializeLocalizedString(intro) : null,
		enabled: formData.get('enabled') !== 'false',
	}
	await db
		.insert(SiteAreaPage)
		.values({
			organizationId: organization.id,
			organizationLocationId: locationId,
			zoneId,
			...values,
		})
		.onConflictDoUpdate({
			target: [SiteAreaPage.organizationLocationId, SiteAreaPage.zoneId],
			set: { ...values, updatedAt: new Date() },
		})
	await purgeOrganizationSiteCache(
		organization.id,
		organization.slug,
		organization.customDomain,
	)
	return Response.json({ ok: true })
}

export default function WebsiteAreaPagesRoute() {
	const data = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const max = data.max
	return (
		<div className="space-y-6">
			<PageHeader
				title={<Trans>Area pages</Trans>}
				description={
					<Trans>
						A page for each named delivery area. Pages without an introduction
						stay out of search results until you write one. At most {max} pages.
					</Trans>
				}
				headingLevel="h2"
				size="section"
			/>
			{data.areas.length === 0 ? (
				<EmptyState
					title={_(msg`No named delivery areas`)}
					description={_(
						msg`Name a delivery zone in Settings, Locations to give it a page.`,
					)}
					icons={['globe']}
				/>
			) : (
				data.areas.map((area) => (
					<AreaCard
						key={`${area.locationId}:${area.zoneId}`}
						area={area}
						locales={data.locales}
					/>
				))
			)}
		</div>
	)
}

function AreaCard({
	area,
	locales,
}: {
	area: ReturnType<typeof useLoaderData<typeof loader>>['areas'][number]
	locales: string[]
}) {
	const fetcher = useFetcher<{ ok: boolean; error?: string }>()
	const [enabled, setEnabled] = useState(area.enabled)
	const name = area.name
	return (
		<Card data-testid={`area-${area.zoneId}`}>
			<CardHeader>
				<CardTitle className="flex flex-wrap items-center gap-2 text-base">
					<Trans>Delivery to {name}</Trans>
					{area.live && area.noIndex ? (
						<Badge variant="outline">
							<Trans>Hidden from search until it has an introduction</Trans>
						</Badge>
					) : null}
				</CardTitle>
				<CardDescription>{area.locationName}</CardDescription>
			</CardHeader>
			<CardContent>
				<fetcher.Form method="POST" className="space-y-3">
					<input type="hidden" name="intent" value="save-area" />
					<input type="hidden" name="locationId" value={area.locationId} />
					<input type="hidden" name="zoneId" value={area.zoneId} />
					<input type="hidden" name="enabled" value={String(enabled)} />
					<div className="flex items-center gap-3">
						<Switch
							id={`area-enabled-${area.zoneId}`}
							checked={enabled}
							onCheckedChange={setEnabled}
						/>
						<Label htmlFor={`area-enabled-${area.zoneId}`}>
							<Trans>Show this page</Trans>
						</Label>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor={`area-slug-${area.zoneId}`}>
							<Trans>Web address</Trans>
						</Label>
						<Input
							id={`area-slug-${area.zoneId}`}
							name="slug"
							dir="ltr"
							defaultValue={area.slug}
							className="max-w-xs"
						/>
					</div>
					{locales.map((locale) => {
						const language = getSiteLocaleNativeLabel(locale)
						return (
							<div key={locale} className="space-y-1.5">
								<Label htmlFor={`area-intro-${area.zoneId}-${locale}`}>
									<Trans>Introduction ({language})</Trans>
								</Label>
								<Textarea
									id={`area-intro-${area.zoneId}-${locale}`}
									name={`intro.${locale}`}
									dir={locale === 'ar' ? 'rtl' : undefined}
									rows={3}
									maxLength={2000}
									defaultValue={area.intro[locale] ?? ''}
								/>
							</div>
						)
					})}
					{fetcher.data?.error ? (
						<p role="alert" className="text-destructive text-sm">
							{fetcher.data.error}
						</p>
					) : null}
					<Button
						type="submit"
						variant="outline"
						disabled={fetcher.state !== 'idle'}
					>
						<Trans>Save</Trans>
					</Button>
				</fetcher.Form>
			</CardContent>
		</Card>
	)
}
