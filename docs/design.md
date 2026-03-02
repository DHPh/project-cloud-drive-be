# Thiết kế backend

DRIVE-01, TRASH-01 và SHARE-01 dùng các route và DTO trong [hợp đồng HTTP](contracts/README.md).

## Phiên và quyền

Cookie phiên là giá trị ngẫu nhiên. PostgreSQL lưu SHA-256 của giá trị ấy cùng hạn dùng. API kiểm tra thời hạn trên từng request, yêu cầu `Origin` khớp `APP_ORIGIN` khi ghi và yêu cầu cookie `Secure` ở cấu hình production. Lượt tải và duyệt chỉ đọc tài nguyên thuộc chủ sở hữu hiện tại. JSON trả theo DTO và phản hồi tệp dùng `Cache-Control: private, no-store`.

## Vòng đời upload

API kiểm tra multipart và quyền thư mục, tăng `used_bytes` có điều kiện rồi tạo bản ghi `pending` trong cùng transaction. Khoá PostgreSQL theo ID upload giữ độc quyền trong lúc ghi object và chuyển bản ghi thành `ready`. Chỉ tệp `ready` xuất hiện trong danh sách và được tải xuống. Lần tải xuống lấy object từ bucket private qua backend và stream với tên UTF-8.

Lỗi ghi object chuyển bản ghi sang `cleanup` nếu PostgreSQL còn sẵn sàng. Nếu app dừng hoặc DB gián đoạn trước khi hoàn tất, bản ghi `pending` vẫn giữ object key và quota để đối soát. Tác vụ nền hoặc `npm run storage:reconcile` dọn batch tồn đọng sau khoảng `UPLOAD_RECOVERY_AGE_SECONDS` (mặc định 300 giây). Tác vụ giữ thông tin để thử lại khi storage lỗi, và giảm quota cùng lúc xóa bản ghi sau khi storage xác nhận xóa. Tệp đã ở trạng thái `ready` được giữ lại khi mất phản hồi giữa client và API.

## Thùng rác từng tệp

Migration `AddFileTrash1763683200000` bổ sung `trashed_at` cho tệp đã ghi xong. Drive, tìm kiếm, đổi tên và tải xuống chỉ sử dụng tệp có `trashed_at` bằng `NULL`. Danh sách thùng rác áp quyền chủ sở hữu trước khi đếm và phân trang.

Đưa vào thùng rác và khôi phục đổi `trashed_at` trong transaction, giữ ID, object key và quota. Đích khôi phục được xác định theo [quyền thư mục](#kế-thừa-quyền-thư-mục). Gọi lặp thao tác giữ trạng thái đã đạt. Tác vụ đối soát upload chỉ xử lý tệp chưa `ready`, nên tệp đang ở thùng rác vẫn giữ nguyên nội dung.

## Chia sẻ từng tệp

Mỗi quyền gắn một tài khoản nhận với một tệp. Chủ tệp cấp và thu hồi quyền theo tài khoản. Thông tin và luồng tải xuống chỉ đọc tệp đang hoạt động khi người dùng là chủ tệp hoặc có quyền còn hạn. Danh sách tệp nhận được áp cùng điều kiện trước khi đếm và phân trang.

Backend lưu mốc hết hạn tuyệt đối. Hạn bỏ trống khi cấp mới được tính theo một tháng lịch Việt Nam. Quyền tự hết hiệu lực tại mốc đã lưu khi backend kiểm tra request. Cấp quyền, thu hồi và đưa vào Thùng rác đồng bộ qua khóa trên bản ghi tệp. Đưa vào Thùng rác thu hồi toàn bộ quyền trong cùng giao dịch với đổi trạng thái. Restore giữ tệp riêng tư.

## Quản lý thư mục

DRIVE-02 giữ tên chính xác phân biệt hoa thường sau khi cắt khoảng trắng hai đầu. Migration thêm unique index theo chủ, thư mục cha và tên. `NULLS NOT DISTINCT` kiểm tra cả Drive gốc. Nếu snapshot có tên trùng chính xác, migration trả lỗi và quay lui theo transaction để có thể xử lý dữ liệu trước khi chạy lại.

Thao tác tạo và cập nhật cây thư mục lấy khóa transaction theo chủ sở hữu trước khi kiểm tra cha, tổ tiên và tên ở vị trí đích. Khóa cùng chủ tuần tự hóa các thao tác di chuyển đối nghịch. Backend kiểm tra đích cùng chủ và chặn vòng lặp. Đổi tên và di chuyển chỉ ghi bản ghi thư mục, giữ ID, object, quota và quyền chia sẻ tệp.

## Kế thừa quyền thư mục

Quyền xem được tính từ quyền trực tiếp và các quyền thư mục còn hạn trên chuỗi tổ tiên hiện tại. Phiên người nhận chỉ duyệt được các phần thuộc cây đã cấp quyền. Breadcrumb và cha của thư mục trong phản hồi được giới hạn theo phạm vi đó. Drive gốc chỉ thuộc chủ. Các thao tác ghi giữ kiểm tra quyền sở hữu.

Khôi phục tệp kiểm tra quyền còn hạn trên thư mục gốc và các thư mục cha. Nếu vị trí đó đang chia sẻ, cập nhật đích về Drive gốc để tệp trở lại riêng tư. Cấp/thu hồi quyền thư mục, đổi cây và khôi phục dùng chung khóa giao dịch theo chủ sở hữu. File ID, object key và quota giữ nguyên.

Triển khai migration, API rồi frontend tương thích theo thứ tự. Khi đã có dữ liệu `folder_shares`, giữ quy tắc khôi phục riêng tư của API `0.5.0` trong phương án quay lui.

## Migration và kiểm thử

Chạy migration một lần trước khi khởi động bản phát hành. Seed chỉ dành cho môi trường phát triển và tạo fixture tổng hợp trong PostgreSQL cùng object tương ứng trong bucket. Xem [cách chạy kiểm thử và quy trình phát hành](verification.md).

Sau khi đã có tệp vào thùng rác, ưu tiên bản sửa vẫn hỗ trợ `trashed_at`. Bản API cũ có thể hiển thị lại tệp đã đưa vào thùng rác. Khi phải quay lui, dừng truy cập và dùng phương án đã diễn tập cho snapshot PostgreSQL và MinIO trước khi mở lại dịch vụ.
