/* global document */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

// Exercise production CSS at sidebar sizes without an API key or extension state.
const css = readFileSync(new URL("../src/sidebar/styles.css", import.meta.url), "utf8");
const driver = await new Builder()
  .forBrowser("firefox")
  .setFirefoxOptions(new firefox.Options().addArguments("-headless"))
  .build();
try {
  await driver.get("about:blank");
  for (const width of [240, 280, 360, 600]) {
    for (const running of [false, true]) {
      const result = await driver.executeScript(
        function (css, width, running) {
          document.head.innerHTML = `<style>${css}</style>`;
          document.body.innerHTML = `<div style="width:${width}px;height:500px">
            <div class="app">
              <header class="topbar"><div class="identity"><strong>BrowserAgent</strong><span class="status">ready</span></div>
                <div class="topbar-actions"><button class="new-chat">New chat</button><select><option>Interactive</option></select></div></header>
              <nav class="tabs"><button>Chat</button><button>Memory</button><button>Usage</button><button>Settings</button></nav>
              <main class="content"><section class="chat"><div class="messages">
                <div class="empty-card"><p>Allow website access</p><button>Grant access</button></div>
                ${Array.from({ length: 10 }, () => `<article class="message assistant"><small>assistant</small><p>${"long-content".repeat(40)}</p><pre>${"code ".repeat(100)}</pre><table><tr>${"<td>Table content</td>".repeat(10)}</tr></table></article>`).join("")}
                <details class="thinking" open><summary>Thinking</summary><div class="thinking-content"><p>${"long-tool-name".repeat(100)}</p></div></details>
              </div><div class="model-bar"><select><option>Provider</option></select><select><option>${"model".repeat(50)}</option></select><button>Load models</button></div>
              <div class="composer">${running ? '<button class="stop">Stop</button>' : ""}<textarea></textarea><button>Send</button></div>
              </section></main>
            </div></div>`;
          const app = document.querySelector(".app");
          const messages = document.querySelector(".messages");
          const composer = document.querySelector(".composer");
          const textarea = document.querySelector("textarea");
          const lastButton = composer.lastElementChild;
          messages.scrollTop = messages.scrollHeight;
          return {
            fits: [app, messages, composer, document.querySelector(".topbar")].every(
              (el) => el.scrollWidth <= el.clientWidth,
            ),
            scrolls: messages.scrollHeight > messages.clientHeight && messages.scrollTop > 0,
            visible: composer.getBoundingClientRect().bottom <= app.getBoundingClientRect().bottom,
            inputWidth: textarea.getBoundingClientRect().width,
            sendAtRight:
              Math.abs(
                lastButton.getBoundingClientRect().right - composer.getBoundingClientRect().right + 10,
              ) < 2,
            noOverlap:
              document.querySelector(".message").getBoundingClientRect().bottom <=
              document.querySelectorAll(".message")[1].getBoundingClientRect().top,
          };
        },
        css,
        width,
        running,
      );
      assert.equal(result.fits, true, `horizontal overflow at ${width}px, running=${running}`);
      assert.equal(result.scrolls, true);
      assert.equal(result.visible, true);
      assert.ok(result.inputWidth > 60);
      assert.equal(result.sendAtRight, true);
      assert.equal(result.noOverlap, true);
    }
  }
  console.log("Chat layout checks passed (240–600px, idle and running).");
} finally {
  await driver.quit();
}
