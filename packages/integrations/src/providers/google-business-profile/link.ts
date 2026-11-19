/**
 * The link between a Menuza location and a Google listing (#87). A Google
 * location belongs to ONE Menuza location, across the whole platform: a second
 * claim fails with `gbp_location_taken`. The link row (`GbpLocationSync`) also
 * carries every sync, verification, menu and metrics state, so it is created
 * here, when the operator picks the Google listing.
 */
import { GBP_SYNC_FIELDS, GbpError } from '@repo/common/gbp-listing'
import { and, db, eq, GbpLocationSync, ne, SocialAccount } from '@repo/database'

export type GbpLinkInput = {
	organizationId: string
	organizationLocationId: string
	integrationId: string
	googleLocationName: string
	googleAccountName?: string
}

export async function claimGoogleLocation(
	input: GbpLinkInput,
): Promise<typeof GbpLocationSync.$inferSelect> {
	const [taken] = await db
		.select({ id: GbpLocationSync.id })
		.from(GbpLocationSync)
		.where(
			and(
				eq(GbpLocationSync.googleLocationName, input.googleLocationName),
				ne(
					GbpLocationSync.organizationLocationId,
					input.organizationLocationId,
				),
			),
		)
		.limit(1)
	if (taken) throw new GbpError('gbp_location_taken', 409)

	const [existing] = await db
		.select()
		.from(GbpLocationSync)
		.where(
			eq(GbpLocationSync.organizationLocationId, input.organizationLocationId),
		)
		.limit(1)
	if (existing) {
		const sameListing = existing.googleLocationName === input.googleLocationName
		const [updated] = await db
			.update(GbpLocationSync)
			.set({
				integrationId: input.integrationId,
				googleLocationName: input.googleLocationName,
				googleAccountName:
					input.googleAccountName ?? existing.googleAccountName,
				// A reconnect keeps the state; a different listing starts fresh.
				...(sameListing
					? {
							state: existing.state === 'token_expired' ? 'ok' : existing.state,
						}
					: {
							state: 'ok',
							lastGoogleSnapshot: null,
							fieldState: null,
							verificationState: 'unknown',
							verificationMethod: null,
							verificationName: null,
							verificationRequestedAt: null,
							lastError: null,
						}),
			})
			.where(eq(GbpLocationSync.id, existing.id))
			.returning()
		return updated!
	}
	try {
		const [created] = await db
			.insert(GbpLocationSync)
			.values({
				organizationId: input.organizationId,
				organizationLocationId: input.organizationLocationId,
				integrationId: input.integrationId,
				googleLocationName: input.googleLocationName,
				googleAccountName: input.googleAccountName ?? null,
				fieldsSynced: JSON.stringify(GBP_SYNC_FIELDS),
			})
			.returning()
		return created!
	} catch (error) {
		// Two claims racing for the same Google location: the unique index
		// lets one win.
		const [winner] = await db
			.select({
				organizationLocationId: GbpLocationSync.organizationLocationId,
			})
			.from(GbpLocationSync)
			.where(eq(GbpLocationSync.googleLocationName, input.googleLocationName))
			.limit(1)
		if (
			winner &&
			winner.organizationLocationId !== input.organizationLocationId
		) {
			throw new GbpError('gbp_location_taken', 409)
		}
		throw error
	}
}

/**
 * Disconnecting Google frees the Google location for another link and removes
 * its Google social account. Stored performance figures stay (they belong to
 * the Menuza location, not to the connection).
 */
export async function releaseGoogleLocation(input: {
	integrationId: string
	organizationLocationId: string | null
}) {
	await db
		.delete(GbpLocationSync)
		.where(eq(GbpLocationSync.integrationId, input.integrationId))
	if (input.organizationLocationId) {
		await db
			.delete(SocialAccount)
			.where(
				and(
					eq(SocialAccount.platform, 'google_business'),
					eq(
						SocialAccount.organizationLocationId,
						input.organizationLocationId,
					),
				),
			)
	}
}
