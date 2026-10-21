/**
 * The one Turnstile action every public reservation widget requests and the
 * tenant-api verifies (`verifyPublicChallenge`). Sites duplicates the literal
 * (client bundle) and a contract test parses both sides.
 */
export const RESERVATIONS_TURNSTILE_ACTION = 'reservations'
