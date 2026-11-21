import { requireUserId } from '@repo/auth'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { requireHeroVideoAccess } from '#app/utils/website/hero-video/access.server.ts'
import { isHeroVideoRendererConfigured } from '#app/utils/website/hero-video/renderer.server.ts'
import {
	acceptHeroVideo,
	discardHeroVideo,
	listHeroVideos,
	startHeroVideo,
} from '#app/utils/website/hero-video/service.server.ts'

/**
 * Website, hero video (#301): the recent requests with their previews, and
 * starting one, accepting one or discarding one. 404 while
 * `website.hero_video` is off. Read with `read:website:any`, change with
 * `update:website:any`. Starting only queues a background job: nothing on the
 * website changes until a preview is accepted.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireHeroVideoAccess(
		request,
		params.orgSlug,
		'read',
	)
	return {
		rendererReady: isHeroVideoRendererConfigured(),
		...(await listHeroVideos(organization.id)),
	}
}

const STATUS: Record<string, number> = {
	not_found: 404,
	not_ready: 409,
	daily_limit: 429,
	already_running: 409,
	renderer_not_configured: 503,
	hero_video_disabled: 404,
}

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireHeroVideoAccess(
		request,
		params.orgSlug,
		'update',
	)
	const userId = await requireUserId(request)
	const form = await request.formData()
	const intent = String(form.get('intent') ?? '')

	if (intent === 'start') {
		const result = await startHeroVideo({
			organizationId: organization.id,
			userId,
			style: form.get('style'),
			auto: form.get('auto') === 'true',
			photoAssetIds: form.getAll('photoAssetIds').map(String),
			pageId: String(form.get('pageId') ?? '') || null,
		})
		return result.ok
			? Response.json({ ok: true, generationId: result.generationId })
			: Response.json(
					{ ok: false, error: result.error },
					{ status: STATUS[result.error] ?? 400 },
				)
	}
	if (intent === 'accept') {
		const result = await acceptHeroVideo({
			organizationId: organization.id,
			userId,
			generationId: String(form.get('generationId') ?? ''),
			sectionId: String(form.get('sectionId') ?? ''),
		})
		return result.ok
			? Response.json({
					ok: true,
					videoSrc: result.videoSrc,
					videoPoster: result.videoPoster,
				})
			: Response.json(
					{ ok: false, error: result.error },
					{ status: STATUS[result.error] ?? 400 },
				)
	}
	if (intent === 'discard') {
		const result = await discardHeroVideo({
			organizationId: organization.id,
			generationId: String(form.get('generationId') ?? ''),
		})
		return result.ok
			? Response.json({ ok: true })
			: Response.json(
					{ ok: false, error: result.error },
					{ status: STATUS[result.error] ?? 400 },
				)
	}
	return Response.json({ ok: false, error: 'invalid_intent' }, { status: 400 })
}
