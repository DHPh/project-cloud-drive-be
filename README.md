# Backend

Backend dùng Express, TypeScript, TypeORM, PostgreSQL và MinIO. API sở hữu phiên, quyền, metadata, quota và vòng đời tệp.

- [Thiết kế backend](docs/design.md)
- [Hợp đồng API](docs/contracts/README.md)
- [Kiểm chứng và bàn giao](docs/verification.md)

## Chạy tại máy

Dùng Node.js 24 và Docker Compose. Từ thư mục repo backend, sao chép [mẫu cấu hình](.env.example) thành `.env` rồi chạy các lệnh dưới đây.

```text
npm ci
npm run infra:up
npm run db:setup
npm run dev
```

Mặc định API ở `http://127.0.0.1:3001`, frontend ở `http://127.0.0.1:3000`, PostgreSQL ở cổng `55432` và MinIO ở cổng `59000`. API phục vụ `/api/v1`. `GET /health` kiểm tra tiến trình và kết nối PostgreSQL.

`npm run db:setup` chạy migration và tạo fixture tổng hợp. Dùng `demo@example.test` hoặc `viewer@example.test` với mật khẩu mặc định `CloudDrive-Demo-2025!`. Có thể đặt `DEMO_PASSWORD` trước lần seed đầu tiên trên database thử nghiệm.

`npm run infra:down` dừng hạ tầng local và giữ các volume của project `cloud-drive-backend-dev`. Nếu cổng đã có dịch vụ dùng, chọn cổng khác trong `.env` và cập nhật `DATABASE_URL` hoặc `S3_ENDPOINT` tương ứng. Với cổng API, cập nhật địa chỉ backend trong cấu hình frontend.

## Chạy production

- Đặt `NODE_ENV=production` và `APP_ORIGIN` khớp chính xác origin HTTPS mà người dùng mở. Nếu frontend chạy Vercel, proxy `/api/v1` về địa chỉ HTTPS của backend và giữ header `Origin` từ trình duyệt cùng header phản hồi `Set-Cookie`. Trình duyệt gắn cookie phiên với hostname frontend. Môi trường preview dùng backend được cấu hình cho origin preview tương ứng.
- Cấp PostgreSQL và bucket MinIO private trước khi chạy app. Cấp các biến kết nối qua cấu hình triển khai riêng. Chạy `npm ci` và `npm run build` để chuẩn bị bản phát hành. Chạy `node dist/cli.js migrate` một lần với biến môi trường của release, rồi dùng `npm start` để phục vụ request. Dùng seed trên môi trường phát triển.
- Kiểm tra `/health` và thử đăng nhập, upload, tải xuống qua origin frontend sau rollout. Xác minh kích thước tệp được hỗ trợ qua proxy thật trước khi công bố cho người dùng. [Kiểm chứng và bàn giao](docs/verification.md)
