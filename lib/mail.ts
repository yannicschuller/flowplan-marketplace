// E-mail through SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD,
// SMTP_FROM, SMTP_SECURE). Without SMTP nothing is sent: sendMail() returns
// false and keeps the mail in a short in-memory list (tests, demo).
import { createTransport, type Transporter } from "nodemailer";
import { config } from "./config";

export type Mail = { to: string; subject: string; text: string };
const state = globalThis as unknown as { marketplaceMail?: { key: string; transport: Transporter }; marketplaceOutbox?: Mail[] };

export const outbox = () => (state.marketplaceOutbox ??= []);
export const mailConfigured = () => !!config.smtp();

export async function sendMail(mail: Mail): Promise<boolean> {
  const smtp = config.smtp();
  if (!smtp) {
    const box = outbox();
    box.push(mail);
    if (box.length > 50) box.shift();
    if (config.demo()) console.info(`[mail not sent – no SMTP] to ${mail.to}: ${mail.subject}`);
    return false;
  }
  const key = `${smtp.host}:${smtp.port}:${smtp.user}`;
  if (state.marketplaceMail?.key !== key)
    state.marketplaceMail = {
      key,
      transport: createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        requireTLS: !smtp.secure && smtp.port === 587,
        auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
      }),
    };
  try {
    await state.marketplaceMail.transport.sendMail({ from: smtp.from, to: mail.to, subject: mail.subject, text: mail.text });
    return true;
  } catch (error) {
    console.error("mail failed", error instanceof Error ? error.message : error);
    return false;
  }
}
