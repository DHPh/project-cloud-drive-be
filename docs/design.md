# Thiết kế backend

Drive, Thùng rác và chia sẻ dùng các route và DTO trong [hợp đồng HTTP](contracts/README.md).

## Phiên và quyền

Cookie phiên là giá trị ngẫu nhiên. PostgreSQL lưu SHA-256 của giá trị ấy cùng hạn dùng. API kiểm tra thời hạn trên từng request, yêu cầu `Origin` khớp `APP_ORIGIN` khi ghi và yêu cầu cookie `Secure` ở cấu hình production. Lượt tải và duyệt kiểm tra quyền chủ sở hữu hoặc quyền đọc chia sẻ đang hiệu lực. JSON trả theo DTO và phản hồi tệp dùng `Cache-Control: private, no-store`.

Cookie có `HttpOnly`, `SameSite=Lax` và `Path=/`. Đăng nhập cấp phiên mới và thu hồi phiên từ cookie gửi kèm trong cùng transaction. Đăng xuất xóa phiên tương ứng. [Thao tác phiên và mã lỗi](contracts/README.md#drive-01)

## Danh sách Drive

`root` biểu thị thư mục gốc của tài khoản. Các mục trực thuộc gốc có cột cha bằng `NULL`. Foreign key ghép ID thư mục và ID chủ sở hữu để giữ quan hệ tệp và thư mục con trong cùng cây. Truy vấn duyệt áp quyền và trạng thái trước khi lọc tên của con trực tiếp, đếm và phân trang. Danh sách sắp thư mục trước tệp, rồi theo tên chữ thường và ID. Dùng [đường biên SHARE-02](#kế-thừa-quyền-thư-mục) khi trả breadcrumb cho người nhận.

## Vòng đời upload

API kiểm tra multipart và quyền thư mục, tăng `used_bytes` có điều kiện rồi tạo bản ghi `pending` trong cùng transaction. Khoá PostgreSQL theo ID upload giữ độc quyền trong lúc ghi object và chuyển bản ghi thành `ready`. Danh sách và tải xuống cần tệp `ready` tại vị trí đang hoạt động. Lần tải xuống lấy object từ bucket private qua backend và stream với tên UTF-8. Đổi metadata cập nhật bản ghi tệp, giữ cùng object key và quota.

Lỗi ghi object chuyển bản ghi sang `cleanup` nếu PostgreSQL còn sẵn sàng. Nếu app dừng hoặc DB gián đoạn trước khi hoàn tất, bản ghi `pending` vẫn giữ object key và quota để đối soát. Tác vụ nền hoặc `npm run storage:reconcile` dọn batch tồn đọng sau khoảng `UPLOAD_RECOVERY_AGE_SECONDS` (mặc định 300 giây). Tác vụ giữ thông tin để thử lại khi storage lỗi, và giảm quota cùng lúc xóa bản ghi sau khi storage xác nhận xóa. Tệp đã ở trạng thái `ready` được giữ lại khi mất phản hồi giữa client và API.

## Thùng rác từng tệp

Migration `AddFileTrash1763683200000` bổ sung `trashed_at` cùng ràng buộc chỉ tệp `ready` có thể mang mốc xóa. Drive, tìm kiếm, đổi tên và tải xuống chỉ sử dụng tệp có `trashed_at` bằng `NULL` trong cây đang hoạt động. Danh sách Thùng rác áp quyền chủ sở hữu trước khi đếm và phân trang.

Đưa vào thùng rác và khôi phục đổi `trashed_at` trong transaction, giữ ID, object key và quota. Đích khôi phục được xác định theo [quyền thư mục](#kế-thừa-quyền-thư-mục). Gọi lặp thao tác giữ trạng thái đã đạt. Tác vụ đối soát upload chỉ xử lý tệp chưa `ready`, nên tệp đang ở thùng rác vẫn giữ nguyên nội dung.

## Thùng rác cả cây thư mục

Migration `AddFolderTrash1765238400000` bổ sung `trash_root_id` cho mọi thư mục cùng lần xóa và `trashed_at` trên thư mục gốc của lần xóa. Tệp trực thuộc thư mục trong Thùng rác bị ẩn theo trạng thái thư mục. Tệp và thư mục đã xóa riêng giữ mục Thùng rác riêng. Mọi quyền trực tiếp trong cây vừa xóa bị thu hồi trong cùng transaction. Đọc, tải, ghi, chia sẻ và liệt kê đều kiểm tra trạng thái trước khi lấy dữ liệu hoặc đếm kết quả.

Cây khôi phục về cha cũ nếu còn hoạt động và riêng tư, hoặc Drive gốc. Tệp xóa riêng dùng cùng quy tắc. Nếu đã có mục hoạt động cùng loại và tên chính xác ở đích, khôi phục với tên còn trống dùng hậu tố ` - khôi phục` rồi tăng số khi cần. Với tệp, hậu tố nằm trước phần mở rộng cuối. Kiểm tra trạng thái, đích và tên trong transaction dưới khóa cùng chủ. Trả tên và đích thực tế để giao diện dùng ngay sau thao tác.

Triển khai migration, API rồi frontend theo thứ tự. Frontend cũ tiếp tục nhận danh sách tệp xóa riêng khi gọi `GET /trash` theo hợp đồng cũ. Sau khi đã đưa thư mục vào Thùng rác, phương án quay lui cần API hiểu trạng thái này hoặc phục hồi đồng bộ PostgreSQL và MinIO trước khi mở lại dịch vụ. Migration từ chối quay lui schema khi vẫn còn thư mục ở Thùng rác. [Tương thích HTTP](contracts/README.md#trash-02)

## Xóa vĩnh viễn theo lần đưa vào Thùng rác

Migration `AddTrashPurge1765324800000` thêm `trash_event_id` và điền ID cho mọi mục Thùng rác hiện có. Khi nhận lệnh xóa vĩnh viễn, backend lấy khóa theo chủ, xác nhận ID lần xóa còn hiệu lực và ghi công việc vào `trash_purge_jobs`. Từ lúc giao dịch được ghi nhận, lần xóa đó mất khả năng khôi phục. Lệnh **Dọn Thùng rác** lưu ID yêu cầu theo chủ cùng kết quả của lần ghi nhận đầu trong `trash_empty_requests`. Mục con xóa riêng giữ ID, thời điểm xóa và quota khi cây cha bị dọn. Các liên kết cha tới thư mục đang được dọn được bỏ ở ranh giới của mục giữ lại.

Backend ghi mốc kích hoạt tự dọn vào `trash_retention_policy` khi khởi động lần đầu sau nâng cấp. Mỗi lần xóa có hạn sớm nhất bằng thời điểm muộn hơn giữa lúc vào Thùng rác và lúc kích hoạt, cộng 720 giờ. Bộ dọn định kỳ dùng cùng luồng ghi nhận với xóa tay. `trash_purge_files` giữ tiến độ từng tệp và lịch thử lại. Tiến trình xử lý giữ khóa theo tệp dùng chung với upload và cập nhật quota trong cùng giao dịch với xóa metadata sau khi MinIO xác nhận xóa. Tệp chưa hoàn tất upload được xử lý sau khi lượt ghi đang chạy giải phóng khóa. Bộ đối soát upload bỏ qua tệp đã có trong hàng đợi xóa vĩnh viễn.

Dừng backend cũ trước khi chạy migration, rồi lên backend mới và frontend dùng hợp đồng `0.7.0`. Backend cũ thiếu ID lần xóa khi ghi và thiếu kiểm tra hàng đợi khi khôi phục. Migration từ chối quay lui khi còn công việc chưa hoàn tất. Nếu cần quay lui dữ liệu đã xóa, dùng quy trình phục hồi PostgreSQL và MinIO đồng bộ đã diễn tập. Xác minh bucket đang dùng có thể xóa object trực tiếp. Backend giữ công việc và quota nếu storage chỉ trả về dấu đánh dấu xóa của bucket có versioning. [Hợp đồng API](contracts/README.md#trash-03) · [Kiểm chứng](verification.md)

## Chia sẻ từng tệp

Migration `AddFileShares1764201600000` tạo `file_shares` với khóa chính `(file_id, recipient_id)`. Chủ tệp cấp và thu hồi quyền theo tài khoản. Thông tin và luồng tải xuống kiểm tra tệp hoạt động và quyền của người dùng khi đọc. Danh sách quản lý của chủ có cả grant hết hạn, còn danh sách tệp nhận áp điều kiện hiệu lực của quyền trực tiếp trước khi đếm và phân trang.

Backend lưu mốc hết hạn tuyệt đối. Hạn bỏ trống khi cấp mới được tính theo một tháng lịch Việt Nam. Khi quyền còn hạn, yêu cầu lặp với hạn bỏ trống giữ mốc cũ. Kiểm tra quyền dùng giờ của câu lệnh PostgreSQL. Giao dịch cấp quyền, thu hồi và đưa tệp vào Thùng rác lấy khóa cây theo chủ trước khóa dòng tài nguyên. Đưa vào Thùng rác thu hồi quyền trực tiếp trong cùng giao dịch với đổi trạng thái. Đích khôi phục dùng [quy tắc riêng tư](#kế-thừa-quyền-thư-mục).

## Quản lý thư mục

DRIVE-02 giữ tên chính xác phân biệt hoa thường sau khi cắt khoảng trắng hai đầu. Unique index kiểm tra theo chủ, thư mục cha và tên của thư mục đang hoạt động. `NULLS NOT DISTINCT` kiểm tra cả Drive gốc. TRASH-02 cho phép dùng lại tên của thư mục đã xóa.

Thao tác tạo và cập nhật cây thư mục lấy khóa transaction theo chủ sở hữu trước khi kiểm tra cha, tổ tiên và tên ở vị trí đích. Khóa cùng chủ tuần tự hóa các thao tác di chuyển đối nghịch. Backend kiểm tra đích cùng chủ và chặn vòng lặp. Đổi tên và di chuyển chỉ ghi bản ghi thư mục, giữ ID, object, quota và quyền chia sẻ tệp.

Khi cập nhật tên và cha với cùng giá trị, trả lại thư mục hiện tại. Bộ chọn đích lấy `type=folders` để giới hạn tập đếm và phân trang. [Quy định HTTP](contracts/README.md#drive-02)

## Kế thừa quyền thư mục

Migration `AddFolderShares1765152000000` tạo `folder_shares` với khóa chính `(folder_id, recipient_id)` và truy vấn tổ tiên trong cùng cây chủ sở hữu. Quyền xem được tính từ grant trực tiếp và các grant thư mục còn hạn trên chuỗi tổ tiên hiện tại. Duyệt thư mục dùng cùng truy vấn cho quyền, breadcrumb, nội dung và số lượng. Ở đầu phạm vi xem, `parentId` là `null`. Danh sách nhận trực tiếp áp điều kiện hiệu lực theo từng loại tài nguyên. Drive gốc và các thao tác ghi cần quyền chủ sở hữu.

Khôi phục tệp kiểm tra quyền còn hạn trên thư mục gốc và các thư mục cha. Nếu vị trí đó đang chia sẻ, cập nhật đích về Drive gốc để tệp trở lại riêng tư. Cấp/thu hồi quyền thư mục, đổi cây và khôi phục dùng chung khóa giao dịch theo chủ sở hữu. File ID, object key và quota giữ nguyên.

## Migration và kiểm thử

Chạy migration một lần trước khi khởi động bản phát hành. Seed chỉ dành cho môi trường phát triển và tạo fixture tổng hợp trong PostgreSQL cùng object tương ứng trong bucket. Xem [cách chạy kiểm thử và quy trình phát hành](verification.md).

Sau khi đã có tệp vào thùng rác, ưu tiên bản sửa vẫn hỗ trợ `trashed_at`. Bản API cũ có thể hiển thị lại tệp đã đưa vào thùng rác. Khi phải quay lui, dừng truy cập và dùng phương án đã diễn tập cho snapshot PostgreSQL và MinIO trước khi mở lại dịch vụ.
