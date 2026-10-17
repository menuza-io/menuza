import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { type GuestTag } from '#app/utils/reservations/guests-api.ts'
import {
	guestTagName,
	guestTagVariant,
} from '#app/utils/reservations/guests-view.ts'

export function GuestTagBadge({
	tag,
	className,
}: {
	tag: GuestTag
	className?: string
}) {
	const { _ } = useLingui()
	return (
		<Badge
			variant={guestTagVariant(tag)}
			className={className}
			data-testid={`guest-tag-${tag.id}`}
		>
			<span className="wrap-anywhere">{guestTagName(_, tag)}</span>
		</Badge>
	)
}
