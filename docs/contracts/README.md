# Hợp đồng API

Backend duy trì [OpenAPI](openapi.yaml) làm nguồn chuẩn cho route, request, response, quyền và mã lỗi. Frontend đồng bộ bản schema vào repo của mình rồi sinh kiểu dữ liệu từ bản đã đồng bộ. Mỗi thay đổi hợp đồng ghi rõ cách đồng bộ và hướng chuyển đổi nếu thay đổi ảnh hưởng client hiện có.

DRIVE-01 gồm đăng nhập, đọc phiên, đăng xuất, danh sách thư mục, upload, sửa metadata và download. JSON thành công có `success: true` và `data`, kèm `pagination` khi phân trang. JSON lỗi có `success: false`, `error.code` và `error.message`. Download trả dữ liệu nhị phân.

OpenAPI `0.2.0` bổ sung TRASH-01 cho từng tệp. Chủ sở hữu dùng `GET /trash` để liệt kê, `POST /files/{fileId}/trash` để đưa vào thùng rác và `POST /files/{fileId}/restore` để khôi phục. Hai thao tác ghi trả `id` và `trashedAt`, giá trị `null` biểu thị tệp đang hoạt động. Gọi lặp giữ trạng thái cuối đã đạt. Tệp trong thùng rác vắng khỏi danh sách Drive, tìm kiếm, đổi tên và tải xuống. Giữ nguyên ID, thư mục, object và quota qua cả hai chiều.

API dùng base path `/api/v1` và cookie phiên cùng origin. Request ghi cần `Origin` khớp `APP_ORIGIN`. Phản hồi riêng tư, kể cả lỗi, dùng `Cache-Control: private, no-store`. Tham khảo repo backend để cấu hình origin và kiểm thử. [Cách chạy](../../README.md) · [Kiểm chứng](../verification.md)

OpenAPI `0.3.0` bổ sung SHARE-01. Chủ tệp quản lý quyền ở `/files/{fileId}/shares`. Người được cấp quyền còn hạn thấy tệp trong `/shared-with-me` và có thể đọc thông tin, tải xuống. `expiresAt` được trả về với thời điểm hết hạn thực tế. Bỏ trống khi cấp mới mặc định một tháng theo lịch Việt Nam. Gọi lại khi quyền đang hoạt động giữ thời hạn hiện tại nếu vẫn bỏ trống. Thu hồi quyền hoặc đưa tệp vào Thùng rác cắt quyền ngay. Khôi phục tệp về trạng thái riêng tư.

Khi mất kết nối trước khi nhận phản hồi upload, làm mới danh sách để đối soát kết quả trước khi gửi lại. Khi đổi API, cập nhật schema và kiểm tra request, response và dữ liệu thật trong môi trường tổng hợp.
