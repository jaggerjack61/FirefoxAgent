/**
 * Browser-level coverage for the content script's interaction engine.
 *
 * The suite loads the production content bundle into a normal page with a
 * tiny WebExtension runtime shim, then sends the same messages the background
 * gateway sends in Firefox. This catches layout, hit-testing and DOM-event
 * behavior that a Node DOM mock cannot represent faithfully.
 */

import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { ContentRequest, ContentResponse, PageSnapshot } from "@/shared/contentProtocol";

const contentBundle = readFile(new URL("../dist/content/index.js", import.meta.url), "utf8");

declare global {
  interface Window {
    __FFA_CONTENT_LISTENER?: (request: ContentRequest) => ContentResponse | Promise<ContentResponse> | undefined;
  }
}

async function installContentHarness(page: Page, markup: string): Promise<void> {
  await page.goto("/");
  await page.setContent(markup);
  await page.evaluate(() => {
    const runtime = {
      sendMessage: async () => undefined,
      onMessage: {
        addListener(listener: Window["__FFA_CONTENT_LISTENER"]) {
          window.__FFA_CONTENT_LISTENER = listener;
        },
      },
    };
    Object.defineProperty(window, "browser", {
      configurable: true,
      value: { runtime },
    });
  });
  await page.addScriptTag({ content: await contentBundle });
  await page.waitForFunction(() => typeof window.__FFA_CONTENT_LISTENER === "function");
}

async function send(page: Page, request: ContentRequest): Promise<ContentResponse> {
  return page.evaluate(async (message) => {
    const listener = window.__FFA_CONTENT_LISTENER;
    if (!listener) throw new Error("Content listener was not installed");
    const response = await listener(message);
    if (!response) throw new Error("Content listener ignored the request");
    return response;
  }, request);
}

async function snapshot(page: Page): Promise<PageSnapshot> {
  const response = await send(page, {
    kind: "get_snapshot",
    frameId: 0,
    opts: { maxElements: 30, maxTextChars: 1_000, maxLinks: 10 },
  });
  expect(response.ok).toBe(true);
  return response.ok ? response.data as PageSnapshot : Promise.reject(new Error(response.message));
}

test("click waits for a temporarily disabled control and emits a pointer sequence", async ({ page }) => {
  await installContentHarness(page, "<button id='continue' disabled>Continue</button>");
  const snap = await snapshot(page);
  const button = snap.elements.find((element) => element.name === "Continue");
  expect(button).toBeTruthy();

  await page.evaluate(() => {
    const target = document.querySelector<HTMLButtonElement>("#continue")!;
    const events: string[] = [];
    for (const event of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
      target.addEventListener(event, () => events.push(event));
    Object.assign(window, { __interactionEvents: events });
    setTimeout(() => { target.disabled = false; }, 200);
  });

  const response = await send(page, { kind: "click", elementId: button!.id });

  expect(response.ok).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __interactionEvents: string[] }).__interactionEvents)).toEqual([
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
  ]);
});

test("click waits for an overlay to stop intercepting the target", async ({ page }) => {
  await installContentHarness(page, `
    <style>
      #target { position: fixed; left: 40px; top: 40px; width: 180px; height: 50px; }
      #overlay { position: fixed; inset: 0; z-index: 10; background: rgb(0 0 0 / 0.1); }
    </style>
    <button id="target">Save changes</button>
    <div id="overlay"></div>
  `);
  const snap = await snapshot(page);
  const button = snap.elements.find((element) => element.name === "Save changes");
  expect(button).toBeTruthy();

  await page.evaluate(() => {
    const target = document.querySelector<HTMLButtonElement>("#target")!;
    target.addEventListener("click", () => {
      Object.assign(window, { __overlayPresentAtClick: Boolean(document.querySelector("#overlay")) });
    });
    setTimeout(() => document.querySelector("#overlay")?.remove(), 200);
  });

  const response = await send(page, { kind: "click", elementId: button!.id });

  expect(response.ok).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __overlayPresentAtClick?: boolean }).__overlayPresentAtClick)).toBe(false);
});

test("click scrolls an off-screen target into the viewport", async ({ page }) => {
  await installContentHarness(page, `
    <div style="height: 2200px"></div>
    <button id="bottom">Load more</button>
  `);
  const snap = await snapshot(page);
  const button = snap.elements.find((element) => element.name === "Load more");
  expect(button).toBeTruthy();

  await page.evaluate(() => {
    document.querySelector("#bottom")?.addEventListener("click", (event) => {
      const rect = (event.currentTarget as Element).getBoundingClientRect();
      Object.assign(window, { __insideViewportAtClick: rect.top >= 0 && rect.bottom <= innerHeight });
    });
  });

  const response = await send(page, { kind: "click", elementId: button!.id });

  expect(response.ok).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __insideViewportAtClick?: boolean }).__insideViewportAtClick)).toBe(true);
});

test("fill waits for editability and updates a controlled text field", async ({ page }) => {
  await installContentHarness(page, "<label for='email'>Email</label><input id='email' readonly>");
  const snap = await snapshot(page);
  const input = snap.elements.find((element) => element.name === "Email");
  expect(input).toBeTruthy();

  await page.evaluate(() => {
    const target = document.querySelector<HTMLInputElement>("#email")!;
    const events: string[] = [];
    let state = "";
    let editedWhileReadonly = false;
    for (const eventName of ["beforeinput", "input", "change"]) {
      target.addEventListener(eventName, () => {
        events.push(eventName);
        if (eventName === "input") {
          editedWhileReadonly = target.readOnly;
          state = target.value;
          // Approximate a controlled UI committing its state back to the DOM.
          target.value = state;
        }
      });
    }
    Object.assign(window, {
      __inputResult: () => ({ events, state, editedWhileReadonly, value: target.value }),
    });
    setTimeout(() => { target.readOnly = false; }, 200);
  });

  const response = await send(page, { kind: "type_text", elementId: input!.id, text: "sam@example.com" });
  const result = await page.evaluate(() => (window as unknown as {
    __inputResult: () => { events: string[]; state: string; editedWhileReadonly: boolean; value: string };
  }).__inputResult());

  expect(response.ok).toBe(true);
  expect(result).toEqual({
    events: ["beforeinput", "input", "change"],
    state: "sam@example.com",
    editedWhileReadonly: false,
    value: "sam@example.com",
  });
});

test("stable element ids survive value and checked-state changes", async ({ page }) => {
  await installContentHarness(page, `
    <input id="unlabelled" type="text">
    <label><input id="flag" type="checkbox"> Enable alerts</label>
  `);
  const snap = await snapshot(page);
  const textInput = snap.elements.find((element) => element.tag === "input" && element.type === "text");
  const checkbox = snap.elements.find((element) => element.role === "checkbox");
  expect(textInput).toBeTruthy();
  expect(checkbox).toBeTruthy();

  expect((await send(page, { kind: "type_text", elementId: textInput!.id, text: "first" })).ok).toBe(true);
  expect((await send(page, { kind: "clear_input", elementId: textInput!.id })).ok).toBe(true);
  expect((await send(page, { kind: "check", elementId: checkbox!.id, checked: true })).ok).toBe(true);
  expect((await send(page, { kind: "check", elementId: checkbox!.id, checked: false })).ok).toBe(true);

  expect(await page.locator("#unlabelled").inputValue()).toBe("");
  expect(await page.locator("#flag").isChecked()).toBe(false);
});
