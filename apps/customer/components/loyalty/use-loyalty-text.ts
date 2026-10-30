import { useLingui } from '@lingui/react/macro'
import { useCallback } from 'react'
import {
	renderLoyaltyLabel,
	type LoyaltyLabelKey,
} from '../../lib/loyalty/labels'

/** The wallet's shared messages (same ids as the website) in the active language. */
export function useLoyaltyText() {
	const { i18n } = useLingui()
	const label = useCallback(
		(key: LoyaltyLabelKey, values?: Record<string, unknown>) =>
			renderLoyaltyLabel(i18n, key, values),
		[i18n],
	)
	return { i18n, label }
}
