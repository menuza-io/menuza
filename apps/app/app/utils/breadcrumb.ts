/**
 * Route `handle` that names a route's record in the top-bar breadcrumb, so
 * `/dashboards/<id>` reads "Dashboards › Q3 overview" instead of the id.
 *
 * The label applies to the id segment of the route's own path, and to deeper
 * paths that reuse it (`/roles/<id>/edit` still shows the role's name).
 */
export type BreadcrumbHandle<LoaderData = unknown> = {
	breadcrumb: (data: LoaderData) => string | null | undefined
}

export function breadcrumbFromHandle(
	handle: unknown,
	loaderData: unknown,
): string | null {
	if (!handle || typeof handle !== 'object' || !('breadcrumb' in handle)) {
		return null
	}
	const { breadcrumb } = handle as Partial<BreadcrumbHandle>
	if (typeof breadcrumb !== 'function' || loaderData === undefined) return null
	try {
		const label = breadcrumb(loaderData)
		return label?.trim() ? label.trim() : null
	} catch {
		return null
	}
}
