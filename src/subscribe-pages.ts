import {
  SUBSCRIPTION_CLEANUP_INTERVAL_MS,
  SUBSCRIPTION_CONFIRM_TTL_MS,
} from "@lorenzh/pulse-contract";
import { escapeHtml } from "@lorenzh/pulse-kit";
import type { SubscriptionContact } from "./settings.ts";

/** Parts of the status page that every result page repeats. */
export interface PageShell {
  /** Already escaped. */
  title: string;
  /** Already HTML. */
  wordmark: string;
}

const HOUR_MS = 3_600_000;
const CONFIRM_HOURS = SUBSCRIPTION_CONFIRM_TTL_MS / HOUR_MS;
// A pending row is removed by the first cleanup after its link expired.
const DELETE_HOURS = (SUBSCRIPTION_CONFIRM_TTL_MS + SUBSCRIPTION_CLEANUP_INTERVAL_MS) / HOUR_MS;

/** The R10 contact as a link; both forms go through `escapeHtml`. */
export function contactLink(contact: SubscriptionContact): string {
  switch (contact.kind) {
    case "email": {
      const safe = escapeHtml(contact.address);
      return `<a href="mailto:${safe}">${safe}</a>`;
    }
    case "url": {
      const safe = escapeHtml(contact.url);
      return `<a href="${safe}">${safe}</a>`;
    }
    default: {
      const unreachable: never = contact;
      return String(unreachable);
    }
  }
}

function notice(contact: string): string {
  return `<div id="subscribe-notice">
<h3>About your data</h3>
<p>We store your email address, whether and when you confirmed it, when you subscribed, how many confirmation emails we sent, a fingerprint of your current confirmation link, and a record of each incident email to you (sent or failed, and when). We use them only to send you incident updates of this status page. We do not log your address.</p>
<p>If you do not confirm, we delete all of it within ${DELETE_HOURS} hours of the last confirmation email. The confirmation link works for ${CONFIRM_HOURS} hours. After you confirm, we keep it until you unsubscribe.</p>
<p>Every email has an unsubscribe link. It deletes your address and these records at once, also from emails that are waiting to be sent. One email that is being sent at that moment can still arrive. Deleting does not remove emails already sent, or copies in the operator's backups.</p>
<p>To ask about your data, or to have it deleted without a link, contact ${contact}.</p>
</div>`;
}

/** The subscribe section of `GET /`; `error` is a fixed text, never a request value. */
export function subscribeSection(contact: string, error?: string): string {
  const errorLine =
    error === undefined
      ? ""
      : `<p class="subscribe-error" id="subscribe-error" role="alert">${error}</p>\n`;
  const described = error === undefined ? "subscribe-notice" : "subscribe-error subscribe-notice";
  return `<section id="subscribe" aria-labelledby="subscribe-title">
<h2 id="subscribe-title">Get incident updates by email</h2>
<form method="post" action="/subscribe">
${errorLine}<label for="subscribe-email">Email address</label>
<input id="subscribe-email" name="email" type="email" autocomplete="email" required maxlength="254" aria-describedby="${described}">
${notice(contact)}
<button type="submit">Subscribe</button>
</form>
<p>We send a confirmation link first. Every email has a link to unsubscribe.</p>
</section>`;
}

/** A whole server-rendered page with the status page's title, wordmark, theme and CSS. */
export function resultPage(shell: PageShell, heading: string, body: string): string {
  return `<!doctype html>
<html lang="en" data-theme="system">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(heading)} - ${shell.title}</title>
<link rel="stylesheet" href="/theme.css">
<script src="/theme-init.js"></script>
<link rel="stylesheet" href="/page.css">
</head>
<body>
<header>
  <h1>${shell.wordmark}</h1>
</header>
<main class="subscribe-page">
<h2>${escapeHtml(heading)}</h2>
${body}
<p><a href="/">Back to the status page</a></p>
</main>
</body>
</html>
`;
}

/** The `200` page of a valid link: a form that posts the request's own, checked token once. */
export function tokenFormPage(
  shell: PageShell,
  link: { action: "/subscribe/confirm" | "/unsubscribe"; heading: string; button: string },
  token: string,
): string {
  return resultPage(
    shell,
    link.heading,
    `<form method="post" action="${link.action}">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit">${escapeHtml(link.button)}</button>
</form>`,
  );
}

/** The one subscribe answer (D15): the same bytes for every address that passed the rule. */
export function subscribeAnswerPage(shell: PageShell, contact: string): string {
  return resultPage(
    shell,
    "Check your inbox",
    `<p>If this address can be subscribed, we send it a confirmation link. The link works for ${CONFIRM_HOURS} hours. If no email arrives within an hour, try again later or contact ${contact}.</p>`,
  );
}

/** A page with one fixed sentence. */
export function messagePage(shell: PageShell, heading: string, text: string): string {
  return resultPage(shell, heading, `<p>${escapeHtml(text)}</p>`);
}
