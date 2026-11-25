// Read the actual retained local fork. This follow-up submits no transactions.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('/Users/dd/CascadeProjects/shapes/node_modules/playwright');
const dir = __dirname;
const url = 'http://127.0.0.1:5221';
const rpcUrl = 'http://127.0.0.1:18784';
const owner = '0x5b01599a32C3b99826bca57E97FEBe76986dF14D';
const result = { url, rpcUrl, owner, scope: 'Post-conflict community navigation/help, actual returned manager owner settings/cap review, second-manager cost review', checks: [], writes: [], errors: [] };
async function rpc(method, params = []) {
  const data = await (await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (data.error) throw Error(JSON.stringify(data.error));
  return data.result;
}
(async () => {
  assert.equal(await rpc('eth_chainId'), '0x7a69');
  result.beforeNonce = await rpc('eth_getTransactionCount', [owner, 'latest']);
  const browser = await chromium.launch({ headless: true, executablePath: '/Users/dd/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell' });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  page.on('pageerror', e => result.errors.push(String(e)));
  page.on('request', r => {
    try { for (const q of [JSON.parse(r.postData() || 'null')].flat()) if (/^(eth_send|wallet_send|personal_sign|eth_sign)/.test(q?.method || '')) result.writes.push(q.method); } catch {}
  });
  try {
    await page.goto(url);
    await page.getByRole('heading', { name: 'Design your pool', exact: true }).waitFor();
    result.checks.push('Community design remains the disconnected landing page');
    await page.getByRole('button', { name: 'How it works', exact: true }).click();
    await page.getByRole('heading', { name: 'How it works', exact: true }).waitFor();
    assert.match(await page.locator('body').innerText(), /0\.0005/);
    result.checks.push('Community help and its current mint-fee example retained');
    await page.getByRole('navigation', { name: 'How it works', exact: true }).getByRole('button', { name: /^Main pool/ }).click();
    await page.getByRole('heading', { name: 'How the main pool works', exact: true }).waitFor();
    assert.match(await page.locator('body').innerText(), /three directly minted 0\.01 ETH Shapes/);
    assert.match(await page.locator('body').innerText(), /Owner-paid closeout/);
    result.checks.push('Help tabs retain the three-paid-Shape and owner-funded manager explanation');
    await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Main pool', exact: true }).click();
    const connect = page.getByRole('button', { name: 'Local dev account', exact: true });
    await connect.waitFor(); await connect.click();
    await page.locator('.mp-settings > summary').waitFor({ timeout: 45000 });
    assert.equal(await page.getByRole('button', { name: 'Shared vault', exact: true }).count(), 0);
    result.checks.push('Actual fork manager discovered for the connected owner without a vault address');
    await page.locator('.mp-settings > summary').click();
    assert.equal(await page.getByRole('button', { name: 'Review settings', exact: true }).isEnabled(), true);
    await page.getByText('Quoted gas schedule', { exact: true }).click();
    await page.locator('.mp-settings').screenshot({ path: dir + '/desktop-owner-settings.png' });
    result.checks.push('Owner settings and named quoted gas schedule remain accessible');
    const exit = page.locator('.mp-manager-exit');
    await exit.locator('summary').click();
    await exit.getByLabel('Total wallet debit limit (ETH)', { exact: true }).fill('0.000000000000000001');
    await exit.getByRole('button', { name: 'Review next manager exit step', exact: true }).click();
    await exit.getByText(/This step exceeds your remaining wallet spending limit/).waitFor({ timeout: 45000 });
    assert.equal(await exit.getByRole('button', { name: 'Confirm this bounded step', exact: true }).count(), 0);
    result.checks.push('One-wei caller limit refuses the real first-manager work before confirmation');
    await exit.getByLabel('Total wallet debit limit (ETH)', { exact: true }).fill('0.01');
    await exit.getByRole('button', { name: 'Review next manager exit step', exact: true }).click();
    await exit.getByRole('heading', { name: 'Start owner-paid manager closeout', exact: true }).waitFor();
    assert.equal(await exit.getByRole('button', { name: 'Confirm this bounded step', exact: true }).count(), 1);
    result.checks.push('Sufficient stated limit displays the bounded cost review without submitting');
    await page.getByLabel('Manager', { exact: true }).selectOption('1');
    await page.getByText(/0xddc10602782af652bb913f7bde1fd82981db7dd9/i).waitFor({ timeout: 45000 });
    await exit.locator('summary').click();
    await exit.getByLabel('Total wallet debit limit (ETH)', { exact: true }).fill('0.01');
    await exit.getByRole('button', { name: 'Review next manager exit step', exact: true }).click();
    await exit.getByRole('heading', { name: 'Start owner-paid manager closeout', exact: true }).waitFor({ timeout: 45000 });
    assert.equal(await exit.getByRole('button', { name: 'Confirm this bounded step', exact: true }).count(), 1);
    result.checks.push('Second actual manager has its own bounded cost review; no confirmation is clicked');
    await page.screenshot({ path: dir + '/desktop-manager.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: dir + '/mobile-manager.png', fullPage: true });
    result.mobileWidth = await page.evaluate(() => ({ viewport: window.innerWidth, body: document.body.scrollWidth }));
    assert(result.mobileWidth.body <= result.mobileWidth.viewport, JSON.stringify(result.mobileWidth));
    result.checks.push('390px manager page has no horizontal overflow');
    result.afterNonce = await rpc('eth_getTransactionCount', [owner, 'latest']);
    assert.equal(result.afterNonce, result.beforeNonce);
    assert.equal(result.writes.length, 0);
    assert.equal(result.errors.length, 0);
    result.status = 'PASS';
  } catch (e) {
    result.status = 'FAIL'; result.failure = String(e);
    fs.writeFileSync(dir + '/preview-failure.txt', await page.locator('body').innerText());
    await page.screenshot({ path: dir + '/preview-failure.png', fullPage: true });
    throw e;
  } finally {
    fs.writeFileSync(dir + '/preview.json', JSON.stringify(result, null, 1) + '\n');
    await browser.close();
  }
  console.log(JSON.stringify(result, null, 1));
})().catch(e => { console.error(e); process.exitCode = 1; });
