import { useOutletContext } from 'react-router'
import { KioskApp } from '#app/components/kiosk/kiosk-app.tsx'
import { type TenantApiUrls } from '#app/utils/kiosk/kiosk-pair-client.ts'

export default function KioskRoute() {
	const { urls } = useOutletContext<{ urls: TenantApiUrls }>()
	return <KioskApp urls={urls} />
}
