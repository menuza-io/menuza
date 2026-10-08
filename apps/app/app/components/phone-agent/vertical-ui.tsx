import { restaurantVerticalUi } from './restaurant/vertical-ui.tsx'
import { type PhoneAgentVerticalUi } from './vertical-ui-types.ts'

/**
 * The UI for this deployment's vertical (see `utils/phone-agent/vertical.ts`).
 * Upstream ships `{}`; a fork swaps in its own here.
 */
export const phoneAgentVerticalUi: PhoneAgentVerticalUi = restaurantVerticalUi
