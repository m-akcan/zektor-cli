import type { Instance } from './api.js'

/**
 * Why an instance that is not active can't be connected to, in a sentence.
 *
 * Shared by `zektor connect` and the MCP tools. "Wait for provisioning to finish"
 * used to cover every status, which was wrong for most of them: waiting never
 * pays an invoice or undoes a failed creation.
 */
export function whyNotActive(instance: Pick<Instance, 'name' | 'status' | 'failureMessage'>): string {
    const name = instance.name

    switch (instance.status) {
        case 'creating':
            return `${name} is still being created. Try again in a minute.`
        case 'scaling':
            return `${name} is moving to another plan. Try again in a few minutes.`
        case 'inprogress':
            return `${name} is being restored from a backup. Try again once the restore has finished.`
        case 'suspended':
            return `${name} is stopped because of an unpaid invoice. Add a payment method in the dashboard to start it again.`
        case 'error':
            return (
                `${name} is in an error state: creating it, or a change to it, failed.` +
                (instance.failureMessage ? ` ${instance.failureMessage}` : '') +
                ' See the dashboard for details, or contact support.'
            )
        case 'deleting':
            return `${name} is being deleted.`
        case 'deleted':
            return `${name} has been deleted.`
        default:
            return `${name} is ${instance.status}, not active.`
    }
}
