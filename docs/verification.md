# Kiểm chứng backend

Từ repo backend, chạy `npm ci`, `npm run typecheck`, `npm run build` và `npm test`. Dùng [cấu hình local](../.env.example) và [lệnh dựng hạ tầng](../README.md#chạy-tại-máy) để kiểm thử với dữ liệu tổng hợp.

Đặt `BACKEND_TEST_DATABASE_URL` tới PostgreSQL thử nghiệm để bật kiểm thử HTTP và migration. Bộ kiểm thử tạo schema tạm, chạy baseline trên schema trống và dùng object adapter để kiểm tra lỗi giữa chừng cùng retry. Với MinIO thật, kiểm tra thêm nội dung tải xuống, tên Unicode và quota khi hai upload đồng thời.

| Phạm vi | Ca cần xác nhận khi thay đổi |
| --- | --- |
| Phiên và quyền | Dùng hai tài khoản tổng hợp để thử thiếu phiên, hết phiên, origin sai và quyền khác chủ. Kiểm tra header cache trên cả thành công và lỗi. |
| Hợp đồng | Đối chiếu phương thức, schema, phân trang và mã lỗi với [OpenAPI](contracts/openapi.yaml). Đồng bộ schema với frontend khi hành vi đổi. |
| PostgreSQL và MinIO | Đối soát metadata, object và quota khi upload thành công, chạm quota, hoặc storage lỗi rồi chạy đối soát lại. |
| TRASH-01 | Nâng cấp snapshot DRIVE-01, giữ ID/thư mục/object key/quota qua hai chiều và tải lại đúng byte. Kiểm tra quyền giữa hai tài khoản, yêu cầu lặp và việc ẩn tệp trong Drive, tìm kiếm, đổi tên và tải xuống. |
| SHARE-01 | Dùng chủ tệp, người nhận và tài khoản ngoài phạm vi đã biết. Kiểm tra danh sách, đọc và tải xuống trước/sau khi cấp, hết hạn và thu hồi. Kiểm tra tháng ngắn, yêu cầu lặp và thu hồi toàn bộ khi vào Thùng rác. |
| DRIVE-02 | Kiểm tra tạo, đổi tên, di chuyển và lọc thư mục trong danh sách. Dùng snapshot SHARE-01 và dữ liệu tổng hợp để xác minh trùng tên, quyền đích, thao tác di chuyển đối nghịch, ID và quyền tải xuống giữ nguyên. |
| SHARE-02 | Kiểm tra quyền đọc qua tổ tiên, giới hạn breadcrumb, quyền trực tiếp song song, hết hạn, thay đổi vị trí và khôi phục riêng tư. So sánh đích khôi phục, ID, quota và byte trên tệp mẫu. |
| TRASH-02 | Nâng cấp snapshot `0.5.0`, xác nhận danh sách tệp cũ và phân trang hỗn hợp, ẩn cả cây, thu hồi quyền, giữ mục đã xóa riêng, khôi phục riêng tư và đổi tên khi trùng. Đối soát trạng thái sau thao tác đồng thời, quota, object key và byte. |
| TRASH-03 | Nâng cấp snapshot `0.6.0`, kiểm tra hạn 720 giờ, quyền và ID lần xóa, phạm vi khi dọn cả cây hoặc toàn bộ, lỗi storage, lỗi ghi nhận của PostgreSQL, upload đang chạy và retry. Với MinIO thật, xác nhận object thuộc lần xóa đã biến mất và quota khớp với mục giữ lại. |
| DRIVE-03 | Nâng cấp snapshot `0.7.0`, thử mô tả thư mục nullable và cập nhật độc lập. Kiểm tra `access` trên GET chi tiết tệp và tóm tắt trên upload/PATCH. Thử biên code point Unicode, thẻ trùng chính xác và ghi bằng tài khoản chỉ xem. Giữ metadata sau đổi tên, di chuyển và khôi phục. Đối chiếu object và quota khi thay đổi mô tả hoặc thẻ. |
| Nâng cấp dữ liệu | Chạy migration trên DB trống và snapshot tổng hợp của schema trước thay đổi khi migration có ảnh hưởng tới dữ liệu hiện có. |

Ghi lệnh, kết quả thực tế, tác động API hoặc DB và phần còn chờ xác minh khi bàn giao. Khi release có migration, ghi SHA hoặc image, thứ tự migrate và deploy, kiểm tra sau deploy và phương án phục hồi PostgreSQL cùng object. Chỉ chia sẻ ảnh và log từ fixture tổng hợp.
