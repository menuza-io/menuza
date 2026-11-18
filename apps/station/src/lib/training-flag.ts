/**
 * Training mode (#383) is a property of the page load: turning it on or off
 * reloads the till, so everything that opens the local store does so once, for
 * the right store. The flag lives in its own localStorage key so a settings
 * reset cannot leave a till half in training.
 */
export const TRAINING_FLAG_KEY = 'station.training.v1'
/** Training orders, shifts and sign-ins live in this IndexedDB database, never in `pos`. */
export const TRAINING_DB_NAME = 'pos-training'

export function readTrainingFlag(
	storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage ===
	'undefined'
		? undefined
		: localStorage,
): boolean {
	try {
		return storage?.getItem(TRAINING_FLAG_KEY) === '1'
	} catch {
		return false
	}
}

const TRAINING = readTrainingFlag()
/** True when this page was loaded in training mode. Fixed until the page reloads. */
export const isTrainingMode = (): boolean => TRAINING
