/**
 * The branded customer app's public facts (#195, #196); null without one. Kept
 * apart from `org.ts` so the pure placement rules import no Worker code.
 */
export type PublicCustomerApp = {
	displayName: string
	binding: {
		appleTeamId: string | null
		iosBundleId: string
		androidPackage: string
		androidSha256: string[]
	}
	/** Only stores that are live. */
	stores: { app_store?: string; play_store?: string }
	invite: {
		banner: boolean
		confirmation: boolean
		footer: boolean
		bannerText: string
	}
}
