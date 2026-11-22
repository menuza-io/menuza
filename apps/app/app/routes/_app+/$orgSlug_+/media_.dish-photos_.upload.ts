import { requireUserId } from '@repo/auth'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { type Route } from './+types/media_.dish-photos_.upload'
import { action as mediaLibraryAction } from './media.tsx'

/**
 * `POST /<org>/media/dish-photos/upload`: the library upload that Add dish
 * photos in bulk uses (#316). It is the library's own upload action
 * (`POST /<org>/media`, `intent=upload`, one file per request, the same
 * permission, size limit, magic-byte check and re-encoding), served from a
 * resource route so the browser can send many files with plain `fetch` and read
 * the JSON answer: a page route answers a document POST with HTML, and a
 * fetcher per file would reload the page's data after every upload and send a
 * dropped connection to the error boundary.
 *
 * Nothing is re-implemented here; the library action runs its own checks.
 */
export async function action({ request, params, context }: Route.ActionArgs) {
	await requireUserId(request)
	await requireUserOrganization(request, params.orgSlug, { id: true })
	return mediaLibraryAction({
		request,
		params,
		context,
	} as Parameters<typeof mediaLibraryAction>[0])
}
