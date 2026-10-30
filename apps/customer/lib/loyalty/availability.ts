import { type LoyaltyClient } from './loyalty-client'

/**
 * Whether this site runs a rewards program, from the anonymous
 * `GET /loyalty/program`. It only decides whether entry points to the
 * rewards screen show, so any failure hides them.
 */
export async function loyaltyProgramAvailable(
	client: Pick<LoyaltyClient, 'program'>,
): Promise<boolean> {
	try {
		return (await client.program()) !== null
	} catch {
		return false
	}
}
