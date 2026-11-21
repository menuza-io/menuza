import { CUSTOMER_APP_FLAGS } from '@repo/common/customer-app'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { CustomerApp, db, eq, ne, and } from '@repo/database'

/**
 * The Customer app panel (#196, Marketing, Customer app: the "Get the app"
 * switches and tap counts) exists while `customer_app.enabled` is on and the
 * organization has an app that is not archived.
 */
export async function customerAppPanelAvailable(
	organizationId: string,
): Promise<boolean> {
	if (
		(await getFeatureFlag(CUSTOMER_APP_FLAGS.enabled, { organizationId })) !==
		true
	) {
		return false
	}
	const [app] = await db
		.select({ id: CustomerApp.id })
		.from(CustomerApp)
		.where(
			and(
				eq(CustomerApp.organizationId, organizationId),
				ne(CustomerApp.status, 'archived'),
			),
		)
		.limit(1)
	return Boolean(app)
}
