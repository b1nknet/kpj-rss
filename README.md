# 네이버 카페 RSS · Cloudflare Workers

편찻집 카페(`31151120`)의 **방송일정(8번)**과 **공지사항(7번)**을 합쳐 `/rss.xml`로 제공합니다. `/`에서도 같은 RSS가 열립니다.

- Cloudflare Cron Trigger가 15분마다 각 게시판의 최신 15개 글을 수집합니다.
- 제목, 작성자, 작성시각, 게시판 구분, 원문 링크를 담고 최신 글부터 정렬합니다. 제목 앞의 일정 말머리(`오늘의 일정`, `오늘의 방송`, `주간 일정`)는 제거하고 게시판 이름은 유지합니다.
- 글 번호를 포함한 원문 링크를 GUID로 사용해 중복을 제거합니다.
- 공개 글만 수집하며 네이버 로그인·쿠키·API 키가 필요하지 않습니다.
- 두 게시판 수집이 모두 성공해야 Workers KV의 RSS를 교체합니다. 수집 실패나 잘못된 응답, 빈 목록이 오면 기존 피드를 유지합니다.
- 처음 요청할 때 저장된 RSS가 없으면 즉시 수집합니다. 초기 수집도 실패하면 HTTP 503을 반환합니다.

## 설치 및 배포

Node.js 22 이상이 필요합니다.

```sh
npm install
npm test
npx wrangler login
npm run deploy
```

배포하면 나오는 Workers 주소 뒤에 `/rss.xml`을 붙여 RSS 리더에 등록하세요.

```text
https://ncafe-rss.<계정의-workers-subdomain>.workers.dev/rss.xml
```

`wrangler.jsonc`에는 `FEED_KV` 바인딩만 지정했습니다. Wrangler가 배포 과정에서 KV 저장소를 생성·연결하고 ID를 설정 파일에 기록합니다. 생성된 저장소는 이후 배포에서도 재사용합니다. [Cloudflare 자동 리소스 생성 안내](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)

갱신 간격은 `wrangler.jsonc`의 `triggers.crons`에서 변경합니다. 설정은 현재 15분 간격이며 변경 후 다시 배포해야 합니다. Cron 설정은 전파에 최대 15분이 걸릴 수 있습니다. [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

## GitHub Actions 자동 배포

[isonair의 배포 워크플로](https://github.com/b1nknet/isonair/blob/master/.github/workflows/deploy.yml)를 참고한 `.github/workflows/deploy.yml`을 포함합니다. `master` 브랜치에 push하면 Node.js 22에서 의존성 설치 → 테스트 → Worker 배포 사전 검사 → Cloudflare 배포 순서로 실행합니다. 테스트나 검사가 실패하면 배포하지 않으며, 여러 배포가 동시에 실행되지 않도록 설정했습니다.

GitHub 저장소의 **Settings → Secrets and variables → Actions → New repository secret**에서 다음 두 항목을 등록하세요.

| 이름 | 값 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 배포할 Cloudflare 계정의 API 토큰 |
| `CLOUDFLARE_ACCOUNT_ID` | 배포할 Cloudflare 계정 ID |

Cloudflare의 **Edit Cloudflare Workers** 토큰 템플릿을 사용하고 배포할 계정으로 범위를 지정하세요. 이 프로젝트는 KV 저장소도 생성·연결하므로 토큰에 **Workers KV Storage: Edit** 권한이 포함되어야 합니다. 토큰 값은 GitHub Secrets에만 보관합니다. [Cloudflare GitHub Actions 설정 안내](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

Secrets를 설정하고 프로젝트를 `master`에 push한 뒤 GitHub의 **Actions → Deploy Worker**에서 결과와 RSS를 제공할 Worker 주소를 확인하세요. 다른 브랜치를 배포하려면 워크플로의 `on.push.branches`를 변경하세요.

GitHub Actions는 `package-lock.json`에 고정된 Wrangler를 사용합니다. 첫 배포에서 필요한 `FEED_KV` 저장소를 생성하고 이후에는 Worker에 연결된 저장소를 재사용합니다. 실행 중 변경된 KV ID를 저장소에 자동 커밋하지는 않습니다.

## 로컬 확인

```sh
npm run dev
```

다른 터미널에서 RSS 응답과 예약 실행을 확인할 수 있습니다.

```sh
curl --fail http://localhost:8787/rss.xml
curl --fail 'http://localhost:8787/cdn-cgi/local/scheduled?format=json'
```

로컬 KV는 `.wrangler/`에 보관되며 실제 Cloudflare 저장소와 분리됩니다. 로컬 개발 서버는 Cron을 자동 실행하지 않으므로 위 요청으로 예약 핸들러를 호출합니다. [Cloudflare 예약 핸들러 테스트](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)

```sh
npm test
npm run check
```

`npm test`는 두 게시판 병합, XML 이스케이프, 중복 제거, 비공개 글 제외, 수집 실패 시 기존 피드 보존, HTTP 응답을 검증합니다. `npm run check`는 실제 배포 없이 Worker 번들과 설정을 검사합니다.

## 운영상 한계

- 네이버 웹페이지가 사용하는 내부 목록 API입니다. 네이버의 응답 형식 변경이나 Cloudflare IP 차단 시 수집이 중단될 수 있습니다. 로컬 성공만으로 Cloudflare 서버에서의 접근 성공을 보장하지는 않습니다.
- 최신 15개씩을 제공하는 목록 피드입니다. 전체 과거 글을 보관하지 않으며, 갱신 사이에 한 게시판에 15개 이상 새 글이 올라오면 일부를 놓칠 수 있습니다.
- 본문·댓글·첨부파일은 수집하지 않습니다. 글 수정 시 GUID는 유지되므로 수정 알림 여부는 RSS 리더에 따라 달라집니다.
- 수집 실패 시 마지막 성공 피드를 계속 제공합니다. 갱신 시각은 RSS의 `lastBuildDate`, 실패 내역은 Cloudflare Worker의 로그와 Cron 실행 기록에서 확인할 수 있습니다.
- KV의 지역 간 전파와 응답의 60초 캐시 때문에 새 피드 반영에 추가 지연이 생길 수 있습니다. [Cloudflare KV 일관성 안내](https://developers.cloudflare.com/kv/reference/faq/)
