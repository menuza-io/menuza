import { useLingui } from '@lingui/react/macro'
import { useCallback } from 'react'
import {
	renderGiftCardLabel,
	type GiftCardLabelKey,
} from '../../lib/gift-cards/labels'

/** The wallet's messages in the active language. */
export function useGiftCardText() {
	const { i18n } = useLingui()
	const label = useCallback(
		(key: GiftCardLabelKey, values?: Record<string, unknown>) =>
			renderGiftCardLabel(i18n, key, values),
		[i18n],
	)
	return { i18n, label }
}
