import type { SendOpts } from '../fulfillment/types.ts'

// Canonical home of the contact-form ack queue name/send-opts (Task 6 fills in the handler here;
// Task 5's `http/contact.ts` imports both from this file so it stays independently green in the
// meantime).
export const FORM_ACK_QUEUE = 'support.form-ack'
export const FORM_ACK_SEND_OPTS = (ticketId: string): SendOpts => ({
  singletonKey: ticketId, retryLimit: 5, retryDelay: 60, retryBackoff: true, expireInSeconds: 120,
})
