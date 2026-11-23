import { jwtAuthApi } from '../api'
import {
	type AccessFetcher,
	inventoryAccessSchema,
	RegionError,
} from './region-client'

/**
 * Reads a short-lived inventory token from the App with the phone's bearer
 * login. Answers 404 while the module is off for the organization and 403 for
 * a member without an inventory role: the screens say so instead of failing.
 */
export const fetchInventoryAccess: AccessFetcher = async (
	organizationId,
	scope,
) => {
	const response = await jwtAuthApi.authenticatedGet<unknown>(
		`/api/inventory/token?organizationId=${encodeURIComponent(organizationId)}&scope=${scope}`,
	)
	if (!response.success || !response.data) {
		throw new RegionError(
			response.status,
			response.error || 'unknown_error',
			null,
		)
	}
	const parsed = inventoryAccessSchema.safeParse({
		...(response.data as object),
		// The token route answers `scope` too; keep what was asked if it is absent.
		scope,
	})
	if (!parsed.success) throw new RegionError(502, 'malformed_response')
	return parsed.data
}
