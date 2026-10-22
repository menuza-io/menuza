import { userHasOrganizationPermission } from '@repo/auth'
import { data, type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { ENV } from 'varlock/env'
import { PosDayReport } from '#app/components/pos/pos-day-report.tsx'
import { TerminalsManager } from '#app/components/pos/terminals-manager.tsx'
import { ZatcaSettings } from '#app/components/pos/zatca-settings.tsx'
import { requireMenuRead } from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { resolvePosUrl } from '#app/utils/pos/url.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug || '',
		{ id: true },
	)
	const userId = await requireMenuRead(request, organization.id)
	const canWrite = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.UPDATE_MENU_ANY,
	)
	return data(
		{
			orgSlug: params.orgSlug || '',
			canWrite,
			posUrl: resolvePosUrl(ENV.POS_URL, process.env.NODE_ENV),
			// The origin the terminal reads the menu and branding from: the
			// canonical App origin, never the Host the request happened to use.
			appUrl: new URL(ENV.BASE_URL).origin,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

export default function TerminalsPage() {
	const { orgSlug, canWrite, posUrl, appUrl } = useLoaderData<typeof loader>()
	return (
		<div className="flex min-w-0 flex-col gap-8">
			<TerminalsManager
				orgSlug={orgSlug}
				canWrite={canWrite}
				posUrl={posUrl}
				appUrl={appUrl}
			/>
			<PosDayReport orgSlug={orgSlug} />
			<ZatcaSettings orgSlug={orgSlug} canWrite={canWrite} />
		</div>
	)
}
