const CAFE_ID = 31151120;
const BOARDS = [{ id: 8, name: "방송일정" }, { id: 7, name: "공지사항" }];
const FEED_KEY = "rss.xml";

function escapeXml(value) {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
    })[character]);
}

async function loadBoard(board) {
  // shortcut: 최신 15개만 읽음, 갱신 간격 사이에 15개 이상 올라오면 페이지 순회 추가.
  const url = `https://apis.naver.com/cafe-web/cafe-boardlist-api/v1/cafes/${CAFE_ID}/menus/${board.id}/articles?page=1&pageSize=15&sortBy=TIME&viewType=L`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": `https://cafe.naver.com/f-e/cafes/${CAFE_ID}/menus/${board.id}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${board.name}: HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.result?.articleList)) {
    throw new Error(`${board.name}: 게시글 목록 형식이 변경되었습니다.`);
  }
  const articles = payload.result.articleList
    .filter((row) => row?.type === "ARTICLE")
    .map((row) => row.item)
    .filter((article) => article?.openArticle === true
      && article.blindArticle === false && article.restrictMenu === false);
  if (articles.length === 0) throw new Error(`${board.name}: 공개 게시글 목록이 비어 있습니다.`);

  return articles.map((article) => {
    if (article.cafeId !== CAFE_ID || article.menuId !== board.id
      || !Number.isSafeInteger(article.articleId) || article.articleId <= 0
      || typeof article.subject !== "string" || !article.subject.trim()
      || typeof article.writerInfo?.nickName !== "string"
      || (article.headName != null && typeof article.headName !== "string")
      || !Number.isSafeInteger(article.writeDateTimestamp)
      || Number.isNaN(new Date(article.writeDateTimestamp).getTime())) {
      throw new Error(`${board.name}: 게시글 데이터가 올바르지 않습니다.`);
    }
    return {
      title: `[${board.name}] ${article.headName ? `[${article.headName}]` : ""}${article.subject.trim()}`,
      link: `https://cafe.naver.com/f-e/cafes/${CAFE_ID}/articles/${article.articleId}`,
      category: board.name,
      author: article.writerInfo.nickName,
      timestamp: article.writeDateTimestamp,
    };
  });
}

async function refreshFeed(env) {
  const boards = await Promise.all(BOARDS.map(loadBoard));
  const articles = [...new Map(boards.flat().map((article) => [article.link, article])).values()]
    .sort((a, b) => b.timestamp - a.timestamp);
  const items = articles.map((article) => `    <item>
      <title>${escapeXml(article.title)}</title>
      <link>${article.link}</link>
      <guid isPermaLink="true">${article.link}</guid>
      <category>${escapeXml(article.category)}</category>
      <dc:creator>${escapeXml(article.author)}</dc:creator>
      <pubDate>${new Date(article.timestamp).toUTCString()}</pubDate>
    </item>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>편찻집 — 방송일정·공지사항</title>
    <link>https://cafe.naver.com/kpjchzzk</link>
    <description>편찻집의 방송일정과 공지사항 최신 글 목록</description>
    <language>ko-KR</language>
    <ttl>15</ttl>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>\n`;
  // 두 게시판 수집이 모두 성공한 뒤에만 기존 피드를 교체한다.
  await env.FEED_KV.put(FEED_KEY, xml);
  console.log(`RSS 갱신 완료: ${articles.length}개`);
  return xml;
}

export default {
  async scheduled(_controller, env) {
    await refreshFeed(env);
  },

  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path !== "/" && path !== "/rss.xml") return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    try {
      const xml = await env.FEED_KV.get(FEED_KEY) ?? await refreshFeed(env);
      return new Response(request.method === "HEAD" ? null : xml, {
        headers: {
          "Content-Type": "application/rss+xml; charset=utf-8",
          "Cache-Control": "public, max-age=60",
        },
      });
    } catch (error) {
      console.error("RSS 제공 실패", error);
      return new Response("RSS를 준비하지 못했습니다. 잠시 후 다시 시도해주세요.", {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "60" },
      });
    }
  },
};
