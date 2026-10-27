/** Whether the Marketing group shows Print shop (flag plus campaign read). */
export type PrintShopNavAccess = { visible: boolean; shipping: boolean }

export const HIDDEN_PRINT_SHOP_NAV: PrintShopNavAccess = {
	visible: false,
	shipping: false,
}
