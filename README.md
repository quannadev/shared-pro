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

- **Một lệnh**: chạy proxy, tự mở Cloudflare Quick Tunnel, in ra share link đầy đủ.
- **Góp ý trực quan**: chọn phần tử trên trang, pin đánh số đặt đúng điểm click, có thread trả lời. Chỉ AI Agent được đánh dấu xong, người review có thể mở lại.
- **Realtime**: góp ý của người khác và reply của AI hiện ra sau khoảng 0,6 giây (đo thật qua tunnel), không mất nội dung đang gõ.
- **Cho AI Agent**: 4 tool MCP để liệt kê, đọc chi tiết (selector, text, HTML của phần tử), trả lời và resolve. Reply của agent có badge 🤖.
- **Không đụng app**: widget nằm trong Shadow DOM, HMR của Vite/Next vẫn chạy qua tunnel, streaming SSR không bị buffer ở proxy.
- **Có kiểm soát truy cập**: share token, chống XSS, chống CSRF, chặn reviewer giả danh agent, bọc nội dung góp ý để giảm rủi ro prompt injection.

Đã kiểm tra với Next.js 16 (có `basePath`) và Vite 8.

## Yêu cầu

- Node.js **≥ 22.18** (chạy TypeScript trực tiếp và dùng `node:sqlite` có sẵn, không cần bước build)
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/): `brew install cloudflared`

## Cài đặt

```bash
git clone https://github.com/quannadev/shared-pro.git
cd shared-pro
npm install
npm link        # tạo lệnh `shared-pro` toàn cục
```

> Chưa publish lên npm. Node không chạy file `.ts` nằm trong `node_modules`, nên `npx shared-pro` hoặc `npm install shared-pro` sẽ chưa dùng được. `npm link` thì được vì nó trỏ symlink về thư mục clone. Không muốn link thì chạy thẳng `node /đường/dẫn/shared-pro/src/cli.ts …`.

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

## Hướng dẫn cho người review

1. Mở share link **ngay trong trình duyệt sẽ dùng để góp ý** (Safari, Chrome…). Trình duyệt nhận cookie từ token trong link. `?sp=…` vẫn nằm trên thanh địa chỉ, nên copy URL hoặc bấm "Mở trong Safari" từ Zalo/Messenger vẫn mang theo mã.
2. Bấm nút **💬** ở góc phải dưới để mở bảng góp ý.
3. Bấm **+ Thêm góp ý** (hoặc phím **C** khi bảng đang mở). Rê chuột để thấy phần tử được viền xanh, rồi click vào phần tử muốn góp ý. Trong chế độ này click không kích hoạt app: link không chuyển trang, nút không chạy.
4. Nhập tên (chỉ hỏi lần đầu) và nội dung, gửi bằng **⌘/Ctrl + Enter** hoặc nút **Gửi**.
5. Mỗi góp ý có một pin số trên trang. Click pin hoặc thẻ trong bảng để cuộn tới đúng phần tử.
6. Mỗi thread có ô **Trả lời**. Tab **Đang mở / Đã xong** để lọc.
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
claude mcp add shared-pro -- node /đường/dẫn/shared-pro/src/cli.ts mcp --dir "$PWD"
```

### Cursor, Claude Desktop và client MCP khác

```json
{
  "mcpServers": {
    "shared-pro": {
      "command": "node",
      "args": ["/đường/dẫn/shared-pro/src/cli.ts", "mcp", "--dir", "/đường/dẫn/project-của-app"]
    }
  }
}
```

### Các tool

| Tool | Tham số | Dùng để |
|---|---|---|
| `list_comments` | `status` (`open` mặc định / `resolved`), `url?` | Liệt kê thread: id, trang, phần tử, nội dung |
| `get_comment` | `id` | Chi tiết: selector, text, HTML của phần tử, vị trí click, viewport, các reply |
| `reply_comment` | `id`, `body` | Trả lời hoặc hỏi lại người review (hiển thị với 🤖) |
| `resolve_comment` | `id`, `note?` | Đánh dấu xong. Đây là cách **duy nhất** để resolve: API từ trình duyệt trả `403`. `note` được đăng thành reply để người review biết đã đổi gì |

Vòng làm việc thường gặp: `list_comments` → `get_comment` → tìm phần tử trong code (theo text hoặc HTML) → sửa → HMR tự reload trang của người review → `resolve_comment` với ghi chú ngắn. Người review thấy ✓ và ghi chú gần như ngay lập tức.

Proxy và MCP là hai process riêng nhưng dùng chung file SQLite (chế độ WAL), nên agent đọc được góp ý kể cả khi proxy đã tắt.

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

- **Đổi token** (thu hồi mọi link đã gửi): xóa `.shared-pro/token` rồi chạy lại.
- **Xóa sạch góp ý**: xóa `.shared-pro/comments.db*`.

## Bảo mật

Share link là **URL công khai trỏ vào máy dev của bạn**. Chỉ gửi cho người tin cậy.

- **Share token**: không có cookie token thì API góp ý trả `401`. App vẫn xem được qua link (giống như khi chạy `cloudflared` thường), chỉ không xem hay viết được góp ý. Cookie đặt `HttpOnly; Secure; SameSite=Lax`, so sánh token bằng `timingSafeEqual`. Token **vẫn hiện trên thanh địa chỉ** (để link copy lại vẫn dùng được), nên đừng gửi ảnh chụp có thanh địa chỉ cho người ngoài. Lộ token thì xóa `.shared-pro/token` để đổi mã.
- **Prompt injection**: góp ý là dữ liệu do người ngoài nhập và AI sẽ đọc. MCP bọc mọi nội dung đến từ reviewer trong `<untrusted_comment>`, vô hiệu hóa mọi cách thoát khỏi thẻ này, và nhắc agent chỉ coi đây là mô tả thay đổi UI, không phải lệnh. Hãy **giữ chế độ xác nhận tool của agent**, và đừng dùng `--public` khi đã nối agent.
- **Giả danh agent**: badge 🤖 dựa vào cột `by_agent`, chỉ MCP ghi được. API bỏ qua field này.
- **XSS**: widget hiển thị nội dung góp ý dạng text (`textContent`), không bao giờ dạng HTML.
- **CSRF**: API bắt buộc `content-type: application/json` (sai thì trả `415`) và cookie `SameSite=Lax`. Body lớn hơn 64KB trả `413`.
- **Bảo vệ dev server**: proxy đổi `Origin` sang địa chỉ app chỉ khi `Origin` trùng `Host`. Nhờ vậy HMR của Next chạy qua tunnel, còn trang lạ gọi `localhost:3100` vẫn bị Next chặn như cũ.
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
| Pin không hiện, thẻ báo *"Không còn thấy phần tử"* | DOM đã đổi nên selector không còn khớp. Nội dung góp ý và text của phần tử vẫn còn trong thẻ |
| Phím **C** không có tác dụng | Chỉ hoạt động khi bảng góp ý đang mở, để không cướp phím tắt của app |

## Phát triển

```bash
npm test     # node:test, không cần framework
```

```
src/cli.ts       CLI: start | mcp
src/server.ts    reverse proxy (node:http + node:net), chèn widget, WebSocket
src/api.ts       /__sp/api: validate, share token, CSRF
src/store.ts     node:sqlite (WAL), dùng chung cho proxy và MCP
src/tunnel.ts    spawn cloudflared, chờ URL + kết nối sẵn sàng
src/mcp.ts       4 tool MCP, bọc nội dung untrusted
widget/widget.js widget góp ý (JS thuần, ES module, phục vụ nguyên bản)
test/            proxy, api, store, tunnel (cloudflared giả), widget (happy-dom), mcp (in-memory + stdio)
```

Dependency khi chạy chỉ có `@modelcontextprotocol/sdk` và `zod`. Proxy, SQLite, test và chạy TypeScript đều dùng thứ có sẵn trong Node. Thiết kế và lộ trình chi tiết xem [PLAN.md](PLAN.md).

## Chưa làm

- Chụp ảnh màn hình khi góp ý (để agent nhìn thấy).
- Khoanh vùng tự do bằng cách kéo chuột, thay vì chỉ chọn một phần tử.
- Tìm lại phần tử theo text khi selector không còn khớp.
- Named tunnel (URL cố định).
- Build ra JS để publish lên npm (`npx shared-pro`).
