import { jwtAuthApi } from './index'

/**
 * Contract of the App's `GET /api/menu/photos` (the upload half, a multipart
 * POST, belongs to the photo queue: `lib/photo-queue/upload-photo.ts`).
 */
export interface MenuPhotoDish {
	id: string
	name: string
	categoryName: string | null
	hasPhoto: boolean
	imageUrl: string | null
}

export interface MenuPhotosList {
	organizationId: string
	/** How many dishes have no photo, whatever the list shows. */
	missingCount: number
	items: MenuPhotoDish[]
}

export type MenuPhotosResult =
	| { ok: true; data: MenuPhotosList }
	| {
			ok: false
			/** Server error code (`forbidden`, `not_found`, ...) or `network_error`. */
			code: string
			status: number
			message: string
	  }

export interface MenuPhotosAuthedGet {
	authenticatedGet<T>(path: string): Promise<{
		success: boolean
		data?: T
		error?: string
		message?: string
		status: number
	}>
}

export function menuPhotosPath(params: {
	organizationId: string
	query?: string
	limit?: number
}): string {
	const search = new URLSearchParams({ organizationId: params.organizationId })
	const query = params.query?.trim()
	if (query) search.set('query', query)
	if (params.limit) search.set('limit', String(params.limit))
	return `/api/menu/photos?${search.toString()}`
}

/**
 * Without `query`: the dishes that have no photo, best sellers first. With
 * one: any dish matching by name (so its photo can be replaced).
 */
export async function fetchMenuPhotos(
	params: { organizationId: string; query?: string; limit?: number },
	api: MenuPhotosAuthedGet = jwtAuthApi,
): Promise<MenuPhotosResult> {
	const response = await api.authenticatedGet<MenuPhotosList>(
		menuPhotosPath(params),
	)
	if (!response.success || !response.data) {
		return {
			ok: false,
			code: response.error || 'unknown_error',
			status: response.status,
			message: response.message || 'Failed to load dishes',
		}
	}
	return {
		ok: true,
		data: {
			organizationId: response.data.organizationId,
			missingCount: response.data.missingCount,
			items: response.data.items ?? [],
		},
	}
}
