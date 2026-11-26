import { requireUserId } from '@repo/auth'
import { type LoaderFunctionArgs } from 'react-router'
import { requireMenuRead } from '#app/utils/menu/access.server.ts'
import { loadMenuFile } from '#app/utils/menu/menu-file.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

/** `GET /:orgSlug/menu/export` downloads the menu file. `read:menu:any`. */
export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	await requireMenuRead(request, organization.id)
	const file = await loadMenuFile(organization.id)
	const body = JSON.stringify(file)
	return new Response(body, {
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Disposition': `attachment; filename="${organization.slug}-menu.json"`,
			'Cache-Control': 'private, no-store',
		},
	})
}
