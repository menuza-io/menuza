import { restaurantPrintUi } from './restaurant/vertical-ui.tsx'
import { type PrintShopUiVertical } from './vertical-ui-types.ts'

/**
 * The print vertical's UI in this deployment. It is the one place that picks
 * a business type in the App UI: upstream ships `{}`, and a fork swaps in its
 * own labels and editor fields here (see `utils/print/vertical.server.ts`).
 */
export const printShopUi: PrintShopUiVertical = restaurantPrintUi
