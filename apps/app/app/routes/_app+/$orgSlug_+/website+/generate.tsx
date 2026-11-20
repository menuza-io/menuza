import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { Button } from '@repo/ui/button'
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
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Link,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	buildGeneratedSite,
	generationsInLastDay,
	loadSiteFacts,
	recordGeneration,
	saveGeneratedDrafts,
	SITE_GENERATIONS_PER_DAY,
} from '#app/utils/website/generate-site.server.ts'
import { SITE_TONES, type SiteTone } from '#app/utils/website/generate-site.ts'
import {
	isWebsiteFlagOn,
	WEBSITE_AI_GENERATE_FLAG,
} from '#app/utils/website/website-flags.ts'

const SampleSchema = z
	.array(
		z.object({ r: z.number().min(0).max(255), g: z.number(), b: z.number() }),
	)
	.max(800)

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)
	const enabled = await isWebsiteFlagOn(
		organization.id,
		WEBSITE_AI_GENERATE_FLAG,
	)
	return { enabled, slug: organization.slug }
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
	const enabled = await isWebsiteFlagOn(
		organization.id,
		WEBSITE_AI_GENERATE_FLAG,
	)
	if (!enabled) {
		return Response.json({ status: 'error', error: 'off' }, { status: 404 })
	}
	const form = await request.formData()
	const intent = String(form.get('intent') ?? '')
	const toneRaw = String(form.get('tone') ?? 'warm')
	const tone = (SITE_TONES as readonly string[]).includes(toneRaw)
		? (toneRaw as SiteTone)
		: 'warm'
	let logoSamples: Array<{ r: number; g: number; b: number }> = []
	const samplesRaw = form.get('samples')
	if (typeof samplesRaw === 'string' && samplesRaw) {
		try {
			const parsed = SampleSchema.safeParse(JSON.parse(samplesRaw))
			if (parsed.success) logoSamples = parsed.data
		} catch {
			logoSamples = []
		}
	}
	if (intent === 'preview') {
		const used = await generationsInLastDay(organization.id)
		if (used >= SITE_GENERATIONS_PER_DAY) {
			return Response.json(
				{ status: 'error', error: 'rate_limit' },
				{ status: 429 },
			)
		}
		await recordGeneration(organization.id)
		const facts = await loadSiteFacts(organization.id, tone, logoSamples)
		const site = buildGeneratedSite(facts)
		return Response.json({ status: 'success', site })
	}
	if (intent === 'apply') {
		const facts = await loadSiteFacts(organization.id, tone, logoSamples)
		const site = buildGeneratedSite(facts)
		const pageIds = await saveGeneratedDrafts(organization.id, userId, site)
		return Response.json({ status: 'success', pageIds })
	}
	return Response.json({ status: 'error', error: 'intent' }, { status: 400 })
}

export default function GenerateSiteRoute() {
	const { enabled, slug } = useLoaderData<typeof loader>()
	const fetcher = useFetcher<{
		status?: string
		error?: string
		site?: { pages: Array<{ title: string; sections: unknown[] }> }
		pageIds?: string[]
	}>()
	const { _ } = useLingui()
	const [tone, setTone] = useState<SiteTone>('warm')
	if (!enabled) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>Creating a site with AI is turned off.</Trans>
			</p>
		)
	}
	const preview = fetcher.data?.site
	return (
		<div className="space-y-6">
			<div className="space-y-1">
				<h2 className="text-lg font-semibold">
					<Trans>Create my site with AI</Trans>
				</h2>
				<p className="text-muted-foreground text-sm">
					<Trans>
						A draft home, About and Contact from your menu and locations.
						Nothing is published.
					</Trans>
				</p>
			</div>
			<div className="max-w-xs space-y-1.5">
				<Label>
					<Trans>Tone</Trans>
				</Label>
				<Select
					value={tone}
					onValueChange={(value) => setTone(value as SiteTone)}
				>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="warm">{_(t`Warm and family`)}</SelectItem>
						<SelectItem value="modern">{_(t`Modern`)}</SelectItem>
						<SelectItem value="upscale">{_(t`Upscale`)}</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					disabled={fetcher.state !== 'idle'}
					onClick={() =>
						void fetcher.submit({ intent: 'preview', tone }, { method: 'POST' })
					}
				>
					{preview ? <Trans>Try again</Trans> : <Trans>Preview</Trans>}
				</Button>
				{preview ? (
					<Button
						type="button"
						variant="outline"
						disabled={fetcher.state !== 'idle'}
						onClick={() =>
							void fetcher.submit({ intent: 'apply', tone }, { method: 'POST' })
						}
					>
						<Trans>Use this site</Trans>
					</Button>
				) : null}
			</div>
			{fetcher.data?.error === 'rate_limit' ? (
				<p className="text-destructive text-sm" role="alert">
					<Trans>You can generate a site 5 times a day.</Trans>
				</p>
			) : null}
			{preview ? (
				<ul className="space-y-2 text-sm" data-generated-preview>
					{preview.pages.map((page) => (
						<li key={page.title}>
							{page.title} · {page.sections.length}
						</li>
					))}
				</ul>
			) : null}
			{fetcher.data?.pageIds ? (
				<p className="text-sm">
					<Link to={`/${slug}/website/pages`}>
						<Trans>Drafts saved. Review them before publishing.</Trans>
					</Link>
				</p>
			) : null}
		</div>
	)
}
