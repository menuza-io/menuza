import { requireUserId } from '@repo/auth'
import { data, type ActionFunctionArgs } from 'react-router'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { applyMenuFile } from '#app/utils/menu/menu-file.server.ts'
import {
	MENU_FILE_MAX_BYTES,
	parseMenuFile,
} from '#app/utils/menu/menu-file.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

/**
 * `POST /:orgSlug/menu/import-file` with a Menuza JSON file.
 * `update:menu:any`. Unknown versions are `unsupported_version`.
 */
export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	const userId = await requireMenuWrite(request, organization.id)
	const form = await request.formData()
	const file = form.get('file')
	const text =
		typeof file === 'string'
			? file
			: file instanceof File
				? await file.text()
				: ''
	if (!text) {
		return data({ ok: false, error: 'invalid_file' }, { status: 400 })
	}
	if (text.length > MENU_FILE_MAX_BYTES) {
		return data({ ok: false, error: 'too_large' }, { status: 413 })
	}
	const parsed = parseMenuFile(text)
	if (!parsed.ok) {
		const status = parsed.error === 'unsupported_version' ? 422 : 400
		return data({ ok: false, error: parsed.error }, { status })
	}
	const result = await applyMenuFile({
		organizationId: organization.id,
		userId,
		file: parsed.file,
	})
	await purgeOrganizationSiteCache(organization.id, organization.slug)
	return data({ ok: true, ...result })
}
