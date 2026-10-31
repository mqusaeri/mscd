// Emails of the verified deletion that carry the signed certificate as an attachment (Milestone 3 D.5.5). The other
// lifecycle emails go through `AccountMailer`; this sender exists because the certificate travels as a file, which the
// account emails never attach. It uses the same SMTP settings (`mail.smtp`), the same templates and bodies
// (identity/mail-templates.ts) and the same rule: a failed send is logged and never fails the purge, which is done.
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { MscdConfig } from '../../../config/mscd-config';
import { htmlBody, renderTemplate, textBody, type MailLanguage, type MailTemplate } from '../../identity/mail-templates';

const CONNECT_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

export interface DeletionMail {
  to: string;
  template: MailTemplate;
  language?: MailLanguage;
  attachment?: { fileName: string; content: string; contentType: string };
}

@Injectable()
export class DeletionMailer implements OnApplicationShutdown {
  private readonly logger = new Logger('DeletionMailer');
  private transport?: Transporter;

  constructor(private readonly config: MscdConfig) {}

  /** Absolute URL of a path of the web app under `http.public_url`. */
  appLink(path = '/'): string {
    const base = this.config.profile.http.public_url.replace(/\/+$/, '');
    return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  /** Sends one message; false (and a log line without the address) when it could not be sent. Never throws. */
  async send(mail: DeletionMail): Promise<boolean> {
    try {
      const rendered = renderTemplate(mail.template, mail.language ?? 'en');
      await this.transporter().sendMail({
        from: this.config.profile.mail.from,
        to: mail.to,
        subject: `[MSCD] ${rendered.title}`,
        text: textBody(rendered),
        html: htmlBody(rendered),
        headers: { 'X-MSCD-Mail': `account:${mail.template.name}` },
        ...(mail.attachment
          ? { attachments: [{ filename: mail.attachment.fileName, content: mail.attachment.content, contentType: mail.attachment.contentType }] }
          : {}),
      });
      return true;
    } catch (error) {
      this.logger.error({ template: mail.template.name }, `Could not send the ${mail.template.name} email: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.transport?.close();
    this.transport = undefined;
  }

  private transporter(): Transporter {
    if (this.transport) return this.transport;
    const smtp = this.config.profile.mail.smtp;
    const password = smtp.password_file ? this.config.readSecretFile(smtp.password_file, 'mail.smtp.password_file') : undefined;
    this.transport = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user ? { auth: { user: smtp.user, pass: password ?? '' } } : {}),
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      // Messages are built from fixed templates and an in-memory attachment; never read files or URLs named in a message.
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    return this.transport;
  }
}
