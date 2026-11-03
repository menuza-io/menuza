/**
 * How the cart store tells the loyalty session that something it depends on
 * changed, without importing it (the loyalty session reads the cart store, so
 * the other direction would be a cycle). Both ends are plain functions; with no
 * listener registered (tests, a till without loyalty) they do nothing.
 */

type Listeners = {
	/** An approved reward left the cart because the cart or its discounts changed. */
	dropped: (approvalId: string) => void
	/** The order on screen was cleared (sold, saved as a tab, or thrown away). */
	cleared: () => void
}

let listeners: Partial<Listeners> = {}

export function registerLoyaltyListeners(next: Partial<Listeners>): void {
	listeners = next
}

export function rewardDropped(approvalId: string): void {
	listeners.dropped?.(approvalId)
}

export function orderCleared(): void {
	listeners.cleared?.()
}
