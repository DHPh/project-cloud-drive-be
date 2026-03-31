# Hợp đồng API

Backend duy trì [OpenAPI](openapi.yaml) làm nguồn chuẩn cho route, request, response, quyền và mã lỗi. Frontend đồng bộ bản schema vào repo của mình rồi sinh kiểu dữ liệu từ bản đã đồng bộ. Mỗi thay đổi hợp đồng ghi rõ cách đồng bộ và hướng chuyển đổi nếu thay đổi ảnh hưởng client hiện có.

## Quy ước HTTP

API dùng base path `/api/v1` và cookie phiên cùng origin. Request ghi cần `Origin` khớp `APP_ORIGIN`. Phản hồi riêng tư, kể cả lỗi, dùng `Cache-Control: private, no-store`. JSON thành công có `success: true` và `data`, kèm `pagination` khi phân trang. JSON lỗi có `success: false`, `error.code` và `error.message`. [Cách chạy](../../README.md) · [Kiểm chứng](../verification.md)

## ACCOUNT-01 và ADMIN-01

OpenAPI `0.11.0` thêm `role` vào tài khoản trả bởi đăng nhập và đọc phiên. `GET /account` đọc hồ sơ và dung lượng. `PATCH /account` đổi tên hiển thị. `POST /account/password` đổi mật khẩu và yêu cầu đăng nhập lại. Mật khẩu mới dài 12–1.024 ký tự.

Admin dùng `/admin/invites` và `/admin/users/{userId}/reset-password` để phát hành token. Token chỉ xuất hiện khi phát hành. Gửi token bằng JSON tới `/auth/accept-invite` hoặc `/auth/reset-password`. API trả `404 ACCOUNT_LINK_NOT_FOUND`, `409 ACCOUNT_LINK_USED` hoặc `ACCOUNT_LINK_REVOKED`, và `410 ACCOUNT_LINK_EXPIRED` theo trạng thái link. Hai thao tác không cấp phiên. Lời mời hết hạn sau 24 giờ và link reset hết hạn sau 30 phút.

`/admin/users` liệt kê tài khoản, quota và trạng thái. `PATCH /admin/users/{userId}` nhận một hoặc nhiều trường `quotaBytes`, `disabled`, `role`. API trả `409 QUOTA_BELOW_USAGE` hoặc `LAST_ACTIVE_ADMIN` khi vi phạm ràng buộc. `/admin/audit` liệt kê thao tác thành công và không chứa token. Các API quản trị trả `403` cho người đã đăng nhập thiếu vai trò admin. [Thiết kế backend](../design.md#tài-khoản-và-quản-trị)

## ACCESS-01

OpenAPI `0.12.0` thêm `access: viewer | editor` vào `ShareGrant`. Chủ có thể gửi `access` khi cấp hoặc sửa quyền tệp/thư mục. Bỏ trường giữ mức quyền đang lưu. Quyền mới mặc định `viewer`. Đọc chi tiết tệp và nội dung thư mục trả `access: owner | editor | viewer` theo mức có hiệu lực cao nhất. Breadcrumb người nhận vẫn nằm trong phạm vi đọc.

Editor đổi tên, mô tả và thẻ tệp qua `PATCH /files/{fileId}`, chỉ đổi mô tả thư mục qua `PATCH /folders/{folderId}` và upload vào thư mục có quyền chỉnh sửa qua `POST /files`. Tệp upload thuộc chủ thư mục và dùng quota của chủ. Mất quyền khi backend kiểm tra lại trước khi hoàn tất trả `404`. Thao tác quản lý vị trí, Thùng rác, chia sẻ và công bố dành cho chủ. [Thiết kế backend](../design.md#quyền-chỉnh-sửa-được-chia-sẻ)

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

`parentId` của thư mục hoặc `folderId` của tệp trong phản hồi khôi phục là đích thực tế. Giá trị `null` trỏ về Drive gốc. Hồi đáp cho thư mục dùng `name` và cho tệp dùng `originalName`. Danh sách hỗn hợp phân loại bằng `kind` để frontend chọn thao tác tương ứng.

## TRASH-03

OpenAPI `0.7.0` bổ sung xóa vĩnh viễn theo lần xóa. `GET /trash` trả `trashEventId`, `deleteAfter`, `purgeStatus` và `data.summary` cho cả tài khoản. `POST /trash/{kind}/{itemId}/purge` nhận `trashEventId`. `POST /trash/empty` nhận `requestId` do client tạo cho một lần xác nhận. Cả hai trả `202` với số mục đã nhận để xử lý. Gửi lại cùng lần xóa hoặc ID yêu cầu giữ kết quả ban đầu. Client mới gửi `trashEventId` khi khôi phục. API trả `409 DELETE_IN_PROGRESS` cho mục đang dọn và `409 STALE_TRASH_EVENT` cho lần xóa đã thay đổi. Xem thứ tự nâng cấp trong [thiết kế backend](../design.md#xóa-vĩnh-viễn-theo-lần-đưa-vào-thùng-rác).

## DRIVE-03

OpenAPI `0.8.0` bổ sung `FileDetailResponse` cho `GET /files/{fileId}`. `data.access` trả `owner` hoặc `viewer` theo quyền đọc hiện hành. Upload và `PATCH /files/{fileId}` tiếp tục trả `FileSummary`. Chủ tệp dùng PATCH để cập nhật mô tả và thẻ. Truyền `description: null` hoặc `tags: []` để xóa giá trị tương ứng. Bỏ trường giữ dữ liệu hiện tại. Mô tả tối đa 2.000 code point Unicode. Mảng thẻ tối đa 20 giá trị, mỗi giá trị dài 1–64 code point và so trùng chính xác. Tài khoản ngoài phạm vi đọc hoặc ghi nhận `404`.

`POST /folders` và `PATCH /folders/{folderId}` nhận `description` tùy chọn, là văn bản thuần tối đa 2.000 code point Unicode hoặc `null`. Tạo khi bỏ trường hoặc gửi `null` sẽ lưu `null`. Khi PATCH, bỏ trường giữ dữ liệu hiện tại, gửi `null` để xóa mô tả. PATCH chỉ gửi trường mô tả là hợp lệ. `FolderSummary` trả trường nullable trong phản hồi tạo, cập nhật, nội dung thư mục và danh sách Thùng rác. Danh sách thư mục nhận chia sẻ và breadcrumb giữ hợp đồng riêng. Chạy migration, backend `0.8.0` rồi frontend đã đồng bộ schema theo thứ tự. [Thiết kế backend](../design.md#chi-tiết-tệp-và-mô-tả-thư-mục)

## DRIVE-04

OpenAPI `0.9.0` thêm `GET /drive/search` và `GET /drive/timeline`. Mỗi dòng kết quả có `item` và `breadcrumbs` tới thư mục cha. Tìm kiếm nhận `q`, `includeMetadata`, `type`, `sort`, `page` và `limit`. Dòng thời gian nhận `from`, `to`, `type`, `page` và `limit`. Hai route chỉ trả mục đang hoạt động thuộc chủ tài khoản. [Thiết kế backend](../design.md#tìm-toàn-drive-và-dòng-thời-gian)

## SHARE-03, PREVIEW-01 và ZIP-01

OpenAPI `0.10.0` thêm `GET /shared-by-me` cho quyền trực tiếp của chủ trên tệp và thư mục đang hoạt động. Bộ lọc loại và trạng thái áp trước khi phân trang. Dùng các thao tác cấp, gia hạn và thu hồi theo tài nguyên để quản lý một quyền. QR chứa cùng URL mở tài nguyên theo phiên. [Thiết kế danh sách quyền](../design.md#danh-sách-quyền-đã-chia-sẻ)

`GET /files/{fileId}/preview` trả JPEG, PNG, WebP, GIF, PDF hoặc UTF-8 văn bản thuần sau khi kiểm tra quyền hiện hành. Giới hạn 512 KiB cho văn bản, 10 MiB cho ảnh/PDF. Các mã `PREVIEW_UNSUPPORTED` và `PREVIEW_TOO_LARGE` cho giao diện giữ đường tải gốc.

`GET /folders/{folderId}/download` stream ZIP của cây hoạt động. Giới hạn 500 tệp, 500 thư mục và 100 MiB nội dung. Khi quyền đổi, dữ liệu thiếu hoặc luồng bị ngắt sau khi gửi header, kết nối kết thúc và giao diện xử lý như tải thất bại.

## BOARD-01

OpenAPI `0.13.0` thêm nhóm `/boards`, `/public/boards` và `/admin/boards`. Chủ tạo draft, đính kèm tệp của mình, bật công bố và tải bản gốc theo từng mục, rồi cập nhật thứ tự bằng danh sách ID đầy đủ. Khách xem board theo `publicId`, Khám phá chỉ liệt kê board discoverable. Preview công khai trả đoạn UTF-8 tối đa 4 KiB. Tải bản gốc yêu cầu mục đang công bố và đã được bật quyền tải. Khi vào Thùng rác, mục mất trạng thái công bố trong giao dịch. [Thiết kế backend](../design.md#board-công-khai-board-01)
