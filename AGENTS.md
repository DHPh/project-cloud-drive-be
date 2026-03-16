# Chỉ dẫn backend

- Đọc [thiết kế backend](docs/design.md) trước khi đổi quyền, quota, storage hoặc migration. Khi bộ quy tắc Cloud Drive cục bộ có sẵn trong workspace chứa hai repo, dùng chỉ mục của bộ đó để chọn quy tắc liên quan.
- Giữ [OpenAPI](docs/contracts/openapi.yaml) khớp route và DTO. Khi đổi hành vi, cập nhật hợp đồng và thông báo thay đổi cần đồng bộ cho frontend.
- Trong cùng mốc triển khai, cập nhật [thiết kế backend](docs/design.md) và ca [kiểm chứng](docs/verification.md) bị tác động. Khi tìm thấy mô tả cũ lệch code hoặc hợp đồng, đối chiếu và sửa trong mốc liên quan.
- Với upload hoặc xóa, ghi rõ điều gì xảy ra khi chỉ một trong hai hệ thống PostgreSQL và MinIO cập nhật thành công. Dùng fixture tổng hợp để kiểm tra HTTP, retry và trạng thái dữ liệu cuối. [Quy trình kiểm chứng](docs/verification.md)
