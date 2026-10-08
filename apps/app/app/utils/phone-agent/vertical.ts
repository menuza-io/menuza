import {
	type MessageVariables,
	type PhoneAgentVertical,
} from '@repo/phone-agent'
import { restaurantVertical } from '@repo/phone-agent-restaurant'

/**
 * The vertical this deployment's phone agent runs. It is the one place that
 * picks a business type: upstream ships `generalVertical` from
 * `@repo/phone-agent`, and a fork swaps in its own plug-in here and in
 * `vertical.server.ts` and `components/phone-agent/vertical-ui.tsx`.
 */
export const phoneAgentVertical: PhoneAgentVertical = restaurantVertical

/**
 * Placeholder values for messages spoken outside a call's context, such as
 * voice previews and the paused-agent message. `{restaurant}` and
 * `{location}` predate `{business}`, and saved messages may still use them.
 */
export function businessMessageVariables(
	businessName: string,
): MessageVariables {
	return {
		business: businessName,
		restaurant: businessName,
		location: businessName,
	}
}
