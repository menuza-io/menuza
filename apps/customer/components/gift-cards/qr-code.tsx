import { useMemo } from 'react'
import { View } from 'react-native'
import Svg, { Path, Rect } from 'react-native-svg'
import { qrPath } from '../../lib/gift-cards/qr'

/**
 * A QR code, always black on white: a code has to scan the same way in every
 * theme, including a dark one, so the colors are not theme tokens. The quiet
 * zone is part of the drawing.
 */
export function QrCode({
	value,
	size = 224,
	accessibilityLabel,
}: {
	value: string
	size?: number
	accessibilityLabel: string
}) {
	const qr = useMemo(() => qrPath(value), [value])
	return (
		<View
			accessible
			accessibilityRole="image"
			accessibilityLabel={accessibilityLabel}
		>
			<Svg width={size} height={size} viewBox={`0 0 ${qr.size} ${qr.size}`}>
				<Rect width={qr.size} height={qr.size} fill="#ffffff" />
				<Path d={qr.path} fill="#000000" />
			</Svg>
		</View>
	)
}
