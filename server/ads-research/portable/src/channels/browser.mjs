// Shared Playwright bootstrap. A custom module path is supported for local
// development, while production uses the dependency installed with this app.
const PW = process.env.PLAYWRIGHT_PATH || 'playwright';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function launch({ headless = true, locale = 'en-MY' } = {}) {
  let chromium;
  try {
    ({ chromium } = await import(PW));
  } catch (cause) {
    throw new Error(
      `Playwright module is unavailable (${PW}). Install dependencies with npm install or set PLAYWRIGHT_PATH.`,
      { cause },
    );
  }

  let browser;
  try {
    browser = await chromium.launch({ headless });
  } catch (cause) {
    throw new Error(
      'Chromium could not launch. Install the Playwright browser (npx playwright install --with-deps chromium) or configure PLAYWRIGHT_BROWSERS_PATH.',
      { cause },
    );
  }
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 1000 },
    locale,
  });
  return { browser, ctx };
}

/** Detect a bot wall. We never attempt to solve one — we stop and report. */
export async function isBlocked(page) {
  try {
    const t = await page.evaluate(() => document.body?.innerText || '');
    return /unusual traffic|not a robot|recaptcha|verify you are human/i.test(t);
  } catch { return false; }
}
