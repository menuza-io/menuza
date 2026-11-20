import { Trans } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import {
	db,
	WebsitePage,
	WebsitePageSection,
	WebsiteRedirect,
} from '@repo/database'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { loadRedirectRows } from '#app/utils/website/redirects.server.ts'
import {
	checkImportTarget,
	crawlSite,
	extractReadablePage,
	pagesFromBackup,
	planImportRedirects,
	proposeSections,
	type SiteBackup,
} from '#app/utils/website/site-import.ts'
import {
	isWebsiteFlagOn,
	WEBSITE_IMPORT_FLAG,
} from '#app/utils/website/website-flags.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)
	return {
		enabled: await isWebsiteFlagOn(organization.id, WEBSITE_IMPORT_FLAG),
	}
}

function suggestSlug(url: string) {
	try {
		const base = new URL(url).pathname
			.replace(/\.(html|php|aspx)$/i, '')
			.split('/')
			.filter(Boolean)
			.pop()
		return base?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'home'
	} catch {
		return 'home'
	}
}

async function guardedFetch(url: string, startHost: string, hops = 0) {
	const target = await checkImportTarget(url, {
		startHost,
		resolve: resolvePublic,
		redirectsFollowed: hops,
	})
	if (!target.ok) return null
	const response = await fetch(target.url, {
		redirect: 'manual',
		signal: AbortSignal.timeout(8000),
	})
	if (response.status >= 300 && response.status < 400) {
		const location = response.headers.get('location')
		if (!location || hops >= 5) return null
		return guardedFetch(
			new URL(location, target.url).toString(),
			startHost,
			hops + 1,
		)
	}
	if (!response.ok) return null
	return response.text()
}

async function resolvePublic(hostname: string) {
	const { lookup } = await import('node:dns/promises')
	try {
		const records = await lookup(hostname, { all: true })
		return records.map((record) => record.address)
	} catch {
		return []
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)
	if (!(await isWebsiteFlagOn(organization.id, WEBSITE_IMPORT_FLAG))) {
		return Response.json({ status: 'error', error: 'off' }, { status: 404 })
	}
	const form = await request.formData()
	const intent = String(form.get('intent') ?? '')
	if (form.get('owned') !== 'yes') {
		return Response.json(
			{ status: 'error', error: 'ownership' },
			{ status: 400 },
		)
	}
	if (intent === 'check') {
		const url = String(form.get('url') ?? '')
		let startHost = ''
		try {
			startHost = new URL(url).hostname
		} catch {
			return Response.json(
				{ status: 'error', error: 'bad_url' },
				{ status: 400 },
			)
		}
		const target = await checkImportTarget(url, {
			startHost,
			resolve: resolvePublic,
		})
		if (!target.ok) {
			return Response.json(
				{ status: 'error', error: target.reason },
				{ status: 400 },
			)
		}
		const robotsText = await guardedFetch(
			new URL('/robots.txt', target.url).toString(),
			startHost,
		)
		const pages = await crawlSite({
			startUrl: target.url.toString(),
			fetchPage: (pageUrl) => guardedFetch(pageUrl, startHost),
			robotsText: robotsText ?? '',
		})
		const proposed = pages.map((page) => ({
			url: page.url,
			title: page.title,
			skipReason: page.skipReason,
			sections: proposeSections(page),
		}))
		const existing = await loadRedirectRows(organization.id)
		const redirects = planImportRedirects({
			pages: proposed.map((page) => ({
				url: page.url,
				slug: page.skipReason ? 'home' : suggestSlug(page.url),
				skipped: Boolean(page.skipReason),
			})),
			existing,
		})
		return Response.json({ status: 'success', proposed, redirects })
	}
	if (intent === 'plan') {
		const raw = String(form.get('pages') ?? '')
		let pages: Array<{ url: string; html: string }> = []
		try {
			pages = JSON.parse(raw) as Array<{ url: string; html: string }>
		} catch {
			return Response.json({ status: 'error', error: 'pages' }, { status: 400 })
		}
		const extracted = pages
			.slice(0, 50)
			.map((page) => extractReadablePage(page.url, page.html))
		const proposed = extracted.map((page) => ({
			url: page.url,
			title: page.title,
			skipReason: page.skipReason,
			sections: proposeSections(page),
		}))
		const existing = await loadRedirectRows(organization.id)
		const redirects = planImportRedirects({
			pages: proposed.map((page) => ({
				url: page.url,
				slug: page.skipReason
					? 'home'
					: page.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
				skipped: Boolean(page.skipReason),
			})),
			existing,
		})
		return Response.json({ status: 'success', proposed, redirects })
	}
	if (intent === 'redirects') {
		const raw = String(form.get('redirects') ?? '[]')
		let rows: Array<{ fromPath: string; toPath: string }> = []
		try {
			rows = JSON.parse(raw) as Array<{ fromPath: string; toPath: string }>
		} catch {
			return Response.json(
				{ status: 'error', error: 'redirects' },
				{ status: 400 },
			)
		}
		const existing = await loadRedirectRows(organization.id)
		const plan = planImportRedirects({
			pages: rows.map((row) => ({
				url: `https://import.invalid${row.fromPath}`,
				slug: row.toPath.replace(/^\//, '') || 'home',
				skipped: false,
			})),
			existing,
		})
		const accepted = plan.filter((row) => row.ok)
		if (accepted.length > 0) {
			await db.insert(WebsiteRedirect).values(
				accepted.map((row) => ({
					organizationId: organization.id,
					fromPath: row.fromPath,
					toPath: row.toPath,
					statusCode: 301,
					source: 'manual',
				})),
			)
		}
		return Response.json({ status: 'success', saved: accepted.length, plan })
	}
	if (intent === 'restore') {
		const raw = String(form.get('backup') ?? '')
		let backup: SiteBackup
		try {
			backup = JSON.parse(raw) as SiteBackup
		} catch {
			return Response.json(
				{ status: 'error', error: 'backup' },
				{ status: 400 },
			)
		}
		const pages = pagesFromBackup(backup)
		const ids: string[] = []
		for (const page of pages) {
			const [row] = await db
				.insert(WebsitePage)
				.values({
					organizationId: organization.id,
					title: page.title,
					slug: page.slug,
					status: 'draft',
					isHomePage: false,
					createdById: userId,
				})
				.returning({ id: WebsitePage.id })
			if (!row) continue
			if (page.sections.length > 0) {
				await db.insert(WebsitePageSection).values(
					page.sections.map((section, index) => ({
						pageId: row.id,
						type: section.type,
						position: index,
						config: JSON.stringify(section.config),
					})),
				)
			}
			ids.push(row.id)
		}
		return Response.json({ status: 'success', pageIds: ids })
	}
	return Response.json({ status: 'error', error: 'intent' }, { status: 400 })
}

export default function ImportSiteRoute() {
	const { enabled } = useLoaderData<typeof loader>()
	const fetcher = useFetcher<{
		status?: string
		error?: string
		proposed?: unknown[]
		redirects?: unknown[]
	}>()
	const [url, setUrl] = useState('')
	const [owned, setOwned] = useState(false)
	if (!enabled) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>Importing a site is turned off.</Trans>
			</p>
		)
	}
	return (
		<div className="space-y-4">
			<h2 className="text-lg font-semibold">
				<Trans>Import your current site</Trans>
			</h2>
			<label className="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					checked={owned}
					onChange={(event) => setOwned(event.target.checked)}
				/>
				<Trans>I own this site or have the right to use its content.</Trans>
			</label>
			<div className="max-w-md space-y-1.5">
				<Label>
					<Trans>Site address</Trans>
				</Label>
				<Input value={url} onChange={(event) => setUrl(event.target.value)} />
			</div>
			<Button
				type="button"
				disabled={!owned || fetcher.state !== 'idle'}
				onClick={() =>
					void fetcher.submit(
						{ intent: 'check', url, owned: owned ? 'yes' : '' },
						{ method: 'POST' },
					)
				}
			>
				<Trans>Check address</Trans>
			</Button>
			{fetcher.data?.proposed ? (
				<p className="text-sm" data-import-found>
					<Trans>
						Found {fetcher.data.proposed.length} pages. Imported pages stay
						drafts until you publish them.
					</Trans>
				</p>
			) : null}
			{fetcher.data?.error === 'blocked' ? (
				<p className="text-destructive text-sm" role="alert">
					<Trans>That address is private or internal and was refused.</Trans>
				</p>
			) : null}
		</div>
	)
}
