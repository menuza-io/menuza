import { type MessageDescriptor } from '@lingui/core'

/**
 * Names of the print vertical's products in Admin. It is the one place Admin
 * picks a business type: upstream ships `{}`, and a fork adds its products'
 * names here (see `@repo/common/print-shop-catalog`).
 */
export const PRINT_VERTICAL_PRODUCT_LABELS: Record<string, MessageDescriptor> =
	{}
