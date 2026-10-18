import { createContext, type ReactNode, useContext } from 'react'
import { createPortal } from 'react-dom'
import { type ReservationsNavAccess } from '#app/utils/reservations/nav.ts'

export type ReservationsShellLocation = { id: string; name: string }

/**
 * What the Reservations layout shares with the screens below it: who may see
 * which section, the location choice, and two slots in the single page header
 * (meta line and actions). Screens fill the slots with a portal so the header,
 * the section tabs and the context bar stay one stack, in this order.
 */
export type ReservationsShell = {
	orgSlug: string
	nav: ReservationsNavAccess
	locations: readonly ReservationsShellLocation[]
	selectedLocationId: string
	onLocationChange: (locationId: string) => void
	actionsSlot: HTMLElement | null
	metaSlot: HTMLElement | null
}

const ReservationsShellContext = createContext<ReservationsShell | null>(null)

export const ReservationsShellProvider = ReservationsShellContext.Provider

/** `null` outside the layout (a screen rendered on its own, e.g. in a test). */
export function useReservationsShell(): ReservationsShell | null {
	return useContext(ReservationsShellContext)
}

function SlotPortal({
	slot,
	children,
}: {
	slot: 'actionsSlot' | 'metaSlot'
	children: ReactNode
}) {
	const shell = useReservationsShell()
	if (!shell) return <>{children}</>
	const target = shell[slot]
	// The header renders first; wait for its slot rather than flash the
	// content in the wrong place.
	if (!target) return null
	return createPortal(children, target)
}

/** Renders `children` in the page header's action area. */
export function ReservationsHeaderActions({
	children,
}: {
	children: ReactNode
}) {
	return <SlotPortal slot="actionsSlot">{children}</SlotPortal>
}

/** Renders `children` in the page header's meta line (under the title). */
export function ReservationsHeaderMeta({ children }: { children: ReactNode }) {
	return <SlotPortal slot="metaSlot">{children}</SlotPortal>
}
