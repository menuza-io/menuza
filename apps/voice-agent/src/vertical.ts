import { generalVertical, type PhoneAgentVertical } from '@repo/phone-agent'

// The one line that picks the business type. A fork for another kind of
// business swaps it (the generic template uses `generalVertical` from
// `@repo/phone-agent`); the rest of the worker only talks to the vertical.
export const phoneAgentVertical: PhoneAgentVertical = generalVertical
