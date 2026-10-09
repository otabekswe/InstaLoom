import { expect, test, type Page } from "@playwright/test";
import { createTestSession } from "./setup";

async function signIn(page: Page) {
  await page.context().addCookies([{ name: "instaloom_session", value: await createTestSession(), domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/inbox");
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole("button", { name: /Conversation with Ada Morgan/ })).toBeVisible();
}

test("protects the workspace and offers only Instagram sign-in", async ({ page, request }) => {
  expect((await request.get("/api/accounts")).status()).toBe(401);
  await page.goto("/inbox");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: "Continue with Instagram" })).toBeVisible();
  await expect(page).toHaveTitle("InstaLoom · Instagram inbox");
  await expect(page.getByRole("link", { name: "InstaLoom" })).toBeVisible();
  await expect(page.locator('input[type="email"], input[type="password"]')).toHaveCount(0);
  expect((await request.post("/api/auth/login", { data: { email: "removed", password: "removed" } })).status()).toBe(404);
  await page.screenshot({ path: test.info().outputPath("instagram-sign-in.png"), fullPage: true });
});

test("starts OAuth in this browser and explains cancelled authorization", async ({ page }) => {
  await page.route("https://www.instagram.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Instagram authorization</title>" }));
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Instagram" }).click();
  await expect(page).toHaveURL(/^https:\/\/www.instagram.com\/oauth\/authorize\?/);
  const state = new URL(page.url()).searchParams.get("state");
  expect(new URL(page.url()).searchParams.get("enable_fb_login")).toBe("false");
  expect(new URL(page.url()).searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments");
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const cookies = await page.context().cookies("http://127.0.0.1:3101/api/auth/instagram/callback");
  expect(cookies.find((cookie) => cookie.name === "instaloom_oauth")).toMatchObject({ httpOnly: true, sameSite: "Lax" });
  await page.goto(`/api/auth/instagram/callback?error=access_denied&state=${state}`);
  await expect(page).toHaveURL(/\/login\?error=auth_cancelled$/);
  await expect(page.getByRole("alert").filter({ hasText: "Instagram authorization was cancelled" })).toBeVisible();
});

test("signed-in visitors go straight to the inbox from either welcome page", async ({ page }) => {
  await signIn(page);
  for (const path of ["/", "/login"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole("button", { name: /Conversation with Ada Morgan/ })).toBeVisible();
  }
  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: "Continue with Instagram" })).toBeVisible();
});

test("an invalid session cookie leaves the welcome pages accessible", async ({ page }) => {
  await page.context().addCookies([{ name: "instaloom_session", value: "a".repeat(43), domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  for (const path of ["/", "/login"]) {
    await page.goto(path);
    await expect(page.getByRole("button", { name: "Continue with Instagram" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open inbox" })).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(path);
  }
});

test("loads mapped messages, searches conversations, and keeps drafts isolated", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: /Conversation with Ada Morgan/ }).click();
  await expect(page.getByText("Hi! I love the new collection.", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("inbox-desktop.png"), fullPage: true });
  const composer = page.getByRole("textbox", { name: /message|reply/i }).last();
  await composer.fill("Draft intended only for Ada");
  await page.getByRole("button", { name: /Conversation with Noah Kim/ }).click();
  await expect(composer).toHaveValue("");
  await expect(page.getByText("Hi! I love the new collection.", { exact: true })).not.toBeVisible();
  await page.getByLabel("Search conversations").fill("Ada");
  await expect(page.getByRole("button", { name: /Conversation with Noah Kim/ })).not.toBeVisible();
  await expect(page.getByRole("button", { name: /Conversation with Ada Morgan/ })).toBeVisible();
});

test("settings shows safe configuration and sign out revokes access", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByText("http://127.0.0.1:3101/api/webhook", { exact: true })).toBeVisible();
  await expect(page.getByText("fake-e2e-token-never-sent")).not.toBeVisible();
  await page.screenshot({ path: test.info().outputPath("settings-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);
  expect((await page.request.get("/api/accounts")).status()).toBe(401);
});

test("mobile inbox switches between list and thread without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.getByRole("button", { name: /Conversation with Ada Morgan/ }).click();
  await expect(page.getByText("Hi! I love the new collection.", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("inbox-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: /back.*conversation|back.*inbox/i }).click();
  await expect(page.getByRole("button", { name: /Conversation with Noah Kim/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

async function moveAutomation(page: Page, name: string, direction: "up" | "down") {
  await page.getByRole("button", { name: `Change priority for ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: `Move ${name} ${direction}`, exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Order updated");
}

async function mockMedia(page: Page) {
  await page.route("https://media.example.test/**", (route) => route.fulfill({ path: "public/images/studio-preview.webp", contentType: "image/webp" }));
  await page.route("**/api/media?**", (route) => {
    const channel = new URL(route.request().url()).searchParams.get("channel");
    return route.fulfill({ json: { media: [{ id: `e2e-${channel}`, channel, caption: channel === "post" ? "The new collection is here." : "A little behind the scenes.", mediaType: "IMAGE", imageUrl: "https://media.example.test/preview.webp", permalink: null, timestamp: new Date().toISOString() }], nextCursor: null } });
  });
}

test("Post selects real account media and persists both reply settings paused", async ({ page }) => {
  await mockMedia(page); await signIn(page);
  await page.getByRole("link", { name: "Post", exact: true }).click();
  await page.getByRole("button", { name: "Select post: The new collection is here." }).click();
  await page.getByRole("button", { name: "New automation", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Collection details");
  await page.getByLabel("Words to match", { exact: true }).fill("link, price");
  await page.getByLabel("Send as", { exact: true }).selectOption("both");
  await page.getByLabel("Public comment", { exact: true }).fill("Thanks! Check your inbox.");
  await page.getByLabel("Private message", { exact: true }).fill("Here is the collection link.");
  await expect(page.getByRole("switch", { name: "Auto-reply", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved · Paused" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Select post: The new collection is here." }).click();
  await page.getByRole("button", { name: "Edit Collection details", exact: true }).click();
  await expect(page.getByLabel("Send as", { exact: true })).toHaveValue("both");
  await expect(page.getByLabel("Public comment", { exact: true })).toHaveValue("Thanks! Check your inbox.");
  await expect(page.getByLabel("Private message", { exact: true })).toHaveValue("Here is the collection link.");
  await page.screenshot({ path: test.info().outputPath("post-automation-desktop.png"), fullPage: true });
});

test("Inbox DM settings and Story settings stay separate on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockMedia(page); await signIn(page);
  await page.getByRole("link", { name: "Automation", exact: true }).click();
  await page.getByRole("button", { name: "New automation", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("DM welcome");
  await page.getByRole("radio", { name: "Any message", exact: true }).check();
  await page.getByLabel("Your reply", { exact: true }).fill("Thanks for your message.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved · Paused" })).toBeVisible();
  await page.getByRole("link", { name: "Story", exact: true }).click();
  await page.getByRole("button", { name: "Select story: A little behind the scenes." }).click();
  await page.getByRole("button", { name: "New automation", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Story hello");
  await expect(page.getByLabel("Your reply", { exact: true })).toHaveValue("");
  await page.getByLabel("Words to match", { exact: true }).fill("hello");
  await page.getByLabel("Your reply", { exact: true }).fill("Glad you liked the story!");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved · Paused" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("heading", { name: "Story reply automations" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("story-automation-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Choose another story" }).click();
  await expect(page.getByRole("button", { name: "Select story: A little behind the scenes." })).toBeVisible();
});

test("Post and Story protect signed-out access and media errors are retryable", async ({ page }) => {
  for (const path of ["/post", "/story", "/inbox/automations"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login/);
  }
  await signIn(page);
  await page.route("**/api/media?**", (route) => route.fulfill({ status: 502, json: { error: "Couldn’t load Instagram media." } }));
  await page.getByRole("link", { name: "Post", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Couldn’t load Instagram media." })).toBeVisible();
  await mockMedia(page);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Couldn’t load Instagram media." })).not.toBeVisible();
});

test("multiple DM rules can be added, edited, reordered and paused independently", async ({ page }) => {
  await signIn(page);
  await page.goto("/inbox/automations");
  for (const [name, keyword, reply] of [["Pricing details", "price, cost", "Here are our prices."], ["Opening hours", "hours, open", "We open at 9am."]]) {
    await page.getByRole("button", { name: "New automation", exact: true }).click();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Words to match", { exact: true }).fill(keyword);
    await page.getByLabel("Your reply", { exact: true }).fill(reply);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Saved · Paused");
  }
  // Reorder around any rules already created by other tests in this isolated DB.
  while (await page.getByRole("list", { name: "Automations in priority order" }).getByRole("heading").first().textContent() !== "Opening hours") {
    await moveAutomation(page, "Opening hours", "up");
  }
  await page.getByRole("button", { name: "Enable Pricing details", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause Pricing details", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable Opening hours", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause Pricing details", exact: true }).click();
  await page.getByRole("button", { name: "Edit Pricing details", exact: true }).click();
  await expect(page.getByLabel("Your reply", { exact: true })).toHaveValue("Here are our prices.");
  await page.getByLabel("Your reply", { exact: true }).fill("Prices start at $25.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved · Paused");
  await page.reload();
  const list = page.getByRole("list", { name: "Automations in priority order" });
  await expect(list.getByRole("listitem").first()).toContainText("Opening hours");
  await page.getByRole("button", { name: "Edit Pricing details", exact: true }).click();
  await expect(page.getByLabel("Your reply", { exact: true })).toHaveValue("Prices start at $25.");
  await page.getByRole("button", { name: "All automations", exact: true }).click();
  await page.screenshot({ path: test.info().outputPath("multiple-automations-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "New automation", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("multiple-automations-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Edit Opening hours", exact: true }).click();
  await expect(page.getByLabel("Your reply", { exact: true })).toHaveValue("We open at 9am.");
});

test("one post keeps multiple comment automations with independent actions and settings", async ({ page }) => {
  await mockMedia(page);
  await page.route("**/api/media?**", (route) => route.fulfill({ json: {
    media: [["e2e-multi-post", "Autumn collection"], ["e2e-other-post", "Another collection"]].map(([id, caption]) => ({ id, caption, channel: "post", mediaType: "IMAGE", imageUrl: "https://media.example.test/preview.webp", permalink: null, timestamp: new Date().toISOString() })),
    nextCursor: null,
  } }));
  await signIn(page);
  await page.getByRole("link", { name: "Post", exact: true }).click();
  const selectedPost = page.getByRole("button", { name: "Select post: Autumn collection" });
  await selectedPost.click();
  const configurations = [
    { name: "Post prices", keywords: "price, cost", mode: "public", publicReply: "Prices start at $25.", dmReply: "" },
    { name: "Post guide", keywords: "guide, link", mode: "dm", publicReply: "", dmReply: "Here is your guide." },
    { name: "Post stock", keywords: "stock, available", mode: "both", publicReply: "Check your inbox!", dmReply: "Here is what is in stock." },
  ];
  for (const config of configurations) {
    await page.getByRole("button", { name: "New automation", exact: true }).click();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
    await page.getByLabel("Name", { exact: true }).fill(config.name);
    await page.getByLabel("Words to match", { exact: true }).fill(config.keywords);
    await page.getByLabel("Send as", { exact: true }).selectOption(config.mode);
    if (config.publicReply) await page.getByLabel("Public comment", { exact: true }).fill(config.publicReply);
    if (config.dmReply) await page.getByLabel("Private message", { exact: true }).fill(config.dmReply);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Saved · Paused");
  }
  const list = page.getByRole("list", { name: "Automations in priority order" });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(selectedPost).toContainText("3 rules · 0 on");
  await moveAutomation(page, "Post stock", "up");
  await expect(list.getByRole("listitem").nth(1)).toContainText("Post stock");
  for (const name of ["Post prices", "Post guide"]) {
    await page.getByRole("button", { name: `Enable ${name}`, exact: true }).click();
    await expect(page.getByRole("button", { name: `Pause ${name}`, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Pause Post guide", exact: true }).click();
  await expect(selectedPost).toContainText("3 rules · 1 on");
  await page.getByRole("button", { name: "Edit Post guide", exact: true }).click();
  await page.getByLabel("Private message", { exact: true }).fill("Here is the updated guide.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved · Paused");
  await page.reload();
  await selectedPost.click();
  await expect(list.getByRole("heading")).toHaveText(["Post prices", "Post stock", "Post guide"]);
  for (const config of configurations) {
    await page.getByRole("button", { name: `Edit ${config.name}`, exact: true }).click();
    await expect(page.getByLabel("Send as", { exact: true })).toHaveValue(config.mode);
    await expect(page.getByLabel("Words to match", { exact: true })).toHaveValue("");
    for (const keyword of config.keywords.split(", ")) await expect(page.getByRole("button", { name: `Remove ${keyword}`, exact: true })).toBeVisible();
    if (config.publicReply) await expect(page.getByLabel("Public comment", { exact: true })).toHaveValue(config.publicReply);
    else await expect(page.getByLabel("Public comment", { exact: true })).toHaveCount(0);
    if (config.dmReply) await expect(page.getByLabel("Private message", { exact: true })).toHaveValue(config.name === "Post guide" ? "Here is the updated guide." : config.dmReply);
    else await expect(page.getByLabel("Private message", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Auto-reply", exact: true })).toBeChecked({ checked: config.name === "Post prices" });
    await page.getByRole("button", { name: "All automations", exact: true }).click();
  }
  await page.getByRole("button", { name: "Select post: Another collection" }).click();
  await expect(page.getByText("Your first automatic reply", { exact: true })).toBeVisible();
  await expect(list).toHaveCount(0);
  await page.getByRole("button", { name: "New automation", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Private message", { exact: true })).toHaveValue("");
  await selectedPost.click();
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await page.screenshot({ path: test.info().outputPath("multiple-post-automations-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "New automation", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("multiple-post-automations-mobile.png"), fullPage: true });
});

test("compact automation rows expose icon actions and require confirmation before deletion", async ({ page }) => {
  await signIn(page);
  await page.goto("/inbox/automations");
  const name = "A long automation name to verify compact rows stay on one line on small screens";
  await page.getByRole("button", { name: "New automation", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Words to match", { exact: true }).fill("test");
  await page.getByLabel("Your reply", { exact: true }).fill("A test reply");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved · Paused");
  const list = page.getByRole("list", { name: "Automations in priority order" });
  const count = await list.getByRole("listitem").count();
  const row = list.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });
  for (const action of ["Edit", "Enable", "Delete"]) {
    await expect(row.getByRole("button", { name: `${action} ${name}`, exact: true })).toHaveText("");
  }
  await row.getByRole("button", { name: `Edit ${name}`, exact: true }).hover();
  await expect(page.getByText("Edit", { exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await row.scrollIntoViewIfNeeded();
    expect((await row.boundingBox())!.height).toBeLessThanOrEqual(64);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(row.getByRole("button", { name: `Delete ${name}`, exact: true })).toBeVisible();
  }
  await row.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete automation?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(count);
  await expect(row.getByRole("button", { name: `Delete ${name}`, exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  // A rejected deletion stays open and leaves the rule intact.
  await page.route("**/api/automations", async (route) => {
    if (route.request().method() === "DELETE") return route.fulfill({ status: 409, json: { error: "A reply is being sent. Try deleting again in a moment." } });
    return route.fallback();
  });
  await dialog.getByRole("button", { name: "Delete automation", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("A reply is being sent");
  await page.unroute("**/api/automations");
  await dialog.getByRole("button", { name: "Delete automation", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(list.getByRole("listitem")).toHaveCount(count - 1);
  await expect(page.getByRole("button", { name: "New automation", exact: true })).toBeFocused();
  await page.reload();
  await expect(page.getByRole("button", { name: `Edit ${name}`, exact: true })).toHaveCount(0);
});

test("the simplified editor explains choices and preserves reply limits and activation", async ({ page }) => {
  await signIn(page);
  await page.goto("/inbox/automations");
  await page.getByRole("button", { name: "New automation", exact: true }).click();
  await expect(page.getByRole("link", { name: "Back to conversations" })).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "New automation", exact: true })).toBeVisible();
  await expect(page.getByText("Recent replies", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "About Words to match", exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText("separated by commas");
  // Click the visible edge of the field, outside the floating help text.
  await page.getByLabel("Name", { exact: true }).click({ position: { x: 8, y: 8 } });
  await expect(page.getByRole("tooltip")).not.toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "About Reply when", exact: true })).toBeFocused();
  await expect(page.getByRole("tooltip")).toContainText("Choose what starts this reply");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).not.toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Simple pricing reply");
  await page.getByLabel("Words to match", { exact: true }).fill("price");
  await page.getByLabel("Your reply", { exact: true }).fill("🌊".repeat(300));
  await expect(page.getByLabel("Your reply", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("Your reply is too long. Shorten it before saving.");
  await page.getByLabel("Your reply", { exact: true }).fill("Hi! Prices start at $25.");
  await expect(page.getByLabel("Reply preview", { exact: true })).not.toBeVisible();
  await page.getByText("Preview reply", { exact: true }).click();
  await expect(page.getByLabel("Reply preview", { exact: true })).toBeVisible();
  await page.getByText("Preview reply", { exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Auto-reply", exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toBeChecked();
  await page.screenshot({ path: test.info().outputPath("simple-automation-editor-desktop.png"), fullPage: true, animations: "disabled" });
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/automations") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save & turn on", exact: true }).click();
  expect((await (await saved).json()).rule).toMatchObject({ name: "Simple pricing reply", enabled: true, keywords: ["price"], dmReply: "Hi! Prices start at $25." });
  await expect(page.getByRole("button", { name: "Pause Simple pricing reply", exact: true })).toBeVisible();
});

test("keyword tags support typing, paste, editing and saving unfinished text", async ({ page }) => {
  await signIn(page);
  await page.goto("/inbox/automations");
  await page.getByRole("button", { name: "New automation", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Keyword tag test");
  await page.getByLabel("Your reply", { exact: true }).fill("Thanks for asking!");
  const input = page.getByLabel("Words to match", { exact: true });
  await input.pressSequentially("hello,nima gap,");
  await expect(input).toHaveValue("");
  await expect(page.getByRole("button", { name: "Remove hello", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove nima gap", exact: true })).toBeVisible();
  await input.fill("HELLO,");
  await expect(page.getByRole("button", { name: "Remove HELLO", exact: true })).toHaveCount(0);
  await input.fill("opening hours");
  await input.press("Enter");
  await expect(page.getByRole("heading", { name: "New automation", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove opening hours", exact: true })).toBeVisible();
  await input.press("Backspace");
  await expect(input).toHaveValue("opening hours");
  await expect(page.getByRole("button", { name: "Remove opening hours", exact: true })).toHaveCount(0);
  await input.fill("business hours");
  await input.press("Enter");
  await page.getByRole("button", { name: "Remove hello", exact: true }).click();
  await expect(input).toBeFocused();
  await input.evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "price, link\nthanks");
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole("button", { name: "Remove thanks", exact: true })).toBeVisible();
  // Composing characters must not become tags or submit the form prematurely.
  await input.dispatchEvent("compositionstart");
  await input.fill("こんにちは");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(input).toHaveValue("こんにちは");
  await expect(page.getByRole("button", { name: "Remove こんにちは", exact: true })).toHaveCount(0);
  await input.dispatchEvent("compositionend", { data: "こんにちは" });
  await input.press("Enter");
  await page.getByRole("button", { name: "Remove こんにちは", exact: true }).click();
  await input.fill("last word");
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/automations") && response.request().method() === "POST");
  // Submit while the draft still has focus, without relying on a blur to commit it.
  await input.evaluate((element: HTMLInputElement) => element.form!.requestSubmit());
  expect((await (await saved).json()).rule.keywords).toEqual(["nima gap", "business hours", "price", "link", "thanks", "last word"]);
  await page.reload();
  await page.getByRole("button", { name: "Edit Keyword tag test", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove last word", exact: true })).toBeVisible();
  await expect(input).toHaveValue("");
  await page.screenshot({ path: test.info().outputPath("keyword-tags-desktop.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await input.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("keyword-tags-mobile.png"), fullPage: true, animations: "disabled" });
});

test("keyword tags keep excess pasted words editable and block invalid saves", async ({ page }) => {
  await signIn(page);
  await page.goto("/inbox/automations");
  await page.getByRole("button", { name: "New automation", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Keyword limits");
  await page.getByLabel("Your reply", { exact: true }).fill("Hello!");
  const input = page.getByLabel("Words to match", { exact: true });
  await input.fill(Array.from({ length: 21 }, (_, index) => `word${index}`).join(",") + ",");
  await expect(page.getByRole("button", { name: "Remove word20", exact: true })).toBeVisible();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toContainText("Use up to 20");
  await page.getByRole("button", { name: "Remove word20", exact: true }).click();
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await input.fill("x".repeat(81));
  await input.press("Enter");
  await expect(page.getByText("Use 80 characters or fewer for each word or phrase.", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: `Remove ${"x".repeat(81)}`, exact: true }).click();
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved · Paused");
});

test.describe("touch help", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("help tips open on tap, dismiss outside, and do not submit the form", async ({ page }) => {
    await signIn(page);
    await page.goto("/inbox/automations");
    await page.getByRole("button", { name: "New automation", exact: true }).tap();
    const help = page.getByRole("button", { name: "About Reply when", exact: true });
    await help.tap();
    await expect(page.getByRole("tooltip")).toContainText("Choose what starts this reply");
    await help.tap();
    await expect(page.getByRole("tooltip")).not.toBeVisible();
    await page.getByRole("button", { name: "About Name", exact: true }).tap();
    await expect(page.getByRole("tooltip")).toContainText("Only you see this name");
    await page.getByLabel("Name", { exact: true }).tap();
    await expect(page.getByRole("tooltip")).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "New automation", exact: true })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("Opening hours");
    await page.getByLabel("Words to match", { exact: true }).fill("hours, open");
    await page.getByLabel("Your reply", { exact: true }).fill("We’re open from 9 to 6.");
    await page.getByRole("heading", { name: "New automation", exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("simple-automation-editor-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "About Reply frequency", exact: true }).tap();
    await expect(page.getByRole("tooltip")).toContainText("at most once in 24 hours");
  });
});
