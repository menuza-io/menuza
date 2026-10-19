import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { type PersonTag } from '#app/utils/people/people-api.ts'
import {
	personTagName,
	personTagVariant,
} from '#app/utils/people/people-view.ts'

export function PersonTagBadge({
	tag,
	className,
}: {
	tag: PersonTag
	className?: string
}) {
	const { _ } = useLingui()
	return (
		<Badge
			variant={personTagVariant(tag)}
			className={className}
			data-testid={`guest-tag-${tag.id}`}
		>
			<span className="wrap-anywhere">{personTagName(_, tag)}</span>
		</Badge>
	)
}
