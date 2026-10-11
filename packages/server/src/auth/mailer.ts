export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Outgoing e-mail. Implement this (SMTP, Resend, ...) to deliver password-reset messages for real. */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/**
 * Development mailer: prints the message to the server log instead of sending it.
 * WARNING: reset messages contain a live secret token, so anyone who can read the
 * server log can take over accounts that are being recovered. Replace it before production.
 */
export class ConsoleMailer implements Mailer {
  async send(mail: Mail): Promise<void> {
    console.log(`[mail] to=${mail.to} subject=${JSON.stringify(mail.subject)}\n${mail.text}`);
  }
}
