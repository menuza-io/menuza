/**
 * Website, SEO (#138, #182): search engine verification codes, IndexNow, and
 * Google Search Console (flag `seo.search_console`). Keywords and local rank
 * checks live on the Keywords tab (`seo.keywords.tsx`, `seo.rank_tracking`).
 * Read with `read:website:any`, change with `update:website:any`.
 */
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { parseVerificationCode } from '@repo/common/site-seo'
import { db, eq, Organization } from '@repo/database'
import {
	integrationManager,
	integrationOAuthCallbackUrl,
	SEARCH_CONSOLE_PROVIDER,
} from '@repo/integrations'
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
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useEffect, useRef } from 'react'
import {
	type ActionFunctionArgs,
	Form,
	Link,
	type LoaderFunctionArgs,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { ENV } from '#app/utils/env.server.ts'
import { redirectToProviderWithHandoff } from '#app/utils/integrations/oauth-redirect.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { ensureIndexNowKey } from '#app/utils/seo/indexnow.server.ts'
import { isRankTrackingEnabled } from '#app/utils/seo/rank-tracking.server.ts'
import {
	isSearchConsoleEnabled,
	loadSearchConsoleIntegration,
	primarySiteUrl,
	readSearchConsoleSummary,
	setupSearchConsole,
	syncSearchConsole,
} from '#app/utils/seo/search-console.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

const ORG_COLUMNS = {
	id: true,
	slug: true,
	customDomain: true,
	customDomainStatus: true,
	googleSiteVerification: true,
	bingSiteVerification: true,
	indexNowKey: true,
	sitePublished: true,
} as const

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(
		request,
		params.orgSlug,
		ORG_COLUMNS,
	)
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)
	const [searchConsole, rankTracking] = await Promise.all([
		isSearchConsoleEnabled(organization.id),
		isRankTrackingEnabled(organization.id),
	])
	const siteUrl = primarySiteUrl(organization)
	return {
		orgSlug: organization.slug,
		siteUrl,
		verification: {
			google: organization.googleSiteVerification ?? '',
			bing: organization.bingSiteVerification ?? '',
		},
		indexNow: organization.indexNowKey
			? { keyUrl: `${siteUrl}${organization.indexNowKey}.txt` }
			: null,
		sitePublished: organization.sitePublished,
		features: { searchConsole, rankTracking },
		searchConsole: searchConsole
			? await readSearchConsoleSummary(organization.id)
			: null,
	}
}

type ActionResult = {
	ok: boolean
	intent?: string
	error?: string
	field?: 'google' | 'bing'
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(
		request,
		params.orgSlug,
		ORG_COLUMNS,
	)
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)
	const formData = await request.formData()
	const intent = String(formData.get('intent') ?? '')

	if (intent === 'save-verification') {
		const values: Record<'google' | 'bing', string | null> = {
			google: null,
			bing: null,
		}
		for (const engine of ['google', 'bing'] as const) {
			const raw = String(formData.get(engine) ?? '').trim()
			if (!raw) continue
			const code = parseVerificationCode(engine, raw)
			if (!code) {
				return Response.json(
					{
						ok: false,
						intent,
						error: 'invalid_verification_code',
						field: engine,
					},
					{ status: 400 },
				)
			}
			values[engine] = code
		}
		await db
			.update(Organization)
			.set({
				googleSiteVerification: values.google,
				bingSiteVerification: values.bing,
			})
			.where(eq(Organization.id, organization.id))
		// Turning on search engine settings also gives the site its IndexNow key.
		await ensureIndexNowKey(organization.id)
		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)
		return Response.json({ ok: true, intent } satisfies ActionResult)
	}

	if (intent === 'enable-indexnow') {
		await ensureIndexNowKey(organization.id)
		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)
		return Response.json({ ok: true, intent } satisfies ActionResult)
	}

	// Everything below is Search Console, behind its flag.
	if (!(await isSearchConsoleEnabled(organization.id))) {
		return Response.json(
			{ ok: false, intent, error: 'not_found' },
			{ status: 404 },
		)
	}

	if (intent === 'connect-search-console') {
		const redirectUri = integrationOAuthCallbackUrl(ENV.BASE_URL ?? '', request)
		const { authUrl, state } = await integrationManager.initiateOAuth(
			organization.id,
			SEARCH_CONSOLE_PROVIDER,
			redirectUri,
			{ redirectUrl: `/${organization.slug}/website/seo?connected=1` },
		)
		return redirectToProviderWithHandoff(
			request,
			organization.id,
			SEARCH_CONSOLE_PROVIDER,
			authUrl,
			state,
		)
	}

	if (intent === 'setup-search-console') {
		const result = await setupSearchConsole(organization)
		return Response.json(
			{ ok: result.ok, intent, error: result.ok ? undefined : result.error },
			{ status: result.ok ? 200 : 409 },
		)
	}

	if (intent === 'sync-search-console') {
		const result = await syncSearchConsole(organization)
		return Response.json(
			{ ok: result.ok, intent, error: result.error },
			{ status: result.ok ? 200 : 409 },
		)
	}

	if (intent === 'disconnect-search-console') {
		const loaded = await loadSearchConsoleIntegration(organization.id)
		// Stored tokens are removed; the property stays in the owner's Google account.
		if (loaded)
			await integrationManager.disconnectIntegration(loaded.integration.id)
		await purgeOrganizationSiteCache(
			organization.id,
			organization.slug,
			organization.customDomain,
		)
		return Response.json({ ok: true, intent } satisfies ActionResult)
	}

	return Response.json({ ok: false, error: 'invalid_intent' }, { status: 400 })
}

const ERROR_MESSAGES = {
	invalid_verification_code: msg`That does not look like a verification code. Paste the code or the whole meta tag.`,
	gsc_not_owner: msg`Your Google account does not own this site in Search Console. Ask the owner to add you as an owner in Search Console, Settings, Users and permissions, then connect again.`,
	gsc_verification_failed: msg`Google could not see the verification tag yet. We will try again automatically.`,
	gsc_api_error: msg`Search Console did not answer. We will try again later.`,
	gsc_not_connected: msg`Search Console is not connected.`,
	sitemap_errors: msg`Search Console found errors in your sitemap.`,
	sitemap_warnings: msg`Search Console reported warnings for your sitemap.`,
	pages_not_indexed: msg`Some pages in your sitemap are not indexed yet.`,
} as const

function errorMessage(code: string | undefined) {
	return code && code in ERROR_MESSAGES
		? ERROR_MESSAGES[code as keyof typeof ERROR_MESSAGES]
		: null
}

export default function WebsiteSeoRoute() {
	const data = useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const verificationFetcher = useFetcher<ActionResult>()
	const consoleFetcher = useFetcher<ActionResult>()
	const indexNowFetcher = useFetcher<ActionResult>()
	const summary = data.searchConsole
	const setupStarted = useRef(false)

	// Right after connecting (or while Google has not seen the tag yet), finish
	// the setup without asking the operator to press anything.
	const needsSetup =
		summary?.connected &&
		(summary.config.siteUrl !== data.siteUrl ||
			summary.config.status !== 'ready') &&
		summary.config.error !== 'gsc_not_owner'
	useEffect(() => {
		if (!needsSetup || setupStarted.current) return
		setupStarted.current = true
		void consoleFetcher.submit(
			{ intent: 'setup-search-console' },
			{ method: 'POST' },
		)
	}, [needsSetup, consoleFetcher])

	const verificationError = errorMessage(verificationFetcher.data?.error)
	const number = (value: number) => i18n.number(value)

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<CardTitle className="text-base">
						<Trans>Search engine verification</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Paste the code Google Search Console or Bing Webmaster Tools gives
							you. We add it to your home page as a meta tag.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<verificationFetcher.Form method="POST" className="space-y-4">
						<input type="hidden" name="intent" value="save-verification" />
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-1.5">
								<Label htmlFor="seo-google">
									<Trans>Google site verification</Trans>
								</Label>
								<Input
									id="seo-google"
									name="google"
									defaultValue={data.verification.google}
									dir="ltr"
									aria-invalid={
										verificationFetcher.data?.field === 'google' || undefined
									}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="seo-bing">
									<Trans>Bing verification</Trans>
								</Label>
								<Input
									id="seo-bing"
									name="bing"
									defaultValue={data.verification.bing}
									dir="ltr"
									aria-invalid={
										verificationFetcher.data?.field === 'bing' || undefined
									}
								/>
							</div>
						</div>
						{verificationError ? (
							<p role="alert" className="text-destructive text-sm">
								{_(verificationError)}
							</p>
						) : null}
						{verificationFetcher.data?.ok ? (
							<p role="status" className="text-muted-foreground text-sm">
								<Trans>Saved. It is on your home page now.</Trans>
							</p>
						) : null}
						<Button
							type="submit"
							disabled={verificationFetcher.state !== 'idle'}
						>
							<Trans>Save</Trans>
						</Button>
					</verificationFetcher.Form>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">
						<Trans>Tell search engines about new pages</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							When you publish a page, Bing and other search engines that use
							IndexNow are told which addresses changed, so they visit sooner.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					{data.indexNow ? (
						<p className="text-sm">
							<Badge variant="secondary" className="me-2">
								<Trans>On</Trans>
							</Badge>
							<Trans>Key file:</Trans>{' '}
							<span dir="ltr" className="font-mono text-xs break-all">
								{data.indexNow.keyUrl}
							</span>
						</p>
					) : (
						<indexNowFetcher.Form method="POST">
							<input type="hidden" name="intent" value="enable-indexnow" />
							<Button type="submit" variant="outline">
								<Trans>Turn on</Trans>
							</Button>
						</indexNowFetcher.Form>
					)}
				</CardContent>
			</Card>

			{data.features.rankTracking ? (
				<Card>
					<CardHeader className="flex flex-row items-center justify-between gap-4">
						<div>
							<CardTitle className="text-base">
								<Trans>Local search keywords</Trans>
							</CardTitle>
							<CardDescription>
								<Trans>
									Choose up to ten searches per location and see where you show
									up on the map each week.
								</Trans>
							</CardDescription>
						</div>
						<Button
							variant="outline"
							render={<Link to={`/${data.orgSlug}/website/seo/keywords`} />}
						>
							<Trans>Keywords</Trans>
						</Button>
					</CardHeader>
				</Card>
			) : null}

			{summary ? (
				<Card data-testid="search-console-card">
					<CardHeader>
						<CardTitle className="text-base">
							<Trans>Google Search Console</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>
								Connect once: we add your website, verify it and submit your
								sitemap for you.
							</Trans>
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-5">
						{!summary.connected ? (
							<Form method="POST" reloadDocument>
								<input
									type="hidden"
									name="intent"
									value="connect-search-console"
								/>
								<Button type="submit" disabled={!data.sitePublished}>
									<Trans>Connect Search Console</Trans>
								</Button>
								{!data.sitePublished ? (
									<p className="text-muted-foreground mt-2 text-xs">
										<Trans>Publish your website first.</Trans>
									</p>
								) : null}
							</Form>
						) : (
							<>
								<div className="flex flex-wrap items-center gap-2 text-sm">
									{summary.config.status === 'ready' ? (
										<Badge variant="secondary">
											<Trans>Verified, sitemap submitted</Trans>
										</Badge>
									) : (
										<Badge variant="outline">
											<Trans>Setting up</Trans>
										</Badge>
									)}
									<span dir="ltr" className="font-mono text-xs">
										{summary.config.siteUrl ?? data.siteUrl}
									</span>
								</div>
								{summary.warnings.map((warning) => {
									const message = errorMessage(warning)
									return message ? (
										<p
											key={warning}
											role="alert"
											className="text-destructive text-sm"
											data-testid={`gsc-warning-${warning}`}
										>
											{_(message)}
										</p>
									) : null
								})}
								<div
									className="grid gap-3 sm:grid-cols-3"
									data-testid="gsc-totals"
								>
									<Metric
										label={_(msg`Clicks`)}
										value={number(summary.totals.clicks)}
									/>
									<Metric
										label={_(msg`Impressions`)}
										value={number(summary.totals.impressions)}
									/>
									<Metric
										label={_(msg`Average position`)}
										value={
											summary.totals.position === null
												? '–'
												: number(summary.totals.position)
										}
									/>
								</div>
								{(() => {
									const start = summary.range.startDate
									const end = summary.range.endDate
									return (
										<p className="text-muted-foreground text-xs">
											<Trans>
												Last 28 days, {start} to {end}. Search Console data is
												about two days late.
											</Trans>
										</p>
									)
								})()}
								<TopTable
									title={_(msg`Top searches`)}
									rows={summary.topQueries}
									testId="gsc-top-queries"
								/>
								<TopTable
									title={_(msg`Top pages`)}
									rows={summary.topPages}
									testId="gsc-top-pages"
								/>
								<div className="flex flex-wrap gap-2">
									<consoleFetcher.Form method="POST">
										<input
											type="hidden"
											name="intent"
											value="sync-search-console"
										/>
										<Button
											type="submit"
											variant="outline"
											disabled={consoleFetcher.state !== 'idle'}
										>
											<Trans>Refresh now</Trans>
										</Button>
									</consoleFetcher.Form>
									<consoleFetcher.Form method="POST">
										<input
											type="hidden"
											name="intent"
											value="disconnect-search-console"
										/>
										<Button type="submit" variant="ghost">
											<Trans>Disconnect</Trans>
										</Button>
									</consoleFetcher.Form>
								</div>
							</>
						)}
						{consoleFetcher.data?.error &&
						errorMessage(consoleFetcher.data.error) ? (
							<p role="alert" className="text-destructive text-sm">
								{_(errorMessage(consoleFetcher.data.error)!)}
							</p>
						) : null}
					</CardContent>
				</Card>
			) : null}
		</div>
	)
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-md border p-3">
			<div className="text-muted-foreground text-xs">{label}</div>
			<div className="text-xl font-semibold tabular-nums">{value}</div>
		</div>
	)
}

function TopTable({
	title,
	rows,
	testId,
}: {
	title: string
	rows: Array<{ value: string; clicks: number; impressions: number }>
	testId: string
}) {
	const { i18n } = useLingui()
	if (!rows.length) return null
	return (
		<div className="space-y-2" data-testid={testId}>
			<h3 className="text-sm font-medium">{title}</h3>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>{title}</TableHead>
						<TableHead className="text-end">
							<Trans>Clicks</Trans>
						</TableHead>
						<TableHead className="text-end">
							<Trans>Impressions</Trans>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row.value}>
							<TableCell className="wrap-anywhere" dir="auto">
								{row.value}
							</TableCell>
							<TableCell className="text-end tabular-nums">
								{i18n.number(row.clicks)}
							</TableCell>
							<TableCell className="text-end tabular-nums">
								{i18n.number(row.impressions)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	)
}
