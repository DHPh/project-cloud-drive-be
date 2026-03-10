# Hợp đồng API

Backend duy trì [OpenAPI](openapi.yaml) làm nguồn chuẩn cho route, request, response, quyền và mã lỗi. Frontend đồng bộ bản schema vào repo của mình rồi sinh kiểu dữ liệu từ bản đã đồng bộ. Mỗi thay đổi hợp đồng ghi rõ cách đồng bộ và hướng chuyển đổi nếu thay đổi ảnh hưởng client hiện có.

## Quy ước HTTP

API dùng base path `/api/v1` và cookie phiên cùng origin. Request ghi cần `Origin` khớp `APP_ORIGIN`. Phản hồi riêng tư, kể cả lỗi, dùng `Cache-Control: private, no-store`. JSON thành công có `success: true` và `data`, kèm `pagination` khi phân trang. JSON lỗi có `success: false`, `error.code` và `error.message`. [Cách chạy](../../README.md) · [Kiểm chứng](../verification.md)

## DRIVE-01

OpenAPI `0.1.0` giới thiệu các thao tác sau.

- `POST /auth/login` cấp cookie và trả thông tin tài khoản. `GET /auth/me` đọc phiên hiện tại. `POST /auth/logout` kết thúc phiên và xóa cookie. API cần xác thực trả `401` khi phiên thiếu hoặc hết hạn.
- `GET /folders/{folderId}/contents` nhận `root` để mở Drive gốc, lọc tên con trực tiếp bằng `q` rồi phân trang theo `page` và `limit`.
- `POST /files` nhận một tệp multipart và `folderId` tùy chọn, trả `201` cùng metadata. Vượt quota trả `409 STORAGE_QUOTA_EXCEEDED`, tệp vượt giới hạn upload trả `413 FILE_TOO_LARGE`.
- `PATCH /files/{fileId}` nhận các trường metadata cần cập nhật. Bỏ trường giữ giá trị hiện có, `description: null` và `tags: []` xóa giá trị tương ứng. `GET /files/{fileId}/download` stream dữ liệu nhị phân với tên UTF-8 trong `Content-Disposition`.

Khi mất kết nối trước lúc nhận kết quả upload, làm mới danh sách để đối soát trước khi gửi lại. Khi đổi API, cập nhật schema và kiểm tra request, response và dữ liệu thật trong môi trường tổng hợp.

## TRASH-01

OpenAPI `0.2.0` bổ sung TRASH-01 cho từng tệp. Chủ sở hữu dùng `GET /trash` để liệt kê, `POST /files/{fileId}/trash` để đưa vào thùng rác và `POST /files/{fileId}/restore` để khôi phục. `trashedAt: null` biểu thị tệp đang hoạt động. Gọi lặp giữ trạng thái cuối đã đạt. Tệp trong thùng rác vắng khỏi danh sách Drive, tìm kiếm, đổi tên và tải xuống. Giữ nguyên ID, object và quota qua cả hai chiều.

Hai thao tác đổi trạng thái trả `200` cùng trạng thái thực tế. Tệp khác chủ trả `404`. Lấy `folderId` thực tế sau khi khôi phục và dùng `originalName` trong API `0.6.0` để báo kết quả. [Quy tắc đích và tên](#trash-02)

## SHARE-01

OpenAPI `0.3.0` bổ sung `GET` và `PUT /files/{fileId}/shares` cho chủ tệp, cùng `DELETE /files/{fileId}/shares/{recipientId}` để thu hồi. `PUT` cấp hoặc cập nhật một quyền theo email. Phản hồi trả `expiresAt` thực tế và trạng thái hiệu lực. Bỏ trống khi cấp mới dùng mặc định một tháng theo lịch Việt Nam. Gọi lại khi quyền còn hạn giữ hạn hiện tại nếu vẫn bỏ trống.

Người nhận thấy grant trực tiếp còn hạn trong `GET /shared-with-me` và đọc được `GET /files/{fileId}` cùng luồng tải xuống. Khi quyền hết hạn hoặc bị thu hồi, quyền trực tiếp kết thúc. Quyền qua thư mục được xét riêng từ bản [`0.5.0`](#share-02). Đưa tệp vào Thùng rác thu hồi quyền trực tiếp và khóa đọc tệp tới khi khôi phục.

## DRIVE-02

OpenAPI `0.4.0` bổ sung DRIVE-02. `POST /folders` tạo thư mục. `PATCH /folders/{folderId}` đổi tên hoặc di chuyển, với `parentId: null` là Drive gốc. `GET /folders/{folderId}/contents?type=folders` lọc thư mục trước khi đếm và phân trang. API trả `409 FOLDER_NAME_CONFLICT` khi tên trùng chính xác trong cùng vị trí và `409 INVALID_FOLDER_MOVE` khi đích là chính thư mục hoặc một thư mục con.

Tạo trả `201`, cập nhật trả `200` cùng ID thư mục. Bỏ trường trong yêu cầu `PATCH` giữ giá trị hiện tại. Tài nguyên nguồn hoặc đích ngoài quyền của chủ trả `404`.

## SHARE-02

OpenAPI `0.5.0` bổ sung SHARE-02. Chủ sở hữu dùng `/folders/{folderId}/shares` để quản lý quyền thư mục. Người nhận thấy thư mục nhận trực tiếp trong `/shared-folders`, rồi duyệt nội dung với `data.access` là `viewer`. Quyền xem/tải kế thừa theo vị trí hiện tại. `PATCH /files/{fileId}` có thể đổi `folderId`. Phản hồi Thùng rác và khôi phục trả `folderId` thực tế để UI hiển thị đúng đích. Khôi phục về Drive gốc khi thư mục cũ hoặc một thư mục cha đang chia sẻ.

`GET` và `PUT` tại `/folders/{folderId}/shares` dùng cùng quy tắc hạn với grant tệp. `DELETE /folders/{folderId}/shares/{recipientId}` thu hồi grant thư mục. API duyệt trả breadcrumb trong phạm vi xem và `parentId: null` tại thư mục cao nhất có quyền. Khi di chuyển tệp, `folderId: null` chọn Drive gốc.

## TRASH-02

OpenAPI `0.6.0` bổ sung TRASH-02. `POST /folders/{folderId}/trash` và `POST /folders/{folderId}/restore` xử lý cả lần xóa và trả tên, cha cùng thời điểm xóa thực tế. `GET /trash?includeFolders=true` phân trang chung tệp xóa riêng và thư mục gốc của mỗi cây đã xóa. `GET /trash` mặc định giữ danh sách tệp xóa riêng cho client hiện có. Phản hồi thao tác tệp bổ sung `originalName`. Khi trùng tên lúc khôi phục, API trả tên có hậu tố ` - khôi phục`, thêm số khi cần. Triển khai migration và backend `0.6.0` trước frontend dùng hợp đồng này.

## TRASH-03

OpenAPI `0.7.0` bổ sung xóa vĩnh viễn theo lần xóa. `GET /trash` trả `trashEventId`, `deleteAfter`, `purgeStatus` và `data.summary` cho cả tài khoản. `POST /trash/{kind}/{itemId}/purge` nhận `trashEventId`. `POST /trash/empty` nhận `requestId` do client tạo cho một lần xác nhận. Cả hai trả `202` với số mục đã nhận để xử lý. Gửi lại cùng lần xóa hoặc ID yêu cầu giữ kết quả ban đầu. Client mới gửi `trashEventId` khi khôi phục. API trả `409 DELETE_IN_PROGRESS` cho mục đang dọn và `409 STALE_TRASH_EVENT` cho lần xóa đã thay đổi. Xem thứ tự nâng cấp trong [thiết kế backend](../design.md#xóa-vĩnh-viễn-theo-lần-đưa-vào-thùng-rác).

`parentId` của thư mục hoặc `folderId` của tệp trong phản hồi khôi phục là đích thực tế. Giá trị `null` trỏ về Drive gốc. Hồi đáp cho thư mục dùng `name` và cho tệp dùng `originalName`. Danh sách hỗn hợp phân loại bằng `kind` để frontend chọn thao tác tương ứng.
