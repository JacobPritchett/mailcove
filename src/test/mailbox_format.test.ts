// Display names that contain a comma (or other RFC 5322 specials) must be
// quoted when rendered into a stored From/To string, and an address list must
// never be split on a comma that is inside a quoted name.
import { describe, it, expect } from "vitest";
import { formatMailbox, splitAddressList, parseAddressList } from "../contacts";
import { makeSqliteEnv, deliver, eml, api } from "./sqlite_env";

describe("formatMailbox", () => {
  it("leaves an ordinary name unquoted", () => {
    expect(formatMailbox("Alice Example", "alice@example.com")).toBe("Alice Example <alice@example.com>");
    expect(formatMailbox("Amazon.com", "no-reply@amazon.com")).toBe("Amazon.com <no-reply@amazon.com>");
    expect(formatMailbox("Renée O'Brien-Smith", "r@example.com")).toBe("Renée O'Brien-Smith <r@example.com>");
  });

  it("quotes a name containing a comma", () => {
    expect(formatMailbox("Doe, John", "john.doe@corp.com")).toBe('"Doe, John" <john.doe@corp.com>');
  });

  it("quotes names containing other specials, escaping backslash and quote", () => {
    expect(formatMailbox('John "Johnny" Doe', "j@x.com")).toBe('"John \\"Johnny\\" Doe" <j@x.com>');
    expect(formatMailbox("Domain\\User", "u@x.com")).toBe('"Domain\\\\User" <u@x.com>');
    expect(formatMailbox("Trusted <trusted@bank.com>", "evil@x.com")).toBe('"Trusted <trusted@bank.com>" <evil@x.com>');
    expect(formatMailbox("Sales; Support", "s@x.com")).toBe('"Sales; Support" <s@x.com>');
    expect(formatMailbox("me@home", "me@x.com")).toBe('"me@home" <me@x.com>');
  });

  it("renders a missing name as the bracketed address", () => {
    expect(formatMailbox("", "a@x.com")).toBe("<a@x.com>");
    expect(formatMailbox(undefined, "a@x.com")).toBe("<a@x.com>");
  });

  it("collapses line breaks and control characters in a name", () => {
    expect(formatMailbox("Evil\r\nBcc: x@y.com", "e@x.com")).toBe('"Evil Bcc: x@y.com" <e@x.com>');
    expect(formatMailbox("Tab\tbed", "t@x.com")).toBe("Tab bed <t@x.com>");
  });

  it("round-trips through the address-list parser", () => {
    for (const name of ["Doe, John", 'John "Johnny" Doe', "Domain\\User", "Sales; Support", "Plain Name"]) {
      const rendered = `${formatMailbox(name, "a@x.com")}, ${formatMailbox("Second, Person", "b@y.com")}`;
      expect(parseAddressList(rendered)).toEqual([
        { email: "a@x.com", name },
        { email: "b@y.com", name: "Second, Person" },
      ]);
    }
  });
});

describe("splitAddressList", () => {
  it("does not split on a comma inside a quoted display name", () => {
    expect(splitAddressList('"Doe, John" <john.doe@corp.com>, b@y.com')).toEqual([
      '"Doe, John" <john.doe@corp.com>',
      "b@y.com",
    ]);
  });
  it("splits plain lists and drops empty entries", () => {
    expect(splitAddressList("a@x.com, b@y.com ,, c@z.com;d@w.com")).toEqual(["a@x.com", "b@y.com", "c@z.com", "d@w.com"]);
    expect(splitAddressList("")).toEqual([]);
  });
});

describe("stored sender strings", () => {
  it("stores an inbound From with a comma in the name as one quoted mailbox", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, eml({ From: '"Doe, John" <john.doe@corp.com>', To: "me@example.com", Subject: "hi", "Message-ID": "<d@corp.com>" }));
    const row = t.db.prepare(`SELECT msg_from, from_addr FROM messages`).get() as { msg_from: string; from_addr: string };
    expect(row.msg_from).toBe('"Doe, John" <john.doe@corp.com>');
    expect(row.from_addr).toBe("john.doe@corp.com");
    // Downstream parsing now recovers the whole name, not just "John".
    expect(parseAddressList(row.msg_from)).toEqual([{ email: "john.doe@corp.com", name: "Doe, John" }]);
  });

  it("keeps an ordinary inbound From exactly as before", async () => {
    const t = await makeSqliteEnv();
    await deliver(t.env, eml({ From: "Alice <alice@example.com>", To: "me@example.com", Subject: "hi", "Message-ID": "<a@example.com>" }));
    const row = t.db.prepare(`SELECT msg_from FROM messages`).get() as { msg_from: string };
    expect(row.msg_from).toBe("Alice <alice@example.com>");
  });
});

describe("POST /api/send with a string `to`", () => {
  it("treats a quoted name containing a comma as ONE recipient", async () => {
    const t = await makeSqliteEnv();
    const res = await api(t.env, "POST", "/api/send", { to: '"Doe, John" <john.doe@corp.com>', text: "hi" });
    expect(res.status).toBe(200);
    expect(t.sent[0].to).toEqual(['"Doe, John" <john.doe@corp.com>']);
    const row = t.db.prepare(`SELECT msg_to FROM messages`).get() as { msg_to: string };
    expect(row.msg_to).toBe('"Doe, John" <john.doe@corp.com>');
  });

  it("still splits a plain comma-separated list", async () => {
    const t = await makeSqliteEnv();
    const res = await api(t.env, "POST", "/api/send", { to: '"Doe, John" <john.doe@corp.com>, b@y.com , c@z.com', text: "hi" });
    expect(res.status).toBe(200);
    expect(t.sent[0].to).toEqual(['"Doe, John" <john.doe@corp.com>', "b@y.com", "c@z.com"]);
  });

  it("quotes the name of a structured recipient in the stored To", async () => {
    const t = await makeSqliteEnv();
    const res = await api(t.env, "POST", "/api/send", { to: [{ name: "Doe, John", email: "john.doe@corp.com" }, "b@y.com"], text: "hi" });
    expect(res.status).toBe(200);
    const row = t.db.prepare(`SELECT msg_to FROM messages`).get() as { msg_to: string };
    expect(row.msg_to).toBe('"Doe, John" <john.doe@corp.com>, b@y.com');
    // The binding still gets the structured recipient untouched.
    expect(t.sent[0].to).toEqual([{ name: "Doe, John", email: "john.doe@corp.com" }, "b@y.com"]);
  });
});

// Every name formatMailbox can render must come back out of the parser whole.
describe("formatMailbox / parseAddressList round trip", () => {
  const AWKWARD = [
    "Plain Name",
    "Doe, John",
    "Sales: Support",
    "Team: a, b; c",
    "Acme (Billing)",
    "(parenthetical) Name",
    "Unbalanced ( paren",
    "Unbalanced ) paren",
    'John "Johnny" Doe',
    '"',
    '""',
    "Domain\\User",
    "Trailing backslash\\",
    '\\"',
    "Trusted <trusted@bank.com>",
    "<",
    ">",
    "a > b < c",
    "me@home",
    "Semi; colon",
    "[brackets]",
    'All: of, "them" (at) <once@x.y>; \\ ok',
    "O'Brien",
    "Renée 中文",
  ];

  it.each(AWKWARD)("a single mailbox named %j", (name) => {
    expect(parseAddressList(formatMailbox(name, "a@x.com"))).toEqual([{ email: "a@x.com", name }]);
  });

  it("every pair of awkward names in one list", () => {
    for (const first of AWKWARD) {
      for (const second of AWKWARD) {
        const list = `${formatMailbox(first, "a@x.com")}, ${formatMailbox(second, "b@y.org")}`;
        expect(parseAddressList(list), list).toEqual([
          { email: "a@x.com", name: first },
          { email: "b@y.org", name: second },
        ]);
      }
    }
  });

  it("still drops comments and group labels that are outside quotes", () => {
    expect(parseAddressList("a@x.com (Alice)")).toEqual([{ email: "a@x.com", name: "" }]);
    expect(parseAddressList("Team: a@x.com, Bob <b@y.org>;")).toEqual([
      { email: "a@x.com", name: "" },
      { email: "b@y.org", name: "Bob" },
    ]);
  });
});
