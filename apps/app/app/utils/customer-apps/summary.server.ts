import {
	CUSTOMER_APP_FLAGS,
	MARKETING_PUSH_FLAG,
	pushCredentialsReady,
	type StoreUrls,
} from '@repo/common/customer-app'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { and, CustomerApp, db, eq, Organization } from '@repo/database'
import { listCredentialStatuses } from './credentials.server.ts'
import { loadPublicCustomerApp } from './public.server.ts'

export type CustomerAppSummary = {
	app: null | {
		id: string
		displayName: string
		iosBundleId: string
		androidPackage: string
		/** Live stores only. */
		stores: StoreUrls
		/** Whether the "Get the app" placement for an email is on. */
		inviteEmail: boolean
	}
	push: {
		/** `customer_app.push` is on for this organization. */
		enabled: boolean
		/** `marketing.push` is on too (marketing broadcasts and automations). */
		marketing: boolean
		/** The credentials the app needs for each platform are set. */
		credentials: { ios: boolean; android: boolean }
	}
}

/** The facts a regional node reads about an organization's app. No secrets. */
export async function loadCustomerAppSummary(
	organizationId: string,
): Promise<CustomerAppSummary> {
	const [organization] = await db
		.select({ id: Organization.id })
		.from(Organization)
		.where(
			and(eq(Organization.id, organizationId), eq(Organization.active, true)),
		)
		.limit(1)
	const empty: CustomerAppSummary = {
		app: null,
		push: {
			enabled: false,
			marketing: false,
			credentials: { ios: false, android: false },
		},
	}
	if (!organization) return empty
	const [pub, row, pushFlag, marketingFlag] = await Promise.all([
		loadPublicCustomerApp(organizationId),
		db
			.select({ id: CustomerApp.id, status: CustomerApp.status })
			.from(CustomerApp)
			.where(eq(CustomerApp.organizationId, organizationId))
			.limit(1)
			.then((rows) => rows[0] ?? null),
		getFeatureFlag(CUSTOMER_APP_FLAGS.push, { organizationId }),
		getFeatureFlag(MARKETING_PUSH_FLAG, { organizationId }),
	])
	if (!pub || !row) return empty
	const credentials = pushCredentialsReady(await listCredentialStatuses(row.id))
	return {
		app: {
			id: row.id,
			displayName: pub.displayName,
			iosBundleId: pub.binding.iosBundleId,
			androidPackage: pub.binding.androidPackage,
			stores: pub.stores,
			inviteEmail: pub.invite.confirmation,
		},
		push: {
			enabled: pushFlag === true,
			marketing: pushFlag === true && marketingFlag === true,
			credentials,
		},
	}
}
