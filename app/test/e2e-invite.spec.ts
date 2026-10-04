// The calendar invite card with real layout: it fits a phone, its download
// is a thumb-sized link, and it is text all the way down.
import { test, expect } from "@playwright/test";
import { makeThreads, stubMailbox, PHONE } from "./e2eMailbox";

const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:1@example.org",
  "DTSTART;TZID=America/Phoenix:20261114T100000", "DTEND;TZID=America/Phoenix:20261114T110000",
  "SUMMARY:Lease signing with a very long title that has to wrap on a narrow screen <b>not bold</b>",
  "LOCATION:Harborview Leasing Office\\, 400 E Van Buren St\\, Suite 1200\\, Phoenix\\, AZ 85004",
  'ORGANIZER;CN="Rosa Alvarez":mailto:leasing@harborview.example',
  "END:VEVENT", "END:VCALENDAR",
].join("\r\n");

function threads() {
  const t = makeThreads(2);
  t[0].message = {
    has_attachments: 1,
    body: {
      text: "", html: "<p>Invite attached.</p>",
      attachments: [{ name: "invite.ics", mimeType: "text/calendar", size: ICS.length, partId: "p1" }],
    },
  };
  return t;
}

for (const [name, use, zone] of [
  ["desktop", { viewport: { width: 1280, height: 800 }, timezoneId: "America/New_York", locale: "en-US" }, "12:00 to 1:00 PM"],
  ["phone", { ...PHONE, timezoneId: "Europe/Berlin", locale: "en-US" }, "6:00 to 7:00 PM"],
] as const) {
  test.describe(name, () => {
    test.use(use);

    test("shows the event in the reader's own time zone, above the body, and fits", async ({ page }) => {
      const mail = await stubMailbox(page, threads());
      mail.files.set("/api/attachments/m-t2/invite.ics", ICS);
      await page.goto("/", { waitUntil: "networkidle" });
      await page.getByText("Thread 2", { exact: true }).click();

      const card = page.getByRole("region", { name: "Calendar invite" });
      await expect(card).toBeVisible();
      // 10:00 in Phoenix, said in the zone this browser is in.
      await expect(card).toContainText(`Sat, Nov 14, 2026, ${zone}`);
      await expect(card).toContainText("Harborview Leasing Office, 400 E Van Buren St, Suite 1200, Phoenix, AZ 85004");
      await expect(card).toContainText("Rosa Alvarez, leasing@harborview.example");
      // The markup in the title is text.
      await expect(card).toContainText("<b>not bold</b>");
      expect(await card.locator("b").count()).toBe(0);

      const cardBox = (await card.boundingBox())!;
      const frameBox = (await page.locator("iframe").boundingBox())!;
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(frameBox.y + 1);
      const link = card.getByRole("link", { name: "Download .ics" });
      await expect(link).toHaveAttribute("download", "invite.ics");
      const linkBox = (await link.boundingBox())!;
      if (name === "phone") expect(linkBox.height).toBeGreaterThanOrEqual(44);
      // Nothing clipped or pushed sideways by the long title and address.
      expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

      // Keyboard: the download is reachable and named.
      await link.focus();
      await expect(link).toBeFocused();
    });
  });
}
