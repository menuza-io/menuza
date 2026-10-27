import {
	generalPrintVertical,
	type PrintShopServerVertical,
} from './vertical-contract.server.ts'

/**
 * The print vertical this deployment runs. It is the one place that picks a
 * business type on the server: upstream ships `generalPrintVertical` from
 * `vertical-contract.server.ts`, and a fork swaps in its own here, in
 * `@repo/common/print-shop-catalog` and in `components/print/vertical-ui.tsx`.
 */
export const printVertical: PrintShopServerVertical = generalPrintVertical
