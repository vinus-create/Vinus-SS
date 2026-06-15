// ShopeeScope — alert helper
// Sends a short message to a Discord/Slack webhook and/or Telegram.
// No-op if nothing is configured. Never throws (alerts must not crash a run).
//
// Configure in scraper/.env (any subset):
//   ALERT_WEBHOOK_URL   = https://discord.com/api/webhooks/...   (or a Slack incoming webhook)
//   TELEGRAM_BOT_TOKEN  = 123456:ABC...
//   TELEGRAM_CHAT_ID    = 987654321

async function notify(message) {
  const text = String(message || '').slice(0, 1800);
  if (!text) return;

  const tasks = [];

  const hook = process.env.ALERT_WEBHOOK_URL;
  if (hook) {
    // Discord reads `content`, Slack reads `text` — send both so one URL works for either.
    tasks.push(
      fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, text }),
      }).catch(e => console.warn('[notify] webhook failed:', e.message))
    );
  }

  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    tasks.push(
      fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text, disable_web_page_preview: true }),
      }).catch(e => console.warn('[notify] telegram failed:', e.message))
    );
  }

  if (!tasks.length) {
    console.log('[notify] (no channel configured) —', text);
    return;
  }
  await Promise.allSettled(tasks);
}

module.exports = { notify };
