# shared-pro

Chia sẻ app đang chạy ở `localhost` qua một link Cloudflare. Người xem **click thẳng vào phần tử trên trang để góp ý**, rồi **AI Agent (Claude Code, Cursor…) đọc góp ý qua MCP và tự sửa code**.

Không cần dịch vụ thứ 3, không phải sửa code app, dữ liệu nằm trên máy dev.

```
Người review (browser)
   │  https://xxx.trycloudflare.com/qtw-project-manager?sp=TOKEN
   ▼
cloudflared ──► shared-pro proxy :3100 ──────────────► app dev :3000
                 │  ├─ chèn widget góp ý vào mọi trang HTML
                 │  ├─ WebSocket/HMR đi xuyên qua
                 │  └─ /__sp/api  (lưu góp ý)
                 ▼
          .shared-pro/comments.db  (SQLite)
                 ▲
AI Agent ◄─stdio─ shared-pro mcp
```

## Tính năng

- **Một lệnh**: chạy proxy, tự mở Cloudflare Tunnel (Quick Tunnel, hoặc named tunnel với URL cố định), in ra share link đầy đủ.
- **Góp ý trực quan**: click chọn một phần tử, hoặc **kéo chuột khoanh một vùng**. Pin đánh số đặt đúng chỗ, có thread trả lời. Chỉ AI Agent được đánh dấu xong, người review có thể mở lại.
- **Tự chụp màn hình**: mỗi góp ý kèm ảnh khung nhìn của người review, có khung đỏ quanh phần tử/vùng đã chọn. AI Agent nhận ảnh qua MCP.
- **Xem mọi trang**: chế độ *Tất cả trang* liệt kê góp ý của cả app, bấm vào là chuyển tới đúng trang và đúng góp ý.
- **Pin bám đúng chỗ**: khi DOM đổi (kể cả do chính AI sửa), pin tìm lại phần tử theo text thay vì nhảy sang phần tử bên cạnh.
- **Realtime**: góp ý của người khác và reply của AI hiện ra sau khoảng 0,6 giây (đo thật qua tunnel), không mất nội dung đang gõ.
- **Cho AI Agent**: 4 tool MCP để liệt kê, đọc chi tiết (selector, text, HTML của phần tử, vùng, ảnh chụp), trả lời và resolve. Reply của agent có badge 🤖.
- **Không đụng app**: widget nằm trong Shadow DOM, HMR của Vite/Next vẫn chạy qua tunnel, streaming SSR không bị buffer ở proxy.
- **Có kiểm soát truy cập**: share token, chống XSS, chống CSRF, chặn reviewer giả danh agent, bọc nội dung góp ý để giảm rủi ro prompt injection.

Đã kiểm tra với Next.js 16 (có `basePath`) và Vite 8.

## Yêu cầu

- Node.js **≥ 22.18** (dùng `node:sqlite` có sẵn; khi phát triển chạy thẳng file TypeScript)
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/): `brew install cloudflared`

## Cài đặt

```bash
git clone https://github.com/quannadev/shared-pro.git
cd shared-pro
npm install     # tự build ra dist/ (script prepare)
npm link        # tạo lệnh `shared-pro` toàn cục
```

- **Chưa publish lên npm** (tên `shared-pro` vẫn còn trống). Gói đã sẵn sàng: `npm pack` ra 9 file (28,8kB), cài vào project khác và chạy được từ `node_modules`.
- Không muốn link thì chạy thẳng `node /đường/dẫn/shared-pro/dist/cli.js …`.
- `npx github:quannadev/shared-pro` cần npm chạy script `prepare` của gói cài từ git. npm bản mới có thể chặn script này nếu chưa được duyệt, nên chưa đảm bảo chạy được.

## Bắt đầu nhanh

1. Chạy app như bình thường, ví dụ Next ở cổng 3000 với `basePath: '/qtw-project-manager'`.
2. Mở terminal ngay trong thư mục project của app:

   ```bash
   shared-pro --target 3000 --path /qtw-project-manager
   ```

   ```
   proxy:      http://localhost:3100 → http://localhost:3000
   comments:   /path/to/your-app/.shared-pro/comments.db
   local link: http://localhost:3100/qtw-project-manager?sp=…
   tunnel:     starting cloudflared…
   share link: https://xxx.trycloudflare.com/qtw-project-manager?sp=…
   ```

3. Gửi **share link** cho người cần góp ý.
4. Kết nối AI Agent (xem [Kết nối AI Agent](#kết-nối-ai-agent-mcp)) rồi bảo nó: *"Sửa các góp ý đang mở"*.

`Ctrl+C` tắt cả proxy lẫn tunnel.

## Tùy chọn CLI

```
shared-pro [start] [tùy chọn]     chạy proxy + tunnel (mặc định)
shared-pro mcp [--dir .]          MCP server qua stdio cho AI Agent
```

| Tùy chọn | Mặc định | Ý nghĩa |
|---|---|---|
| `--target` | `3000` | App cần chia sẻ: số cổng (`3000`) hoặc URL đầy đủ (`http://127.0.0.1:5173`) |
| `--port` | `3100` | Cổng của proxy shared-pro |
| `--path` | `/` | Trang mà share link mở ra, ví dụ `basePath` của Next |
| `--dir` | thư mục hiện tại | Nơi tạo `.shared-pro/` (DB góp ý + token). `start` và `mcp` phải dùng **cùng** `--dir` |
| `--public` | tắt | Không dùng token, ai có URL cũng xem và viết góp ý được |
| `--no-tunnel` | | Chỉ chạy proxy ở local, không mở cloudflared |
| `--cloudflared` | `cloudflared` | Đường dẫn tới binary cloudflared nếu không có trong `PATH` |
| `--tunnel-name` | | Dùng named tunnel của bạn (URL cố định) thay cho Quick Tunnel. Đi kèm `--hostname` |
| `--hostname` | | Tên miền đã trỏ vào named tunnel đó, ví dụ `review.example.com` |

### URL cố định với named tunnel

Quick Tunnel đổi URL mỗi lần chạy. Muốn link dùng được lâu dài, tạo named tunnel trên tên miền của bạn (cần tài khoản Cloudflare, làm một lần):

```bash
cloudflared tunnel login
```

```bash
cloudflared tunnel create qtw-review
```

```bash
cloudflared tunnel route dns qtw-review review.example.com
```

Sau đó mỗi lần chạy:

```bash
shared-pro --target 3000 --path /qtw-project-manager --tunnel-name qtw-review --hostname review.example.com
```

Share link luôn là `https://review.example.com/qtw-project-manager?sp=…`. Named tunnel cũng không bị giới hạn như Quick Tunnel (không hỗ trợ SSE, tối đa 200 request đồng thời, có thể báo `429` khi tạo quá nhiều).

> Phần này mới được kiểm tra với cloudflared giả lập và với cloudflared thật tới bước xác thực, chưa chạy trọn vẹn trên một tài khoản Cloudflare thật.

## Hướng dẫn cho người review

1. Mở share link **ngay trong trình duyệt sẽ dùng để góp ý** (Safari, Chrome…). Trình duyệt nhận cookie từ token trong link. `?sp=…` vẫn nằm trên thanh địa chỉ, nên copy URL hoặc bấm "Mở trong Safari" từ Zalo/Messenger vẫn mang theo mã.
2. Bấm nút **💬** ở góc phải dưới để mở bảng góp ý.
3. Bấm **+ Thêm góp ý** (hoặc phím **C** khi bảng đang mở). Có hai cách chọn:
   - **Click** vào một phần tử. Phần tử dưới chuột được viền xanh.
   - **Kéo chuột** để khoanh một vùng, dùng khi góp ý về khoảng cách hay một cụm phần tử. Chỉ hỗ trợ chuột; trên điện thoại thì chạm để chọn phần tử.

   Trong chế độ này click không kích hoạt app: link không chuyển trang, nút không chạy. Ảnh chụp màn hình được chụp tự động.
4. Nhập tên (chỉ hỏi lần đầu) và nội dung, gửi bằng **⌘/Ctrl + Enter** hoặc nút **Gửi**.
5. Mỗi góp ý có một pin số trên trang. Click pin hoặc thẻ trong bảng để cuộn tới đúng phần tử (góp ý dạng vùng thì vùng được viền lại). Thẻ có ảnh thu nhỏ, bấm để xem ảnh lớn.
   - Chuyển sang **Tất cả trang** để xem góp ý của mọi trang. Bấm một thẻ của trang khác để chuyển tới trang đó, bảng góp ý tự mở đúng thẻ.
6. Mỗi thread có ô **Trả lời**. Tab **Đang mở / Đã xong** để lọc.
   - **Khi AI xử lý xong góp ý của bạn** (ở bất kỳ trang nào):
     - Đang mở trang: hiện thông báo *"🤖 Góp ý của bạn đã được AI xử lý"* kèm ghi chú của AI; bấm vào là mở đúng thread để kiểm tra (chưa đạt thì bấm **Mở lại**).
     - Tab đang ở nền: tiêu đề tab nhấp nháy `(1) ✓ …` cho tới khi bạn quay lại.
     - Lúc đó không mở trang: lần sau vào, nút 💬 có chấm xanh và tab ghi *Đã xong (3) · 2 mới*. Các thread chưa xem có nhãn **Mới**, mở tab Đã xong là coi như đã xem (lưu trong `localStorage` của trình duyệt).
   - Góp ý và trả lời **do chính bạn viết trên trình duyệt này** có nút **Xóa** (hỏi xác nhận trước). Xóa một góp ý thì xóa luôn các trả lời và ảnh chụp đi kèm.
7. **Chỉ AI Agent được đánh dấu xong** (sau khi đã sửa code), và API cũng chặn người dùng làm việc này. Nếu thấy chưa đạt, bấm **Mở lại** trên thread trong tab *Đã xong*.

**Esc** thoát chế độ chọn hoặc đóng ô nhập. Góp ý được lưu theo đường dẫn trang (`/path?query`), nên chuyển trang trong SPA sẽ thấy đúng góp ý của trang đó.

## Kết nối AI Agent (MCP)

### Claude Code

Chạy trong thư mục project của app:

```bash
claude mcp add shared-pro -- shared-pro mcp --dir "$PWD"
```

Muốn cả team dùng chung thì thêm `-s project` để lưu vào `.mcp.json`. Nếu không dùng `npm link`:

```bash
claude mcp add shared-pro -- node /đường/dẫn/shared-pro/dist/cli.js mcp --dir "$PWD"
```

### Cursor, Claude Desktop và client MCP khác

```json
{
  "mcpServers": {
    "shared-pro": {
      "command": "node",
      "args": ["/đường/dẫn/shared-pro/dist/cli.js", "mcp", "--dir", "/đường/dẫn/project-của-app"]
    }
  }
}
```

### Các tool

| Tool | Tham số | Dùng để |
|---|---|---|
| `list_comments` | `status` (`open` mặc định / `resolved`), `url?` | Liệt kê thread: id, trang, phần tử, nội dung |
| `get_comment` | `id` | Chi tiết: selector, text, HTML của phần tử, vị trí click hoặc vùng đã khoanh, viewport, các reply, và **ảnh chụp màn hình** (gửi dạng ảnh để agent nhìn) |
| `reply_comment` | `id`, `body` | Trả lời hoặc hỏi lại người review (hiển thị với 🤖) |
| `resolve_comment` | `id`, `note?` | Đánh dấu xong. Đây là cách **duy nhất** để resolve: API từ trình duyệt trả `403`. `note` được đăng thành reply để người review biết đã đổi gì |

Vòng làm việc thường gặp: `list_comments` → `get_comment` → tìm phần tử trong code (theo text hoặc HTML) → sửa → HMR tự reload trang của người review → `resolve_comment` với ghi chú ngắn. Người review thấy ✓ và ghi chú gần như ngay lập tức.

Proxy và MCP là hai process riêng nhưng dùng chung file SQLite (chế độ WAL), nên agent đọc được góp ý kể cả khi proxy đã tắt.

### Tự động báo AI khi có góp ý mới

MCP thông thường không tự đánh thức được AI: agent chỉ thấy góp ý khi nó gọi `list_comments`. Có hai cách để AI tự xử lý góp ý mới:

**Cách 1: Channels, gần như tức thì (Claude Code, bản thử nghiệm).** MCP server của shared-pro khai báo `claude/channel`. Khi có góp ý hoặc trả lời mới từ người review, nó đẩy một sự kiện vào phiên Claude Code đang mở, và Claude bắt tay xử lý ngay. Chạy trong thư mục project của app:

```bash
claude mcp add shared-pro -- shared-pro mcp --dir "$PWD"
```

```bash
claude --dangerously-load-development-channels server:shared-pro
```

Màn hình cảnh báo hiện ra thì chọn *I am using this for local development*. Từ đó mỗi góp ý mới hiện trong phiên dưới dạng `← shared-pro: New review comment on /trang…`, rồi Claude gọi `get_comment`, sửa code và `resolve_comment`.

- Sự kiện **chỉ chứa id thread, loại (comment/reply) và trang**, không chứa nội dung góp ý. Nội dung chỉ đọc được qua `get_comment`, nơi nó đã được bọc `<untrusted_comment>`, nên chặn được prompt injection qua channel. URL được mã hóa để không thoát được khỏi thuộc tính của thẻ.
- Reply của AI không phát sự kiện, nên agent không tự đánh thức chính nó. Góp ý có từ trước khi phiên bắt đầu cũng không được báo lại.
- Giới hạn của bản thử nghiệm:
  - Phải dùng `--dangerously-load-development-channels`, vì kênh tự viết chưa nằm trong danh sách Anthropic duyệt.
  - Chỉ chạy ở phiên tương tác, không chạy với `-p`.
  - Cần đăng nhập claude.ai hoặc API key của Console. Gói Team/Enterprise thì admin phải bật `channelsEnabled`.
  - Mỗi khi AI sửa file, nó vẫn hỏi bạn duyệt như bình thường.
  - Xem [tài liệu Channels](https://code.claude.com/docs/en/channels).
- Đã kiểm tra bằng client MCP chính thức, qua cả kết nối nội bộ và stdio với process `shared-pro mcp` thật. Chưa chạy trong một phiên Claude Code thật.

**Cách 2: `/loop`, không cần cài gì thêm.** Trong phiên Claude Code ở thư mục project của app:

```
/loop 3m Kiểm tra shared-pro: nếu có góp ý đang mở thì list_comments → get_comment → sửa code → resolve_comment kèm ghi chú. Không có thì thôi.
```

Góp ý mới phải chờ tối đa bằng khoảng lặp, và mỗi lần lặp đều tốn một lượt chạy model.

> Mình không khuyên tự chạy `claude -p` mỗi khi có góp ý: người ngoài có share link sẽ khiến AI sửa code mà không ai duyệt.

### Cập nhật realtime hoạt động thế nào

- Widget dùng **long-polling**: gửi `GET /__sp/api/changes?since=<version>` và proxy giữ request đó cho đến khi có thay đổi (tối đa 25 giây), rồi widget tải lại ngay.
- Proxy biết có thay đổi theo hai đường: ghi từ chính nó (API), và ghi từ process MCP, phát hiện qua `PRAGMA data_version` của SQLite mỗi 0,3 giây.
- **Không dùng SSE** vì [Cloudflare Quick Tunnel không hỗ trợ SSE](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/): đã đo, stream bị giữ lại hoàn toàn. Long-poll gồm các response ngắn, đi qua tunnel bình thường.
- Polling dự phòng: mỗi 5 giây nếu long-poll lỗi, mỗi 30 giây khi long-poll đang chạy tốt.

## Dữ liệu

Mọi thứ nằm trong `<dir>/.shared-pro/`. Thư mục này tự tạo `.gitignore` nên không bị commit nhầm.

| File | Nội dung |
|---|---|
| `comments.db` (+ `-wal`, `-shm`) | Toàn bộ góp ý |
| `token` | Share token (quyền `0600`). Được giữ lại sau khi restart nên link đã gửi vẫn dùng được |
| `shots/<id>.jpg` | Ảnh chụp màn hình của từng góp ý |

- **Đổi token** (thu hồi mọi link đã gửi): xóa `.shared-pro/token` rồi chạy lại.
- **Xóa sạch góp ý**: xóa `.shared-pro/comments.db*` và `.shared-pro/shots/`.
- **Nâng cấp shared-pro**: DB cũ tự được cập nhật cấu trúc khi chạy bản mới, không mất góp ý. Nhớ khởi động lại cả proxy lẫn MCP: widget luôn lấy bản mới nhất, nhưng server đang chạy vẫn là code cũ.

## Bảo mật

Share link là **URL công khai trỏ vào máy dev của bạn**. Chỉ gửi cho người tin cậy.

- **Share token**: không có cookie token thì API góp ý trả `401`. App vẫn xem được qua link (giống như khi chạy `cloudflared` thường), chỉ không xem hay viết được góp ý. Cookie đặt `HttpOnly; Secure; SameSite=Lax`, so sánh token bằng `timingSafeEqual`. Token **vẫn hiện trên thanh địa chỉ** (để link copy lại vẫn dùng được), nên đừng gửi ảnh chụp có thanh địa chỉ cho người ngoài. Lộ token thì xóa `.shared-pro/token` để đổi mã.
- **Prompt injection**: góp ý là dữ liệu do người ngoài nhập và AI sẽ đọc. MCP bọc mọi nội dung đến từ reviewer trong `<untrusted_comment>`, vô hiệu hóa mọi cách thoát khỏi thẻ này, và nhắc agent chỉ coi đây là mô tả thay đổi UI, không phải lệnh. Hãy **giữ chế độ xác nhận tool của agent**, và đừng dùng `--public` khi đã nối agent.
- **Giả danh agent**: badge 🤖 dựa vào cột `by_agent`, chỉ MCP ghi được. API bỏ qua field này.
- **Xóa**: không có tài khoản, nên mỗi trình duyệt tự sinh một khóa ngẫu nhiên (lưu trong `localStorage`, gửi qua header `x-sp-client`). Server chỉ lưu **hash SHA-256** của khóa cạnh mỗi góp ý; API trả về `mine: true/false`, không bao giờ trả hash.
  - Chỉ đúng trình duyệt đã viết mới xóa được (người khác nhận `403`), và chỉ tác giả của thread mới gắn được ảnh chụp cho thread đó.
  - Góp ý cũ (trước khi có tính năng này) và reply của AI không có chủ nên không xóa được từ widget.
  - Xóa dữ liệu trình duyệt (`localStorage`) đồng nghĩa mất quyền xóa các góp ý cũ của mình.
- **XSS**: widget hiển thị nội dung góp ý dạng text (`textContent`), không bao giờ dạng HTML.
- **CSRF**: API bắt buộc `content-type: application/json` (sai thì trả `415`) và cookie `SameSite=Lax`. Body lớn hơn 64KB trả `413`.
- **Bảo vệ dev server**: proxy đổi `Origin` sang địa chỉ app chỉ khi `Origin` trùng `Host`. Nhờ vậy HMR của Next chạy qua tunnel, còn trang lạ gọi `localhost:3100` vẫn bị Next chặn như cũ.
- **Ảnh chụp**: chụp đúng những gì người review đang thấy, nên có thể chứa dữ liệu nhạy cảm hiển thị trên màn hình. Ảnh lưu trên máy bạn và được gửi cho AI Agent (tức là tới nhà cung cấp model) khi agent đọc góp ý. Upload chỉ nhận JPEG/PNG, kiểm tra bằng magic bytes (không bao giờ SVG), tối đa 3MB, mỗi thread một lần, không ghi đè được.
- MCP chỉ chạy qua stdio. Không có route nào trên proxy cho phép gọi tool agent từ internet.

## Xử lý sự cố

| Hiện tượng | Nguyên nhân / cách xử lý |
|---|---|
| `cloudflared not found` | `brew install cloudflared`, hoặc chỉ định `--cloudflared /path`, hoặc dùng `--no-tunnel` |
| `EADDRINUSE` | Cổng `--port` đang bị dùng, chọn cổng khác |
| Góp ý báo *"Link thiếu mã chia sẻ"* | Trình duyệt này chưa từng mở URL có `?sp=…` (ví dụ: link mở trong app chat có kho cookie riêng, hoặc URL đã mất `?sp=` sau khi chuyển trang). Mở lại đúng share link trong trình duyệt này. Token đã đổi thì cần link mới |
| Link cũ không mở được | Quick Tunnel đổi URL mỗi lần chạy lại. Góp ý không mất vì được lưu theo đường dẫn, chỉ cần gửi link mới |
| Trang có `<Suspense>` hiện ra một lần thay vì từng phần | Cloudflare Quick Tunnel tự buffer HTML (tunnel thẳng không qua proxy cũng vậy). Ở local thì streaming vẫn bình thường |
| Ảnh `/next.svg` của template Next lỗi 404 khi có `basePath` | Lỗi của template (đường dẫn ảnh thiếu `basePath`), không liên quan shared-pro |
| Pin không hiện, thẻ báo *"Không còn thấy phần tử"* | Phần tử đã bị xóa hoặc đổi cả vị trí lẫn nội dung, nên cả selector lẫn text đều không còn khớp. Nội dung góp ý và ảnh chụp vẫn còn trong thẻ |
| `quick tunnel provisioning failed with status 429` | Cloudflare giới hạn số Quick Tunnel tạo liên tiếp. Đợi vài phút, hoặc dùng named tunnel |
| Ảnh chụp thiếu hình, hoặc header cố định bị lệch | Ảnh được dựng lại từ DOM chứ không phải chụp pixel: ảnh từ tên miền khác không cho CORS sẽ trống, header `position: fixed` có thể lệch khi trang đã cuộn |
| Tính năng mới không chạy sau khi cập nhật | Khởi động lại `shared-pro` (và MCP). Widget tự lấy bản mới nhưng server đang chạy vẫn là code cũ |
| Phím **C** không có tác dụng | Chỉ hoạt động khi bảng góp ý đang mở, để không cướp phím tắt của app |

## Phát triển

```bash
npm test        # node:test, không cần framework
npm run build   # src/*.ts → dist/*.js bằng bộ strip type có sẵn của Node
```

```
src/cli.ts       CLI: start | mcp
src/server.ts    reverse proxy (node:http + node:net), chèn widget, WebSocket
src/api.ts       /__sp/api: validate, share token, CSRF
src/store.ts     node:sqlite (WAL), dùng chung cho proxy và MCP
src/tunnel.ts    spawn cloudflared, chờ URL + kết nối sẵn sàng
src/mcp.ts       4 tool MCP, bọc nội dung untrusted
widget/widget.js widget góp ý (JS thuần, ES module, phục vụ nguyên bản)
scripts/build.ts build ra dist/ (không dependency)
test/            proxy, api, store, tunnel (cloudflared giả), widget (happy-dom), mcp (in-memory + stdio), build
```

Dependency khi chạy chỉ có `@modelcontextprotocol/sdk`, `zod` và `modern-screenshot` (bản ESM tự chứa, chỉ được tải khi có người góp ý). Proxy, SQLite, test và build đều dùng thứ có sẵn trong Node. Thiết kế và lộ trình chi tiết xem [PLAN.md](PLAN.md).

## Chưa làm

- Publish lên npm (gói đã sẵn sàng, chỉ cần bỏ `"private": true` rồi `npm publish`).
- Khoanh vùng bằng thao tác chạm trên điện thoại.
- Ảnh chụp chính xác header `position: fixed` khi trang đã cuộn.
- Kiểm tra channel trong một phiên Claude Code thật. Báo sự kiện khi người review mở lại một thread.
