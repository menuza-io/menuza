import { type EmailBlock } from '@repo/common/email-blocks'
import { EmailBlockEditor, type CouponOfferValue } from '@repo/marketing'
import { useCallback, useRef, useState } from 'react'
import {
	MediaLibraryPicker,
	type MediaLibraryAsset,
} from '#app/components/media-library/media-library-picker.tsx'

/**
 * The email designer of a broadcast, for the composer and the edit page: the
 * block editor with the media library, dishes, the coupon block, saved
 * templates and a way to open a block from the pre-send check. It posts the
 * blocks as a hidden `blocks` field of the surrounding form.
 */
export function CampaignEmailDesigner({
	orgSlug,
	blocks,
	onChange,
	offer,
	focusBlock,
}: {
	orgSlug: string
	blocks: EmailBlock[]
	onChange: (blocks: EmailBlock[]) => void
	/** The message's coupon: the Coupon block needs it and the preview shows it. */
	offer: CouponOfferValue | null
	focusBlock?: { id: string; nonce: number } | null
}) {
	const [libraryPickerOpen, setLibraryPickerOpen] = useState(false)
	const onSelectCallbackRef = useRef<
		((url: string, alt: string) => void) | null
	>(null)

	const handleChooseImage = useCallback(
		(onSelect: (url: string, alt: string) => void) => {
			onSelectCallbackRef.current = onSelect
			setLibraryPickerOpen(true)
		},
		[],
	)

	const handleAssetSelected = useCallback((asset: MediaLibraryAsset) => {
		if (onSelectCallbackRef.current) {
			const baseUrl =
				typeof window !== 'undefined' ? window.location.origin : ''
			const resolvedUrl =
				asset.url.startsWith('http://') || asset.url.startsWith('https://')
					? asset.url
					: `${baseUrl}${asset.url.startsWith('/') ? '' : '/'}${asset.url}`
			onSelectCallbackRef.current(
				resolvedUrl,
				asset.altText || asset.fileName || '',
			)
			onSelectCallbackRef.current = null
		}
	}, [])

	return (
		<div className="space-y-3">
			<input type="hidden" name="blocks" value={JSON.stringify(blocks)} />
			<EmailBlockEditor
				blocks={blocks}
				onChange={onChange}
				onChooseImageFromLibrary={orgSlug ? handleChooseImage : undefined}
				// Sent broadcast emails carry a signed unsubscribe link.
				unsubscribeLinkPreview
				menuItems
				templatesEndpoint={`/${orgSlug}/marketing/templates/designer`}
				couponAvailable={Boolean(offer)}
				requestFields={{ discountOffer: offer ? JSON.stringify(offer) : '' }}
				focusBlock={focusBlock}
			/>
			{orgSlug ? (
				<MediaLibraryPicker
					orgSlug={orgSlug}
					open={libraryPickerOpen}
					onOpenChange={setLibraryPickerOpen}
					onSelect={handleAssetSelected}
					trigger={null}
				/>
			) : null}
		</div>
	)
}
