import { type MessageDescriptor } from '@lingui/core'
import { type PrintQrTarget } from '@repo/common/print-shop'
import { type ComponentType } from 'react'

/**
 * The UI half of a print vertical: labels for what it adds to the catalog,
 * and the editor fields of its QR targets. Registered in `vertical-ui.tsx`;
 * the server half is `utils/print/vertical-contract.server.ts`.
 */

export type PrintQrTargetFieldsProps = {
	/** The design's current target (any kind: check `kind` first). */
	target: PrintQrTarget
	/** What the target's `editorData` returned on the server. */
	data: unknown
	/** The vertical's scopes, for targets that point at one. */
	scopes: Array<{ id: string; name: string }>
}

export type PrintShopUiVertical = {
	/** Names and descriptions of the vertical's products (or core overrides). */
	products?: Record<
		string,
		{ name: MessageDescriptor; description: MessageDescriptor }
	>
	qrTargets?: Record<
		string,
		{
			label: MessageDescriptor
			/** Shown when the target has nothing to print yet. */
			empty?: MessageDescriptor
			/** Shown instead of the proof when the user may not see the codes. */
			hidden?: MessageDescriptor
			/** Editor fields; inputs are read back by the target's `fromForm`. */
			Fields?: ComponentType<PrintQrTargetFieldsProps>
		}
	>
	/** Wording of the featured-items section. */
	featuredItems?: {
		title: MessageDescriptor
		description: MessageDescriptor
		empty: MessageDescriptor
	}
	/** What the vertical calls a scope, and the "address from" field. */
	scope?: { label: MessageDescriptor; source: MessageDescriptor }
	/** The vertical's own words on the Print shop pages, where they differ. */
	copy?: {
		/** Print shop intro, without and with shipped prints. */
		intro?: MessageDescriptor
		introWithShipping?: MessageDescriptor
		/** Hint of the empty print list. */
		empty?: MessageDescriptor
		/** Hint when nothing can be ordered shipped yet. */
		nothingToShip?: MessageDescriptor
	}
}
