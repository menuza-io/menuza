import { type I18n } from '@lingui/core'
import { isolateName } from './format'
import { loyaltyErrorText, renderLoyaltyLabel } from './labels'
import { type LoyaltyNotice } from './loyalty-store'

/** The one-line outcome the wallet announces (approved, declined, a failure). */
export function loyaltyNoticeText(i18n: I18n, notice: LoyaltyNotice): string {
	if (notice.kind === 'error') return loyaltyErrorText(i18n, notice.code)
	switch (notice.reason) {
		case 'approved':
			return renderLoyaltyLabel(i18n, 'approved', {
				reward: isolateName(notice.rewardName),
			})
		case 'declined':
			return renderLoyaltyLabel(i18n, 'declined', {
				reward: isolateName(notice.rewardName),
			})
	}
}
