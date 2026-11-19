/**
 * Website, SEO, Keywords (#182, flag `seo.rank_tracking`): up to ten keywords
 * per location, one primary, each optionally linked to the page that should
 * rank for it, and the weekly local rank checks with their history. 404 while
 * the flag is off. Read with `read:website:any`, change with
 * `update:website:any`.
 */
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { parseStoredCuisines } from '@repo/common/cuisines'
import {
	MAX_KEYWORDS_PER_LOCATION,
	RANK_DEPTH,
	suggestKeywords,
} from '@repo/common/seo-keywords'
import {
	parseSiteLocalesConfig,
	pickLocalized,
} from '@repo/common/site-locales'
import {
	and,
	asc,
	db,
	eq,
	OrganizationLocation,
	OrganizationMenuItem,
	WebsitePage,
} from '@repo/database'
import { cn } from '@repo/ui'
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
import { PageHeader } from '@repo/ui/page-header'
import {
	type ActionFunctionArgs,
	Link,
	type LoaderFunctionArgs,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	addKeyword,
	isRankTrackingEnabled,
	loadKeywordScreen,
	removeKeyword,
	setKeywordPage,
	setPrimaryKeyword,
} from '#app/utils/seo/rank-tracking.server.ts'

async function requireKeywordsAccess(
	request: Request,
	orgSlug: string | undefined,
	permission: 'read' | 'update',
) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		slug: true,
		cuisines: true,
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
	if (!(await isRankTrackingEnabled(organization.id))) {
		throw new Response('Not Found', { status: 404 })
	}
	return organization
}

function cityOf(address: string | null): string | null {
	if (!address) return null
	try {
		const parsed = JSON.parse(address) as { city?: unknown }
		return typeof parsed.city === 'string' ? parsed.city.trim() || null : null
	} catch {
		return null
	}
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireKeywordsAccess(
		request,
		params.orgSlug,
		'read',
	)
	const { locales, defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const [locations, popular, pages, dishPages, screen] = await Promise.all([
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				slug: OrganizationLocation.slug,
				address: OrganizationLocation.address,
				cuisines: OrganizationLocation.cuisines,
			})
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, organization.id),
					eq(OrganizationLocation.isActive, true),
				),
			)
			.orderBy(asc(OrganizationLocation.name)),
		db
			.select({ name: OrganizationMenuItem.displayName })
			.from(OrganizationMenuItem)
			.where(
				and(
					eq(OrganizationMenuItem.organizationId, organization.id),
					eq(OrganizationMenuItem.isPopular, true),
				),
			)
			.limit(5),
		db
			.select({
				id: WebsitePage.id,
				title: WebsitePage.title,
				isHomePage: WebsitePage.isHomePage,
			})
			.from(WebsitePage)
			.where(
				and(
					eq(WebsitePage.organizationId, organization.id),
					eq(WebsitePage.status, 'published'),
				),
			),
		db
			.select({
				id: OrganizationMenuItem.id,
				name: OrganizationMenuItem.displayName,
			})
			.from(OrganizationMenuItem)
			.where(
				and(
					eq(OrganizationMenuItem.organizationId, organization.id),
					eq(OrganizationMenuItem.sitePageEnabled, true),
				),
			),
		loadKeywordScreen(organization.id),
	])
	const orgCuisines = parseStoredCuisines(organization.cuisines) ?? []
	const dishNames = popular
		.map((row) => pickLocalized(row.name, defaultLocale, defaultLocale))
		.filter(Boolean)
	const pageOptions = [
		{ value: 'home', label: 'home' },
		...locations.map((location) => ({
			value: `location:${location.id}`,
			label: `/locations/${location.slug}`,
		})),
		...dishPages.map((dish) => ({
			value: `dish:${dish.id}`,
			label: pickLocalized(dish.name, defaultLocale, defaultLocale),
		})),
		...pages
			.filter((page) => !page.isHomePage)
			.map((page) => ({
				value: `page:${page.id}`,
				label:
					pickLocalized(page.title, defaultLocale, defaultLocale) || page.title,
			})),
	]
	return {
		orgSlug: organization.slug,
		usage: screen.usage,
		pageOptions,
		locations: locations.map((location) => {
			const keywords = screen.keywords.filter(
				(k) => k.locationId === location.id,
			)
			const own = parseStoredCuisines(location.cuisines)
			return {
				id: location.id,
				name: location.name,
				hasCoordinates: (() => {
					try {
						const parsed = JSON.parse(location.address ?? 'null') as {
							lat?: number
							lng?: number
						} | null
						return Boolean(parsed && parsed.lat && parsed.lng)
					} catch {
						return false
					}
				})(),
				keywords,
				suggestions: suggestKeywords({
					cuisines: own?.length ? own : orgCuisines,
					dishes: dishNames,
					city: cityOf(location.address),
					includeArabic: locales.includes('ar'),
					existing: keywords.map((k) => k.phrase),
					limit: 8,
				}),
			}
		}),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireKeywordsAccess(
		request,
		params.orgSlug,
		'update',
	)
	const formData = await request.formData()
	const intent = String(formData.get('intent') ?? '')
	const keywordId = String(formData.get('keywordId') ?? '')
	let result: { ok: boolean; error?: string }
	if (intent === 'add-keyword') {
		result = await addKeyword({
			organizationId: organization.id,
			locationId: String(formData.get('locationId') ?? ''),
			phrase: String(formData.get('phrase') ?? ''),
			pageRef: String(formData.get('pageRef') ?? '') || null,
		})
	} else if (intent === 'remove-keyword') {
		result = await removeKeyword(organization.id, keywordId)
	} else if (intent === 'set-primary') {
		result = await setPrimaryKeyword(organization.id, keywordId)
	} else if (intent === 'set-page') {
		result = await setKeywordPage(
			organization.id,
			keywordId,
			String(formData.get('pageRef') ?? '') || null,
		)
	} else {
		return Response.json(
			{ ok: false, error: 'invalid_intent' },
			{ status: 400 },
		)
	}
	const status = result.ok
		? 200
		: result.error === 'keyword_not_found' ||
			  result.error === 'location_not_found'
			? 404
			: 400
	return Response.json(result, { status })
}

const ERRORS = {
	keyword_too_short: msg`Use at least two characters.`,
	keyword_too_long: msg`Use at most 80 characters.`,
	keyword_exists: msg`This keyword is already on the list.`,
	too_many_keywords: msg`A location can have at most ten keywords.`,
	invalid_page: msg`Choose a page from the list.`,
} as const

const REASONS = {
	budget_exhausted: msg`Skipped: this month's checks are used up.`,
	location_missing_coordinates: msg`Skipped: the location has no map position. Check its address.`,
	provider_not_configured: msg`Skipped: rank checks are not set up yet.`,
	provider_error: msg`The check failed. It runs again next week.`,
} as const

function rankTone(rank: number | null) {
	if (rank === null) return 'bg-muted text-muted-foreground'
	if (rank <= 3) return 'bg-emerald-600 text-white'
	if (rank <= 10) return 'bg-amber-500 text-white'
	return 'bg-red-600 text-white'
}

export default function SeoKeywordsRoute() {
	const data = useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const used = data.usage.used
	const budget = data.usage.budget
	return (
		<div className="space-y-6">
			<PageHeader
				title={<Trans>Keywords</Trans>}
				description={
					<Trans>
						Where your locations show up on the map for the searches you choose,
						checked every week. {used} of {budget} checks used this month.
					</Trans>
				}
				headingLevel="h2"
				size="section"
				actions={
					<Button
						variant="outline"
						render={<Link to={`/${data.orgSlug}/website/seo`} />}
					>
						<Trans>Back to SEO</Trans>
					</Button>
				}
			/>
			{data.locations.map((location) => (
				<LocationKeywords
					key={location.id}
					location={location}
					pageOptions={data.pageOptions}
					errorText={(code) =>
						code && code in ERRORS
							? _(ERRORS[code as keyof typeof ERRORS])
							: null
					}
					reasonText={(code) =>
						code && code in REASONS
							? _(REASONS[code as keyof typeof REASONS])
							: null
					}
					formatDate={(iso) =>
						i18n.date(new Date(iso), { dateStyle: 'medium' })
					}
				/>
			))}
		</div>
	)
}

type LocationData = ReturnType<
	typeof useLoaderData<typeof loader>
>['locations'][number]

function LocationKeywords({
	location,
	pageOptions,
	errorText,
	reasonText,
	formatDate,
}: {
	location: LocationData
	pageOptions: Array<{ value: string; label: string }>
	errorText: (code: string | undefined) => string | null
	reasonText: (code: string | null) => string | null
	formatDate: (iso: string) => string
}) {
	const { _ } = useLingui()
	const addFetcher = useFetcher<{ ok: boolean; error?: string }>()
	const actionFetcher = useFetcher<{ ok: boolean; error?: string }>()
	const full = location.keywords.length >= MAX_KEYWORDS_PER_LOCATION
	const error = errorText(addFetcher.data?.error)
	const count = location.keywords.length
	return (
		<Card data-testid={`keywords-${location.id}`}>
			<CardHeader>
				<CardTitle className="text-base">{location.name}</CardTitle>
				<CardDescription>
					<Trans>{count} of 10 keywords</Trans>
					{!location.hasCoordinates ? (
						<span className="text-destructive ms-2">
							<Trans>
								No map position: checks are skipped until the address has one.
							</Trans>
						</span>
					) : null}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5">
				<addFetcher.Form
					method="POST"
					className="flex flex-wrap items-end gap-2"
				>
					<input type="hidden" name="intent" value="add-keyword" />
					<input type="hidden" name="locationId" value={location.id} />
					<Input
						name="phrase"
						required
						maxLength={80}
						dir="auto"
						disabled={full}
						className="max-w-xs"
						aria-label={_(msg`New keyword`)}
					/>
					<Button type="submit" disabled={full || addFetcher.state !== 'idle'}>
						<Trans>Add keyword</Trans>
					</Button>
					{error ? (
						<p role="alert" className="text-destructive w-full text-sm">
							{error}
						</p>
					) : null}
				</addFetcher.Form>
				{location.suggestions.length && !full ? (
					<div className="flex flex-wrap gap-2">
						<span className="text-muted-foreground text-xs">
							<Trans>Suggestions:</Trans>
						</span>
						{location.suggestions.map((phrase) => (
							<Button
								key={phrase}
								type="button"
								size="sm"
								variant="outline"
								dir="auto"
								onClick={() =>
									void addFetcher.submit(
										{ intent: 'add-keyword', locationId: location.id, phrase },
										{ method: 'POST' },
									)
								}
							>
								{phrase}
							</Button>
						))}
					</div>
				) : null}
				<ul className="divide-y">
					{location.keywords.map((keyword) => {
						const latest = keyword.history.find(
							(check) => check.status === 'ok',
						)
						const lastSkipped =
							keyword.history[0] && keyword.history[0].status !== 'ok'
								? keyword.history[0]
								: null
						const average = latest?.averageRank ?? null
						return (
							<li key={keyword.id} className="space-y-3 py-3">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-medium" dir="auto">
										{keyword.phrase}
									</span>
									{keyword.isPrimary ? (
										<Badge variant="secondary">
											<Trans>Primary</Trans>
										</Badge>
									) : (
										<Button
											size="sm"
											variant="ghost"
											onClick={() =>
												void actionFetcher.submit(
													{ intent: 'set-primary', keywordId: keyword.id },
													{ method: 'POST' },
												)
											}
										>
											<Trans>Make primary</Trans>
										</Button>
									)}
									{average !== null ? (
										<Badge variant="outline" data-testid="keyword-average">
											{average > RANK_DEPTH ? (
												<Trans>Average: not in the top 20</Trans>
											) : (
												<Trans>Average rank {average}</Trans>
											)}
										</Badge>
									) : null}
									<select
										aria-label={_(msg`Page that should rank`)}
										className="border-input bg-background ms-auto h-8 rounded-md border px-2 text-sm"
										defaultValue={keyword.pageRef ?? ''}
										onChange={(event) =>
											void actionFetcher.submit(
												{
													intent: 'set-page',
													keywordId: keyword.id,
													pageRef: event.currentTarget.value,
												},
												{ method: 'POST' },
											)
										}
									>
										<option value="">—</option>
										{pageOptions.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</select>
									<Button
										size="sm"
										variant="ghost"
										onClick={() =>
											void actionFetcher.submit(
												{ intent: 'remove-keyword', keywordId: keyword.id },
												{ method: 'POST' },
											)
										}
									>
										<Trans>Remove</Trans>
									</Button>
								</div>
								{lastSkipped ? (
									<p
										className="text-muted-foreground text-xs"
										data-testid="keyword-skipped"
									>
										{reasonText(lastSkipped.reason)}
									</p>
								) : null}
								{latest ? (
									<div className="flex flex-wrap items-start gap-6">
										<div
											// Checks always use the default 5 by 5 grid.
											className="grid w-fit grid-cols-5 gap-0.5"
											aria-label={_(
												msg`Rank at each point around the location`,
											)}
										>
											{latest.points.map((point, index) => (
												<span
													key={index}
													className={cn(
														'flex size-7 items-center justify-center rounded text-xs font-medium tabular-nums',
														rankTone(point.rank),
													)}
												>
													{point.rank ?? '20+'}
												</span>
											))}
										</div>
										<ol
											className="text-muted-foreground space-y-1 text-xs"
											data-testid="keyword-history"
										>
											{keyword.history.slice(0, 8).map((check) => (
												<li key={check.id}>
													{formatDate(check.checkedAt)}:{' '}
													{check.status === 'ok' && check.averageRank !== null
														? check.averageRank > RANK_DEPTH
															? '20+'
															: check.averageRank
														: (reasonText(check.reason) ?? '—')}
												</li>
											))}
										</ol>
									</div>
								) : null}
							</li>
						)
					})}
				</ul>
			</CardContent>
		</Card>
	)
}
