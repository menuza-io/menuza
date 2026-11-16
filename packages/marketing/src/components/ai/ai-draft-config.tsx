import { type CouponOfferValue } from '../coupon-offer-field.tsx'
import { createContext, useContext, type ReactNode } from 'react'

/**
 * How an editor reaches AI drafts (#155): the App's resource route and the
 * organization. A host wraps its composer or workflow with the provider only
 * when the flag `ai.marketing_drafts` is on and the member may edit; without
 * it no AI control renders anywhere in the editors.
 */
export type AiDraftConfig = {
	/** `POST /resources/marketing/ai-draft`. */
	endpoint: string
	orgSlug: string
	/** The organization's default site language, preselected. */
	defaultLanguage: 'en' | 'ar'
	/** The designer resource route that lists live dishes (`menu_items` intent). */
	menuItemsEndpoint?: string
	/** The message's coupon, so the draft may promote it. */
	offer?: CouponOfferValue | null
	/** Best sellers (item ids and counts) read in the browser; optional. */
	bestSellers?: Array<{ itemId: string; count: number }>
}

const AiDraftContext = createContext<AiDraftConfig | null>(null)

export function AiDraftProvider({
	config,
	children,
}: {
	config: AiDraftConfig | null | undefined
	children: ReactNode
}) {
	return (
		<AiDraftContext.Provider value={config ?? null}>
			{children}
		</AiDraftContext.Provider>
	)
}

/** The AI draft settings, or null when drafts are not available here. */
export function useAiDraftConfig(): AiDraftConfig | null {
	return useContext(AiDraftContext)
}
