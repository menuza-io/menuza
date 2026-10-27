/** Whether the Menu group shows QR tables (QR flag plus menu read). */
export type QrOrderingNavAccess = { visible: boolean; dineIn: boolean }

export const HIDDEN_QR_ORDERING_NAV: QrOrderingNavAccess = {
	visible: false,
	dineIn: false,
}
