import { Redirect } from 'expo-router'

/** The app opens on table booking. */
export default function Index() {
	return <Redirect href="/reservations" />
}
