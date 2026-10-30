import {
	Calendar,
	CheckCircle2,
	ChevronLeft,
	ChevronRight,
	CircleUser,
	Gift,
	Send,
	type LucideIcon,
} from 'lucide-react-native'
import { type ColorValue } from 'react-native'

export type CustomerIconName =
	| 'calendar-outline'
	| 'gift-outline'
	| 'person-circle-outline'
	| 'chevron-back'
	| 'chevron-forward'
	| 'checkmark-circle'
	| 'paper-plane'

const ICONS: Record<CustomerIconName, LucideIcon> = {
	'calendar-outline': Calendar,
	'gift-outline': Gift,
	'person-circle-outline': CircleUser,
	'chevron-back': ChevronLeft,
	'chevron-forward': ChevronRight,
	'checkmark-circle': CheckCircle2,
	'paper-plane': Send,
}

/** Stroke icons for tabs and reservations (no icon-font assets). */
export function Icon({
	name,
	size = 24,
	color,
}: {
	name: CustomerIconName
	size?: number
	color: ColorValue
}) {
	const Lucide = ICONS[name]
	return <Lucide size={size} color={color} strokeWidth={1.75} />
}
