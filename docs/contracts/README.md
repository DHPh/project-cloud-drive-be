# Hợp đồng API

Backend duy trì [OpenAPI](openapi.yaml) làm nguồn chuẩn cho route, request, response, quyền và mã lỗi. Frontend đồng bộ bản schema vào repo của mình rồi sinh kiểu dữ liệu từ bản đã đồng bộ. Mỗi thay đổi hợp đồng ghi rõ cách đồng bộ và hướng chuyển đổi nếu thay đổi ảnh hưởng client hiện có.

DRIVE-01 gồm đăng nhập, đọc phiên, đăng xuất, danh sách thư mục, upload, sửa metadata và download. JSON thành công có `success: true` và `data`, kèm `pagination` khi phân trang. JSON lỗi có `success: false`, `error.code` và `error.message`. Download trả dữ liệu nhị phân.

API dùng base path `/api/v1` và cookie phiên cùng origin. Request ghi cần `Origin` khớp `APP_ORIGIN`. Phản hồi riêng tư, kể cả lỗi, dùng `Cache-Control: private, no-store`. Tham khảo repo backend để cấu hình origin và kiểm thử. [Cách chạy](../../README.md) · [Kiểm chứng](../verification.md)

Khi mất kết nối trước khi nhận phản hồi upload, làm mới danh sách để đối soát kết quả trước khi gửi lại. Khi đổi API, cập nhật schema và kiểm tra request, response và dữ liệu thật trong môi trường tổng hợp.
