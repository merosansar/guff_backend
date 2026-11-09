import type { Logger } from 'pino';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
  /** True when emails really leave the server (not just the log). */
  readonly live: boolean;
}

/**
 * Sends email through Resend's HTTP API (no SMTP library needed). Without an API key,
 * the email is written to the API's log instead, so links can still be clicked while
 * developing. Tests pass a mailer that records what was sent.
 */
export function createMailer(options: { apiKey: string; from: string; log: Logger }): Mailer {
  const { apiKey, from, log } = options;
  if (!apiKey) {
    return {
      live: false,
      async send(email) {
        log.info(
          { to: email.to, subject: email.subject },
          `\n---- email (set RESEND_API_KEY to really send it) ----\nTo: ${email.to}\nSubject: ${email.subject}\n\n${email.text}\n----`,
        );
      },
    };
  }
  return {
    live: true,
    async send(email) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Email service answered ${res.status}: ${detail.slice(0, 200)}`);
      }
    },
  };
}

/** For tests: keeps every email in a list. */
export function memoryMailer(): Mailer & { sent: Email[] } {
  const sent: Email[] = [];
  return {
    live: false,
    sent,
    async send(email) {
      sent.push(email);
    },
  };
}
