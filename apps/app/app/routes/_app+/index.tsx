import { i18n } from '@lingui/core'
import { t } from '@lingui/macro'
import { getUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { type LoaderFunctionArgs, redirect } from 'react-router'
import { shouldBeOnWaitlist } from '#app/utils/waitlist.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
	const userId = await getUserId(request)

	if (!userId) {
		return redirect('/signup')
	}

	try {
		const { getUserDefaultOrganization } =
			await import('#app/utils/organization/organizations.server.ts')
		const defaultOrg = await getUserDefaultOrganization(userId)

		if (defaultOrg?.organization?.slug) {
			return redirect(`/${defaultOrg.organization.slug}`)
		}
	} catch {
		// Error getting default organization
	}

	const onWaitlist = await shouldBeOnWaitlist(userId)
	if (onWaitlist) {
		throw redirect('/waitlist')
	}

	return redirectWithToast('/organizations/create', {
		title: i18n._(t`Create a restaurant`),
		description: i18n._(
			t`Restaurants are used to manage your locations, menus, and orders.`,
		),
		type: 'message',
	})
}
