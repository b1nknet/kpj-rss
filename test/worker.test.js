import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.js";

function article(menuId, overrides = {}) {
  return {
    type: "ARTICLE",
    item: {
      cafeId: 31151120, menuId, articleId: menuId === 8 ? 20035 : 19877,
      subject: menuId === 8 ? "261013 / 18:15" : "한글날 공지",
      headName: menuId === 8 ? "오늘의 방송" : undefined,
      writerInfo: { nickName: "김편집" },
      writeDateTimestamp: menuId === 8 ? 1791880727667 : 1791395163177,
      openArticle: true, blindArticle: false, restrictMenu: false,
      ...overrides,
    },
  };
}

function setup(t, payloadForMenu = (menuId) => ({ result: { articleList: [article(menuId)] } })) {
  const values = new Map();
  const requests = [];
  const env = { FEED_KV: {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => { values.set(key, value); },
  } };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    const menuId = Number(new URL(url).pathname.match(/menus\/(\d+)/)[1]);
    const payload = payloadForMenu(menuId);
    return payload instanceof Response ? payload : Response.json(payload);
  });
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  return { env, values, requests };
}

test("cron merges both boards in date order with stable GUIDs", async (t) => {
  const { env, values, requests } = setup(t);
  await worker.scheduled({}, env);
  const xml = values.get("rss.xml");
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ options }) => !options.headers.Cookie && !options.headers.Authorization));
  assert.equal((xml.match(/<item>/g) ?? []).length, 2);
  assert.ok(xml.indexOf("articles/20035") < xml.indexOf("articles/19877"));
  assert.match(xml, /<title>\[방송일정\] 261013 \/ 18:15<\/title>/);
  assert.match(xml, /<category>공지사항<\/category>/);
  assert.match(xml, /<guid isPermaLink="true">https:\/\/cafe\.naver\.com\/f-e\/cafes\/31151120\/articles\/20035<\/guid>/);
  assert.match(xml, /Tue, 13 Oct 2026 08:38:47 GMT/);

  const response = await worker.fetch(new Request("https://rss.example/rss.xml"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/rss+xml; charset=utf-8");
  assert.equal(await response.text(), xml);
  assert.equal(requests.length, 2, "serving stored RSS must not request Naver again");
});

for (const [label, overrides, expected] of [
  ["daily schedule", { headName: "오늘의 일정" }, "261013 / 18:15"],
  ["weekly schedule", { headName: "주간 일정", subject: "10월 2주차 주간 일정" }, "10월 2주차 주간 일정"],
  ["literal subject prefix", { headName: undefined, subject: "[주간 일정] 10월 2주차" }, "10월 2주차"],
  ["repeated schedule prefixes", { headName: "오늘의 방송", subject: "[오늘의 일정] 261013 / 18:15" }, "261013 / 18:15"],
  ["unrelated heading", { headName: "중요", subject: "방송 안내" }, "[중요]방송 안내"],
  ["label inside subject", { headName: undefined, subject: "변경된 [주간 일정] 확인" }, "변경된 [주간 일정] 확인"],
]) {
  test(`${label}: removes only leading schedule labels`, async (t) => {
    const { env, values } = setup(t, (menuId) => ({ result: { articleList: [
      article(menuId, menuId === 8 ? overrides : {}),
    ] } }));
    await worker.scheduled({}, env);
    const xml = values.get("rss.xml");
    assert.ok(xml.includes(`<title>[방송일정] ${expected}</title>`));
    assert.match(xml, /<title>\[공지사항\] 한글날 공지<\/title>/);
    assert.match(xml, /Tue, 13 Oct 2026 08:38:47 GMT/);
  });
}

test("XML escaping, duplicate IDs and non-public posts", async (t) => {
  const { env, values } = setup(t, (menuId) => ({ result: { articleList: [
    article(menuId),
    article(menuId, { subject: 'A & <B> "C" \'D\'\u0001', writerInfo: { nickName: "김&편집" } }),
    article(menuId, { articleId: 999, subject: "비공개 제목", openArticle: false }),
    article(menuId, { articleId: 998, subject: "블라인드 제목", blindArticle: true }),
    article(menuId, { articleId: 997, subject: "제한 게시판 제목", restrictMenu: true }),
    { type: "AD" },
  ] } }));
  await worker.scheduled({}, env);
  const xml = values.get("rss.xml");
  assert.equal((xml.match(/<item>/g) ?? []).length, 2);
  assert.doesNotMatch(xml, /비공개 제목|블라인드 제목|제한 게시판 제목/);
  assert.match(xml, /A &amp; &lt;B&gt; &quot;C&quot; &apos;D&apos;/);
  assert.match(xml, /김&amp;편집/);
  assert.doesNotMatch(xml, /\u0001/);
});

for (const [label, badPayload] of [
  ["upstream HTTP failure", new Response("blocked", { status: 403 })],
  ["changed JSON shape", { result: {} }],
  ["empty public list", { result: { articleList: [] } }],
  ["invalid timestamp", { result: { articleList: [article(7, { writeDateTimestamp: "invalid" })] } }],
  ["wrong board", { result: { articleList: [article(8)] } }],
]) {
  test(`${label} preserves the last successful feed`, async (t) => {
    const { env, values } = setup(t, (menuId) => menuId === 7
      ? badPayload : { result: { articleList: [article(menuId)] } });
    values.set("rss.xml", "previous RSS");
    await assert.rejects(worker.scheduled({}, env));
    assert.equal(values.get("rss.xml"), "previous RSS");
    const response = await worker.fetch(new Request("https://rss.example/rss.xml"), env);
    assert.equal(await response.text(), "previous RSS");
  });
}

test("first RSS request initializes storage and subsequent HEAD has no body", async (t) => {
  const { env, values, requests } = setup(t);
  const response = await worker.fetch(new Request("https://rss.example/"), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), values.get("rss.xml"));
  const head = await worker.fetch(new Request("https://rss.example/rss.xml", { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(requests.length, 2);
});

test("failed initialization returns a retryable error and writes nothing", async (t) => {
  const { env, values } = setup(t, () => new Response("Unavailable", { status: 503 }));
  const response = await worker.fetch(new Request("https://rss.example/rss.xml"), env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(values.size, 0);
});

test("unknown paths and write methods do not contact Naver", async (t) => {
  const { env, requests } = setup(t);
  assert.equal((await worker.fetch(new Request("https://rss.example/other"), env)).status, 404);
  const response = await worker.fetch(new Request("https://rss.example/rss.xml", { method: "POST" }), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "GET, HEAD");
  assert.equal(requests.length, 0);
});
