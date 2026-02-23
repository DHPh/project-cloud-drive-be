# Thiết kế backend

DRIVE-01 và TRASH-01 dùng các route và DTO trong [hợp đồng HTTP](contracts/README.md).

## Phiên và quyền

Cookie phiên là giá trị ngẫu nhiên. PostgreSQL lưu SHA-256 của giá trị ấy cùng hạn dùng. API kiểm tra thời hạn trên từng request, yêu cầu `Origin` khớp `APP_ORIGIN` khi ghi và yêu cầu cookie `Secure` ở cấu hình production. Lượt tải và duyệt chỉ đọc tài nguyên thuộc chủ sở hữu hiện tại. JSON trả theo DTO và phản hồi tệp dùng `Cache-Control: private, no-store`.

## Vòng đời upload

API kiểm tra multipart và quyền thư mục, tăng `used_bytes` có điều kiện rồi tạo bản ghi `pending` trong cùng transaction. Khoá PostgreSQL theo ID upload giữ độc quyền trong lúc ghi object và chuyển bản ghi thành `ready`. Chỉ tệp `ready` xuất hiện trong danh sách và được tải xuống. Lần tải xuống lấy object từ bucket private qua backend và stream với tên UTF-8.

Lỗi ghi object chuyển bản ghi sang `cleanup` nếu PostgreSQL còn sẵn sàng. Nếu app dừng hoặc DB gián đoạn trước khi hoàn tất, bản ghi `pending` vẫn giữ object key và quota để đối soát. Tác vụ nền hoặc `npm run storage:reconcile` dọn batch tồn đọng sau khoảng `UPLOAD_RECOVERY_AGE_SECONDS` (mặc định 300 giây). Tác vụ giữ thông tin để thử lại khi storage lỗi, và giảm quota cùng lúc xóa bản ghi sau khi storage xác nhận xóa. Tệp đã ở trạng thái `ready` được giữ lại khi mất phản hồi giữa client và API.

## Thùng rác từng tệp

Migration `AddFileTrash1763683200000` bổ sung `trashed_at` cho tệp đã ghi xong. Drive, tìm kiếm, đổi tên và tải xuống chỉ sử dụng tệp có `trashed_at` bằng `NULL`. Danh sách thùng rác áp quyền chủ sở hữu trước khi đếm và phân trang.

Đưa vào thùng rác và khôi phục chỉ đổi `trashed_at` trong transaction, giữ ID, thư mục, object key và quota. Gọi lặp thao tác giữ trạng thái đã đạt. Tác vụ đối soát upload chỉ xử lý tệp chưa `ready`, nên tệp đang ở thùng rác vẫn giữ nguyên nội dung.

## Migration và kiểm thử

Chạy migration một lần trước khi khởi động bản phát hành. Seed chỉ dành cho môi trường phát triển và tạo fixture tổng hợp trong PostgreSQL cùng object tương ứng trong bucket. Xem [cách chạy kiểm thử và quy trình phát hành](verification.md).

Sau khi đã có tệp vào thùng rác, ưu tiên bản sửa vẫn hỗ trợ `trashed_at`. Bản API cũ có thể hiển thị lại tệp đã đưa vào thùng rác. Khi phải quay lui, dừng truy cập và dùng phương án đã diễn tập cho snapshot PostgreSQL và MinIO trước khi mở lại dịch vụ.
