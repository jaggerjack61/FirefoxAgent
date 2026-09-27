import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Builder, By, until } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

const artifacts = resolve("web-ext-artifacts");
const packageName = readdirSync(artifacts).find((entry) => entry.endsWith(".zip"));
assert(packageName, "web-ext did not produce a Firefox package");

const page = readFileSync(resolve("e2e/page-fixture.html"), "utf8");
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(page);
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const fixtureUrl = `http://127.0.0.1:${server.address().port}`;

const options = new firefox.Options().addArguments("-headless");
const service = new firefox.ServiceBuilder().addArguments("--allow-system-access");
const driver = await new Builder()
  .forBrowser("firefox")
  .setFirefoxOptions(options)
  .setFirefoxService(service)
  .build();

try {
  await driver.installAddon(resolve(artifacts, packageName), true);
  await driver.setContext(firefox.Context.CHROME);
  const extensionUrl = await driver.executeScript(
    'return WebExtensionPolicy.getByID("firefox-agent@example.org").getURL("sidebar/index.html");',
  );
  assert.equal(typeof extensionUrl, "string");
  await driver.executeScript(
    "window.gBrowser.selectedTab = window.gBrowser.addTrustedTab(arguments[0]);",
    extensionUrl,
  );
  await driver.setContext(firefox.Context.CONTENT);
  const handles = await driver.getAllWindowHandles();
  await driver.switchTo().window(handles.at(-1));
  await driver.wait(until.titleIs("BrowserAgent"), 10_000);
  const heading = await driver.wait(until.elementLocated(By.css(".topbar strong")), 10_000);
  assert.equal(await heading.getText(), "BrowserAgent");
  const tabs = await driver.findElements(By.css("nav.tabs button"));
  assert.equal(tabs.length, 4);
  const newChat = await driver.findElements(By.css(".topbar .new-chat"));
  assert.equal(newChat.length, 1);
  const topbarFits = await driver.executeScript(
    "const el = document.querySelector('.topbar'); return el.scrollWidth <= el.clientWidth;",
  );
  assert.equal(topbarFits, true);

  await tabs.at(-1).click();
  await driver.wait(
    until.elementLocated(By.css(".model-picker input[list='provider-model-options']")),
    5_000,
  );
  const loadModels = await driver.findElements(By.css(".model-picker button"));
  assert.equal(loadModels.length, 1);

  // Real sidebar/profile persistence, without contacting any external provider.
  const field = (text) => driver.findElement(By.xpath(`//label[contains(., '${text}')]/input`));
  const replace = async (element, text) => {
    await element.clear();
    await element.sendKeys(text);
  };
  await replace(await field("API base URL"), "https://provider.example/v1");
  await replace(await field("API key"), "test-key-personal");
  await replace(await driver.findElement(By.css(".model-picker input")), "personal-model");
  await driver.findElement(By.css(".settings .primary")).click();
  await driver.wait(until.elementLocated(By.css(".banner")), 5_000);
  await driver.findElement(By.xpath("//button[text()='Add provider / key']")).click();
  await replace(await field("Profile name"), "Work key");
  await replace(await field("API base URL"), "https://provider.example/v1");
  await replace(await field("API key"), "test-key-work");
  await replace(await driver.findElement(By.css(".model-picker input")), "work-model");
  await driver.findElement(By.css(".settings .primary")).click();
  await driver.wait(
    async () => !(await driver.findElement(By.css(".provider-editor")).getAttribute("disabled")),
    5_000,
  );
  await driver.findElement(By.xpath("//nav/button[text()='chat']")).click();
  const profilePicker = await driver.findElement(By.css("select[aria-label='Provider profile']"));
  const profiles = await profilePicker.findElements(By.css("option"));
  assert.equal(profiles.length, 2);
  await profiles[0].click();
  await driver.wait(
    async () =>
      (await driver.findElement(By.css("select[aria-label='Model']")).getAttribute("value")) ===
      "personal-model",
    5_000,
  );
  await driver.navigate().refresh();
  // After a reload React renders only once background state arrives.
  const settingsTab = await driver.wait(
    until.elementLocated(By.xpath("//nav/button[text()='settings']")),
    10_000,
  );
  await settingsTab.click();
  assert.equal(await (await field("API key")).getAttribute("value"), "test-key-personal");

  // Execute the production content bundle in Firefox against a deterministic local DOM.
  // Only the message transport is stubbed; layout, native events, shadow DOM and observers are real.
  await driver.get(fixtureUrl);
  await driver.executeScript(
    "window.browser = {runtime:{onMessage:{addListener(listener){window.contentListener=listener;}}}};",
  );
  await driver.executeScript(readFileSync(resolve("dist/content/index.js"), "utf8"));
  const command = (payload) =>
    driver.executeAsyncScript(
      "const done=arguments[arguments.length-1]; Promise.resolve(window.contentListener(arguments[0])).then(value=>done({value}),error=>done({error:error.message}));",
      payload,
    );
  const readPage = async (query, mode = "controls", cursor = null, maxTokens = 900) => {
    const result = await command({ type: "snapshot", tabId: 1, frameId: 0, query, mode, cursor, maxTokens });
    assert(!result.error, result.error);
    // Same byte-based estimate the content script budgets with.
    assert(Math.ceil(Buffer.byteLength(JSON.stringify(result.value)) / 3.2) <= maxTokens);
    assert(result.value.elements.every((element) => typeof element.handle === "string"));
    return result.value;
  };
  const target = async (query) => {
    const snapshot = await readPage(query);
    const element = snapshot.elements.find((entry) => entry.name === query);
    assert(element, `Missing target: ${query}`);
    return element.handle;
  };
  const act = (action, handle, value) => command({ type: "act", action, handle, value });
  const name = await target("Profile name");
  assert.equal((await act("fill", name, "Alice")).value.status, "succeeded");
  assert.equal(await driver.findElement(By.id("name")).getAttribute("value"), "Alice");
  assert.equal((await act("fill", await target("Controlled input"), "Requested")).value.status, "unverified");
  const check = await target("Enable feature");
  assert.equal((await act("set_checked", check, true)).value.status, "succeeded");
  assert.equal((await act("set_checked", check, true)).value.changed, false);
  assert.equal(await driver.executeScript("return window.checkClicks;"), 1);
  assert.equal(
    (await act("set_checked", await target("Cancelled checkbox"), true)).value.status,
    "unverified",
  );
  const city = await target("City");
  assert.match((await act("select", city, "Duplicate")).error, /ambiguous/);
  assert.equal((await act("select", city, "three")).value.status, "succeeded");
  assert.match((await act("select", city, "four")).error, /disabled/);
  assert.match((await act("click", await target("Disabled fieldset button"))).error, /disabled/);
  assert.match((await act("click", await target("Covered button"))).error, /covered/);
  assert.equal((await act("click", await target("Expand details"))).value.status, "succeeded");
  assert(await target("Shadow labelled button"));
  const link = await target("Continue link");
  await driver.executeScript("document.querySelector('#recycled').href='/dangerous';");
  assert.match((await act("click", link)).error, /STALE_HANDLE/);
  assert.equal((await act("submit", await target("Form text"))).value.status, "unverified");
  assert.equal(await driver.executeScript("return window.submissions;"), 1);

  const found = new Set();
  let cursor = null;
  do {
    const snapshot = await readPage("Indexed control", "controls", cursor, 700);
    for (const element of snapshot.elements) found.add(element.name);
    cursor = snapshot.nextCursor;
  } while (cursor);
  assert.equal([...found].filter((name) => name.startsWith("Indexed control")).length, 160);
  assert(!found.has("Hidden ancestor button"));
  const excerpt = await readPage("research", "text");
  assert(excerpt.blocks.length > 0);
  assert(excerpt.nextCursor);
  let textCursor = null;
  do {
    const snapshot = await readPage("", "text", textCursor);
    assert(!JSON.stringify(snapshot).includes("PRIVATE_"), "Existing form values leaked into page text");
    textCursor = snapshot.nextCursor;
  } while (textCursor);
  assert.equal(
    (await command({ type: "wait", condition: "Hidden ancestor button", timeoutMs: 100 })).value.matched,
    false,
  );
  // Stop plumbing: an in-flight wait is cancelled by cancel_operation.
  // A single in-page script schedules the cancel, since one WebDriver session
  // cannot deliver a second command while an async script is pending.
  const stopResult = await driver.executeAsyncScript(
    `const done = arguments[arguments.length - 1];
     const pending = Promise.resolve(
       window.contentListener({ type: "wait", condition: "Never matching text", timeoutMs: 10000, operationId: "op-e2e" }),
     );
     setTimeout(() => {
       Promise.resolve(window.contentListener({ type: "cancel_operation", operationId: "op-e2e" })).then(
         (cancel) => pending.then(
           (value) => done({ value, cancel }),
           (error) => done({ error: error && error.message, cancel }),
         ),
       );
     }, 200);`,
  );
  assert.equal(stopResult.cancel?.cancelled, true);
  assert.match(stopResult.error ?? "", /Abort|Stopped/);
  assert.equal((await command({ type: "cancel_operation", operationId: "op-e2e" })).value.cancelled, false);
  console.log("Firefox sidebar profiles and content interactions passed.");
} finally {
  await driver.quit();
  await new Promise((done) => server.close(done));
}
