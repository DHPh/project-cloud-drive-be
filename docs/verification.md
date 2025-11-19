# Kiểm chứng backend

Từ repo backend, chạy `npm ci`, `npm run typecheck`, `npm run build` và `npm test`. Dùng [cấu hình local](../.env.example) và [lệnh dựng hạ tầng](../README.md#chạy-tại-máy) để kiểm thử với dữ liệu tổng hợp.

Đặt `BACKEND_TEST_DATABASE_URL` tới PostgreSQL thử nghiệm để bật kiểm thử HTTP và migration. Bộ kiểm thử tạo schema tạm, chạy baseline trên schema trống và dùng object adapter để kiểm tra lỗi giữa chừng cùng retry. Với MinIO thật, kiểm tra thêm nội dung tải xuống, tên Unicode và quota khi hai upload đồng thời.

| Phạm vi | Ca cần xác nhận khi thay đổi |
| --- | --- |
| Phiên và quyền | Dùng hai tài khoản tổng hợp để thử thiếu phiên, hết phiên, origin sai và quyền khác chủ. Kiểm tra header cache trên cả thành công và lỗi. |
| Hợp đồng | Đối chiếu phương thức, schema, phân trang và mã lỗi với [OpenAPI](contracts/openapi.yaml). Đồng bộ schema với frontend khi hành vi đổi. |
| PostgreSQL và MinIO | Đối soát metadata, object và quota khi upload thành công, chạm quota, hoặc storage lỗi rồi chạy đối soát lại. |
| Nâng cấp dữ liệu | Chạy migration trên DB trống và snapshot tổng hợp của schema trước thay đổi khi migration có ảnh hưởng tới dữ liệu hiện có. |

Ghi lệnh, kết quả thực tế, tác động API hoặc DB và phần còn chờ xác minh khi bàn giao. Khi release có migration, ghi SHA hoặc image, thứ tự migrate và deploy, kiểm tra sau deploy và phương án phục hồi PostgreSQL cùng object. Chỉ chia sẻ ảnh và log từ fixture tổng hợp.
