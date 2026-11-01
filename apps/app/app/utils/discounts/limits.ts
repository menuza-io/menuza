/**
 * The most discounts and coupon codes an organization keeps (archived ones do
 * not count). The region refuses the next one; the editor and the list page
 * word that refusal. These are the numbers `MAX_DISCOUNTS_PER_ORG` and
 * `MAX_CODES_PER_ORG` in `discounts.server.ts` enforce, repeated here because
 * that file is server-only (a test keeps the two equal).
 */
export const DISCOUNTS_LIMIT = 500
export const ORG_CODES_LIMIT = 2000

/** Which organization-wide cap a save, restore or duplicate ran into. */
export type DiscountLimit = 'discounts' | 'codes'
