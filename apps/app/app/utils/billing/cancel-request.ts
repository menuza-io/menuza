/**
 * Shapes shared by the cancel or downgrade request page and its server code
 * (#379). Types only, so the page can import them without the server module.
 */
export type OpenChangeRequest = {
	id: string
	kind: string
	reason: string
	subReason: string | null
	locationIds: string[]
	targetPlan: string | null
	effectiveAt: string | null
	createdAt: string
}

export type CancelRequestContext = {
	/** The end of the current billing period: when a request would take effect. */
	cutoff: string | null
	/** Plain-text words of the configured retention offer, if there is one. */
	retentionOffer: string | null
	locations: Array<{ id: string; name: string }>
	/** The plan a downgrade would move to, when a smaller plan exists. */
	downgradeTo: string | null
	open: OpenChangeRequest | null
}
